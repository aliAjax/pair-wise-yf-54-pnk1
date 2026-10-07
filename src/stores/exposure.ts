import { defineStore } from 'pinia';
import { useExhibitionStore } from './exhibition';

// 展线位置：展线上的一个展位，每个位置关联一台照度采集设备
export interface LinePosition {
  id: string;
  code: string;
  hall: string;
  deviceId: string;
}

// 照度读数：按 (设备, 时段) 去重；晚到更新原时段
export interface LightReading {
  id: string;
  deviceId: string;
  slot: string;        // 时段键 YYYY-MM-DDTHH
  lux: number;
  batchId: string;
  late: boolean;       // 晚到更新
  backfilled: boolean; // 历史无曝光记录时按当前读数回填起点
}

// 导入批次：失败后保留批次并重试
export interface ReadingBatch {
  id: string;
  readings: Array<{ deviceId: string; slot: string; lux: number }>;
  status: 'imported' | 'failed';
  attempts: number;
  error: string;
  createdAt: number;
}

// 布展方案：展品在展线上的位置与签字；超预算退回后签字失效
export interface InstallPlan {
  id: string;
  exhibitId: string;
  positionId: string;
  installedAt: number;
  signed: string[];
  invalidated: boolean;
}

// 库房周转区条目：容量满时先排队，未轮到撤展的停在线上
export interface TurnoverItem {
  exhibitId: string;
  reason: 'exposure-exceeded';
  queuedAt: number;
  status: 'turnover' | 'queued';
}

export interface ExposureInfo {
  exhibitId: string;
  deviceId: string;
  positionCode: string;
  cumulative: number;   // 累计曝光 lux·h
  budget: number;       // 曝光预算 lux·h
  ratio: number;        // 使用率
  exceeded: boolean;
  hasReadings: boolean;
  backfilled: boolean;
}

export interface ExposureRow extends ExposureInfo {
  code: string;
  name: string;
  signed: string[];
}

interface ExposureState {
  positions: LinePosition[];
  readings: LightReading[];
  batches: ReadingBatch[];
  plans: InstallPlan[];
  turnover: TurnoverItem[];
  budgets: Record<string, number>;
  turnoverCapacity: number;
  slotHours: number;
  failNextImport: boolean;
  seq: number;
}

const HOUR = 3600_000;
const STORAGE_KEY = 'yf54-exposure-state';

