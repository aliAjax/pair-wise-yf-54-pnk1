import { defineStore } from 'pinia';
import {
  EXPOSURE_STATE_VERSION,
  backfillMissingLedgers,
  enforceBudgets,
  mergeReadings,
  recalcLedgers,
  releaseTransit,
  usageRatio,
  validateRows,
  type ExposureState,
  type ImportBatch,
  type InstallPlan,
  type LuxReading,
  type RawReadingRow
} from '../services/exposure';

const STORAGE_KEY = 'yf54-exposure-state';

// 各展线位照度计的基准照度（lux），种子读数在此基础上按日/时段确定性波动
const LUX_BASE: Record<string, number> = {
  'D-A2-01': 52, 'D-A2-02': 61, 'D-A2-03': 138, 'D-A2-04': 78, 'D-A2-05': 47,
  'D-B1-01': 55, 'D-B1-02': 83, 'D-B1-03': 66, 'D-B1-04': 49, 'D-B1-05': 91
};

// 曝光预算限值（lux·h）：前三件预算偏紧会超限，ex-12 临近限值，其余宽裕
const BUDGET_LIMIT: Record<string, number> = { 'ex-9': 10000, 'ex-10': 11000, 'ex-11': 20000, 'ex-12': 17000 };

function buildSeed(): ExposureState {
  const positions: ExposureState['positions'] = [];
  for (const { hall, prefix } of [{ hall: 'A2 温湿展柜', prefix: 'A2' }, { hall: 'B1 开放展区', prefix: 'B1' }]) {
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, '0');
      positions.push({ id: `P-${prefix}-${suffix}`, code: `${prefix}-${suffix} 展线位`, hall, deviceId: `D-${prefix}-${suffix}` });
    }
  }

  // 布展方案：ex-9 ~ ex-18 依次挂上 10 个展线位，2026-09-20 09:00 起展
  const plans: InstallPlan[] = positions.map((position, index) => ({
    id: `plan-${index + 1}`,
    exhibitId: `ex-${index + 9}`,
    positionId: position.id,
    since: new Date(2026, 8, 20, 9).toISOString(),
    signature: '布展负责人·王岚',
    active: true
  }));

  const budgets = plans.map((plan) => ({ exhibitId: plan.exhibitId, limitLuxHours: BUDGET_LIMIT[plan.exhibitId] ?? 60000 }));

  // 照度读数：2026-09-20 ~ 2026-10-06，每日 09/12/15/18 四个时段，每段 3 小时
  const readings: LuxReading[] = [];
  for (let day = 0; day < 17; day += 1) {
    [9, 12, 15, 18].forEach((hour, slotIndex) => {
      const start = new Date(2026, 8, 20 + day, hour);
      for (const position of positions) {
        const lux = LUX_BASE[position.deviceId] + ((day * 7 + slotIndex * 13) % 17) - 8;
        readings.push({
          id: `seed-${position.deviceId}-${day}-${slotIndex}`,
          deviceId: position.deviceId,
          slotStart: start.toISOString(),
          slotHours: 3,
          lux,
          receivedAt: new Date(start.getTime() + 3 * 3600 * 1000).toISOString(),
          batchId: 'seed'
        });
      }
    });
  }

  // 曝光台账：ex-13 故意缺失，模拟历史数据无曝光记录，由回填逻辑按当前读数补起点
  const ledgers: ExposureState['ledgers'] = {};
  for (const plan of plans) {
    if (plan.exhibitId === 'ex-13') continue;
    ledgers[plan.exhibitId] = {
      exhibitId: plan.exhibitId,
      baselineLuxHours: 0,
      baselineAt: plan.since,
      backfilled: false,
      cumulativeLuxHours: 0,
      through: null
    };
  }

  // 一个导入失败被保留的批次：晚到的历史时段修正读数，重试成功后应更新原时段并重算
  const batches: ImportBatch[] = [{
    id: 'batch-seed-failed',
    createdAt: new Date(2026, 9, 6, 21, 30).toISOString(),
    rows: [{ deviceId: 'D-A2-03', slotStart: new Date(2026, 8, 25, 9).toISOString(), slotHours: 3, lux: 182 }],
    status: 'failed',
    attempts: 1,
    error: '网络不可用，导入失败，批次已保留'
  }];

  return {
    version: EXPOSURE_STATE_VERSION,
    positions,
    plans,
    budgets,
    ledgers,
    readings,
    batches,
    transit: { capacity: 2, occupants: [], queue: [] },
    audit: []
  };
}

function load(): ExposureState {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved) as ExposureState;
    if (parsed && parsed.version === EXPOSURE_STATE_VERSION) return parsed;
  }
  return buildSeed();
}

export const useExposureStore = defineStore('exposure', {
  state: (): ExposureState => load(),
  getters: {
    failedBatches: (state) => state.batches.filter((batch) => batch.status === 'failed'),
    activePlans: (state) => state.plans.filter((plan) => plan.active),
    queuedIds: (state) => new Set(state.transit.queue.map((entry) => entry.exhibitId)),
    occupantIds: (state) => new Set(state.transit.occupants.map((entry) => entry.exhibitId)),
    usage: (state) => (exhibitId: string) => usageRatio(state, exhibitId)
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    log(message: string, exhibitId?: string) {
      this.audit.unshift({ id: `log-${Date.now()}-${this.audit.length}`, at: new Date().toISOString(), exhibitId, message });
      if (this.audit.length > 100) this.audit.length = 100;
    },
    /** 回填缺失台账 → 全量重算累计量 → 超限处置（撤展/排队），然后持久化。 */
    refresh() {
      const now = new Date().toISOString();
      backfillMissingLedgers(this.$state, now, (message, exhibitId) => this.log(message, exhibitId));
      recalcLedgers(this.$state);
      enforceBudgets(this.$state, now, (message, exhibitId) => this.log(message, exhibitId));
      this.persist();
    },
    applyBatch(batch: ImportBatch, rows: RawReadingRow[]) {
      const receivedAt = new Date().toISOString();
      const readings: LuxReading[] = rows.map((row, index) => ({ id: `${batch.id}-${index}`, ...row, receivedAt, batchId: batch.id }));
      this.readings = mergeReadings(this.readings, readings);
      batch.status = 'applied';
      batch.error = undefined;
      this.log(`批次 ${batch.id} 导入 ${rows.length} 条读数，已按设备+时段去重合并，晚到读数更新原时段后重算累计量`);
      this.refresh();
    },
    /** 导入读数批次；失败（离线或校验不通过）时保留批次供重试。 */
    importRows(payload: unknown): { ok: boolean; error?: string } {
      const batch: ImportBatch = {
        id: `batch-${Date.now()}`,
        createdAt: new Date().toISOString(),
        rows: Array.isArray(payload) ? payload as RawReadingRow[] : [],
        status: 'failed',
        attempts: 1
      };
      if (!navigator.onLine) {
        batch.error = '网络不可用，批次已保留，恢复后请重试';
        this.batches.unshift(batch);
        this.log(`批次 ${batch.id} 导入失败：${batch.error}`);
        this.persist();
        return { ok: false, error: batch.error };
      }
      const check = validateRows(payload, this.positions);
      if (!check.ok) {
        batch.error = check.error;
        this.batches.unshift(batch);
        this.log(`批次 ${batch.id} 导入失败：${check.error}`);
        this.persist();
        return { ok: false, error: check.error };
      }
      this.applyBatch(batch, check.rows);
      return { ok: true };
    },
    /** 重试失败批次：重新校验并合并，成功则更新原时段读数并重算累计量。 */
    retryBatch(id: string) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch || batch.status !== 'failed') return;
      batch.attempts += 1;
      if (!navigator.onLine) {
        batch.error = '网络不可用，重试失败，批次继续保留';
        this.persist();
        return;
      }
      const check = validateRows(batch.rows, this.positions);
      if (!check.ok) {
        batch.error = check.error;
        this.persist();
        return;
      }
      this.applyBatch(batch, check.rows);
    },
    discardBatch(id: string) {
      const index = this.batches.findIndex((item) => item.id === id && item.status === 'failed');
      if (index === -1) return;
      this.batches.splice(index, 1);
      this.log(`失败批次 ${id} 已作废`);
      this.persist();
    },
    /** 周转区展品转入库房，腾出位置后自动按队列撤下下一件。 */
    releaseToStorage(exhibitId: string) {
      releaseTransit(this.$state, exhibitId, new Date().toISOString(), (message, id) => this.log(message, id));
      this.persist();
    }
  }
});