function toSlot(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

function buildSeed(): ExposureState {
  const positions: LinePosition[] = [
    { id: 'pos-1', code: 'A1-01', hall: 'A2 温湿展柜', deviceId: 'LT-A1' },
    { id: 'pos-2', code: 'A1-02', hall: 'A2 温湿展柜', deviceId: 'LT-A2' },
    { id: 'pos-3', code: 'B1-01', hall: 'B1 开放展区', deviceId: 'LT-B1' },
    { id: 'pos-4', code: 'B1-02', hall: 'B1 开放展区', deviceId: 'LT-B2' },
    { id: 'pos-5', code: 'B1-03', hall: 'B1 开放展区', deviceId: 'LT-B3' }
  ];

  // 布展方案：install 阶段的展品都在展线上，带布展签字
  const installExhibitIds = Array.from({ length: 10 }, (_, i) => `ex-${i + 9}`);
  const now = Date.now();
  const plans: InstallPlan[] = installExhibitIds.map((exhibitId, i) => ({
    id: `plan-${i + 1}`,
    exhibitId,
    positionId: positions[i % positions.length].id,
    installedAt: now - 48 * HOUR,
    signed: ['布展负责人', '保管员'],
    invalidated: false
  }));

  // 历史照度读数：过去 48 个时段；LT-B3 暂无读数（回填示例）
  const readings: LightReading[] = [];
  const devices = ['LT-A1', 'LT-A2', 'LT-B1', 'LT-B2'];
  let seq = 0;
  for (const deviceId of devices) {
    for (let h = 47; h >= 0; h--) {
      const slotIndex = 47 - h;
      const base = deviceId.startsWith('LT-A') ? 90 : 240;
      const wave = Math.sin(slotIndex / 3 + deviceId.length) * 30;
      const lux = Math.max(1, Math.round(base + wave + (slotIndex % 7) * 5));
      readings.push({
        id: `rd-${++seq}`,
        deviceId,
        slot: toSlot(now - h * HOUR),
        lux,
        batchId: 'seed',
        late: false,
        backfilled: false
      });
    }
  }

  // 预算：在当前累计曝光上留余量，初始不超预算
  const budgets: Record<string, number> = {};
  for (const plan of plans) {
    const pos = positions.find((p) => p.id === plan.positionId)!;
    const exposure = readings
      .filter((r) => r.deviceId === pos.deviceId && r.slot >= toSlot(plan.installedAt))
      .reduce((s, r) => s + r.lux, 0);
    const margin = pos.deviceId.startsWith('LT-A') ? 1800 : 3000;
    budgets[plan.exhibitId] = exposure + margin;
  }

  return {
    positions,
    readings,
    batches: [],
    plans,
    turnover: [],
    budgets,
    turnoverCapacity: 3,
    slotHours: 1,
    failNextImport: false,
    seq
  };
}

function load(): ExposureState {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return JSON.parse(saved) as ExposureState;
  const seed = buildSeed();
  // 首次加载即按规则清退一遍，保证状态与规则一致
  return seed;
}

function computeExposure(state: ExposureState, exhibitId: string): ExposureInfo | null {
  const plan = state.plans.find((p) => p.exhibitId === exhibitId && !p.invalidated);
  if (!plan) return null;
  const pos = state.positions.find((p) => p.id === plan.positionId);
  if (!pos) return null;
  const installSlot = toSlot(plan.installedAt);
  const deviceReadings = state.readings.filter((r) => r.deviceId === pos.deviceId && r.slot >= installSlot);
  const cumulative = deviceReadings.reduce((s, r) => s + r.lux * state.slotHours, 0);
  const budget = state.budgets[exhibitId] ?? 0;
  const backfilled = deviceReadings.some((r) => r.backfilled);
  return {
    exhibitId,
    deviceId: pos.deviceId,
    positionCode: pos.code,
    cumulative,
    budget,
    ratio: budget > 0 ? cumulative / budget : 0,
    exceeded: budget > 0 && cumulative > budget,
    hasReadings: deviceReadings.length > 0,
    backfilled
  };
}

export const useExposureStore = defineStore('exposure', {
  state: (): ExposureState => load(),
  getters: {
    exhibition() {
      return useExhibitionStore();
    },
    turnoverUsed(state): number {
      return state.turnover.filter((t) => t.status === 'turnover').length;
    },
    queuedCount(state): number {
      return state.turnover.filter((t) => t.status === 'queued').length;
    },
    failedBatches(state): ReadingBatch[] {
      return state.batches.filter((b) => b.status === 'failed');
    },
    exposureList(state): ExposureRow[] {
      const exhibition = useExhibitionStore();
      const rows: ExposureRow[] = [];
      for (const plan of state.plans) {
        if (plan.invalidated) continue;
        const info = computeExposure(state, plan.exhibitId);
        if (!info) continue;
        const exhibit = exhibition.exhibits.find((e) => e.id === plan.exhibitId);
        rows.push({ ...info, code: exhibit?.code ?? '', name: exhibit?.name ?? '', signed: plan.signed });
      }
      return rows;
    },
    exceededCount(state): number {
      // 已清退/排队的都因超预算；再加上仍在线上但已超预算的（排队展品会重复，需去重）
      const ids = new Set<string>();
      for (const t of state.turnover) ids.add(t.exhibitId);
      for (const plan of state.plans) {
        if (plan.invalidated) continue;
        const info = computeExposure(state, plan.exhibitId);
        if (info?.exceeded) ids.add(plan.exhibitId);
      }
      return ids.size;
    }
  },
  actions: {
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
    },
    exposureOf(exhibitId: string): ExposureInfo | null {
      return computeExposure(this.$state, exhibitId);
    },
    // 读数按 (设备, 时段) 去重合并；晚到更新原时段并标记 late
    mergeReadings(batch: ReadingBatch) {
      for (const r of batch.readings) {
        const existing = this.readings.find((x) => x.deviceId === r.deviceId && x.slot === r.slot);
        if (existing) {
          existing.lux = r.lux;
          existing.late = true;
          existing.batchId = batch.id;
        } else {
          this.readings.push({
            id: `rd-${++this.seq}`,
            deviceId: r.deviceId,
            slot: r.slot,
            lux: r.lux,
            batchId: batch.id,
            late: false,
            backfilled: false
          });
        }
      }
    },
    // 导入批次：失败保留批次，成功则合并读数并重算、清退
    importBatch(raw: Array<{ deviceId: string; slot: string; lux: number }>, simulateFailure?: boolean) {
      const fail = simulateFailure ?? this.failNextImport;
      const batch: ReadingBatch = {
        id: `batch-${++this.seq}`,
        readings: raw.map((r) => ({ ...r })),
        status: 'imported',
        attempts: 1,
        error: '',
        createdAt: Date.now()
      };
      this.batches.unshift(batch);
      if (fail) {
        batch.status = 'failed';
        batch.error = '导入接口返回 500：批次已保留，可重试';
        this.persist();
        return { ok: false, batch };
      }
      this.mergeReadings(batch);
      this.enforce();
      this.persist();
      return { ok: true, batch };
    },
    // 失败批次重试：仍失败则保留，成功则合并并重算
    retryBatch(batchId: string) {
      const batch = this.batches.find((b) => b.id === batchId);
      if (!batch || batch.status !== 'failed') return { ok: false, batch: null };
      batch.attempts += 1;
      if (this.failNextImport) {
        batch.error = `第 ${batch.attempts} 次重试仍失败：批次保留，可再次重试`;
        this.persist();
        return { ok: false, batch };
      }
      batch.status = 'imported';
      batch.error = '';
      this.mergeReadings(batch);
      this.enforce();
      this.persist();
      return { ok: true, batch };
    },
    // 超预算展品立即退回库房周转区；容量满则排队停在线上
    enforce() {
      for (const plan of this.plans) {
        if (plan.invalidated) continue;
        const info = computeExposure(this.$state, plan.exhibitId);
        if (!info || !info.exceeded) continue;
        if (this.turnover.some((t) => t.exhibitId === plan.exhibitId)) continue;
        const used = this.turnover.filter((t) => t.status === 'turnover').length;
        if (used < this.turnoverCapacity) {
          this.turnover.push({ exhibitId: plan.exhibitId, reason: 'exposure-exceeded', queuedAt: Date.now(), status: 'turnover' });
          plan.signed = [];        // 原布展签字失效
          plan.invalidated = true;
        } else {
          // 周转区满：排队，未轮到撤展只能停在线上（签字暂不失效）
          this.turnover.push({ exhibitId: plan.exhibitId, reason: 'exposure-exceeded', queuedAt: Date.now(), status: 'queued' });
        }
      }
    },
    // 历史无曝光记录：按当前读数回填起点，原位置和签字不动
    backfillExposure(exhibitId: string) {
      const plan = this.plans.find((p) => p.exhibitId === exhibitId && !p.invalidated);
      if (!plan) return;
      const pos = this.positions.find((p) => p.id === plan.positionId);
      if (!pos) return;
      const installSlot = toSlot(plan.installedAt);
      const has = this.readings.some((r) => r.deviceId === pos.deviceId && r.slot >= installSlot);
      if (has) return;
      const exhibition = useExhibitionStore();
      const exhibit = exhibition.exhibits.find((e) => e.id === exhibitId);
      const currentLux = exhibit?.environment.light ?? 150;
      this.readings.push({
        id: `rd-${++this.seq}`,
        deviceId: pos.deviceId,
        slot: installSlot,
        lux: currentLux,
        batchId: 'backfill',
        late: false,
        backfilled: true
      });
      this.enforce();
      this.persist();
    },
    // 办理撤展移出周转区，腾出容量；排队最久的转入并失效签字
    removeFromTurnover(exhibitId: string) {
      const idx = this.turnover.findIndex((t) => t.exhibitId === exhibitId && t.status === 'turnover');
      if (idx === -1) return;
      this.turnover.splice(idx, 1);
      const waiting = this.turnover.filter((t) => t.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
      const next = waiting[0];
      if (next) {
        next.status = 'turnover';
        const plan = this.plans.find((p) => p.exhibitId === next.exhibitId);
        if (plan) {
          plan.signed = [];
          plan.invalidated = true;
        }
      }
      this.persist();
    }
  }
});
