// 曝光预算领域逻辑：照度读数合并、累计曝光重算、超限处置、周转区排队、历史回填。
// 全部为纯函数，不依赖 Vue / Pinia，便于独立验证。

export interface LinePosition {
  id: string;
  code: string;
  hall: string;
  deviceId: string;
}

export interface LuxReading {
  id: string;
  deviceId: string;
  slotStart: string; // 时段起点，统一规范化为 ISO 串
  slotHours: number;
  lux: number;
  receivedAt: string; // 到达时间，同时段去重时以晚到为准
  batchId: string;
}

export interface RawReadingRow {
  deviceId: string;
  slotStart: string;
  slotHours: number;
  lux: number;
}

export interface InstallPlan {
  id: string;
  exhibitId: string;
  positionId: string;
  since: string; // 布展开始时间
  signature: string | null; // 布展签字，撤展后失效置空
  active: boolean;
  endedAt?: string;
  endReason?: string;
}

export interface ExposureBudget {
  exhibitId: string;
  limitLuxHours: number; // 曝光预算限值（lux·h）
}

export interface ExposureLedger {
  exhibitId: string;
  baselineLuxHours: number; // 起点累计量（历史回填时为估算值）
  baselineAt: string; // 起点截止时间，之后的时段按读数实算
  backfilled: boolean; // 是否按当前读数回填的起点
  cumulativeLuxHours: number;
  through: string | null; // 已结算到的最晚时段
}

export interface TransitEntry {
  exhibitId: string;
  enteredAt: string;
}

export interface ImportBatch {
  id: string;
  createdAt: string;
  rows: RawReadingRow[];
  status: 'applied' | 'failed';
  attempts: number;
  error?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  exhibitId?: string;
  message: string;
}

export interface ExposureState {
  version: number;
  positions: LinePosition[];
  plans: InstallPlan[];
  budgets: ExposureBudget[];
  ledgers: Record<string, ExposureLedger>;
  readings: LuxReading[];
  batches: ImportBatch[];
  transit: { capacity: number; occupants: TransitEntry[]; queue: TransitEntry[] };
  audit: AuditEntry[];
}

export const EXPOSURE_STATE_VERSION = 1;

export type Logger = (message: string, exhibitId?: string) => void;

const readingKey = (deviceId: string, slotStart: string): string => `${deviceId}|${slotStart}`;

/** 读数按「设备 + 时段」去重合并：同一时段晚到的读数覆盖先到值。 */
export function mergeReadings(existing: LuxReading[], incoming: LuxReading[]): LuxReading[] {
  const map = new Map<string, LuxReading>();
  for (const reading of existing) map.set(readingKey(reading.deviceId, reading.slotStart), reading);
  for (const reading of incoming) {
    const key = readingKey(reading.deviceId, reading.slotStart);
    const prev = map.get(key);
    if (!prev || new Date(reading.receivedAt).getTime() >= new Date(prev.receivedAt).getTime()) {
      map.set(key, reading);
    }
  }
  return [...map.values()].sort((a, b) => a.slotStart.localeCompare(b.slotStart));
}

/** 校验导入行并规范化时段为 ISO 串；返回错误信息或规范化后的行。 */
export function validateRows(
  rows: unknown,
  positions: LinePosition[]
): { ok: true; rows: RawReadingRow[] } | { ok: false; error: string } {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: '批次为空或不是读数数组' };
  const knownDevices = new Set(positions.map((position) => position.deviceId));
  const normalized: RawReadingRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as Partial<RawReadingRow>;
    const label = `第 ${index + 1} 行`;
    if (!row || typeof row !== 'object') return { ok: false, error: `${label}：不是有效对象` };
    if (typeof row.deviceId !== 'string' || !knownDevices.has(row.deviceId)) {
      return { ok: false, error: `${label}：未知设备 ${String(row.deviceId)}` };
    }
    const slotTime = new Date(String(row.slotStart));
    if (Number.isNaN(slotTime.getTime())) return { ok: false, error: `${label}：时段起点无法解析` };
    const slotHours = Number(row.slotHours);
    if (!Number.isFinite(slotHours) || slotHours <= 0 || slotHours > 24) {
      return { ok: false, error: `${label}：时段时长无效` };
    }
    const lux = Number(row.lux);
    if (!Number.isFinite(lux) || lux < 0) return { ok: false, error: `${label}：照度值无效` };
    normalized.push({ deviceId: row.deviceId, slotStart: slotTime.toISOString(), slotHours, lux });
  }
  return { ok: true, rows: normalized };
}

/** 全量重算在展展品的累计曝光：台账起点 + 起点之后各时段 照度×时长。晚到读数更新原时段后调用即可重算。 */
export function recalcLedgers(state: ExposureState): void {
  for (const plan of state.plans) {
    if (!plan.active) continue;
    const ledger = state.ledgers[plan.exhibitId];
    const position = state.positions.find((item) => item.id === plan.positionId);
    if (!ledger || !position) continue;
    let sum = ledger.baselineLuxHours;
    let through: string | null = null;
    for (const reading of state.readings) {
      if (reading.deviceId !== position.deviceId) continue;
      if (reading.slotStart < ledger.baselineAt) continue;
      sum += reading.lux * reading.slotHours;
      if (!through || reading.slotStart > through) through = reading.slotStart;
    }
    ledger.cumulativeLuxHours = Math.round(sum);
    ledger.through = through;
  }
}

/**
 * 历史数据没有曝光记录时，按当前读数回填起点：
 * 以该位置设备最新读数的照度，估算布展以来的累计量作为台账起点。
 * 只补台账，不改展品位置和布展签字。
 */
export function backfillMissingLedgers(state: ExposureState, now: string, log: Logger): void {
  for (const plan of state.plans) {
    if (!plan.active || state.ledgers[plan.exhibitId]) continue;
    const position = state.positions.find((item) => item.id === plan.positionId);
    if (!position) continue;
    const deviceReadings = state.readings
      .filter((reading) => reading.deviceId === position.deviceId)
      .sort((a, b) => a.slotStart.localeCompare(b.slotStart));
    const latest = deviceReadings[deviceReadings.length - 1];
    const referenceAt = latest
      ? new Date(new Date(latest.slotStart).getTime() + latest.slotHours * 3600 * 1000).toISOString()
      : now;
    const currentLux = latest ? latest.lux : 0;
    const hours = Math.max(0, (new Date(referenceAt).getTime() - new Date(plan.since).getTime()) / (3600 * 1000));
    const baseline = Math.round(currentLux * hours);
    state.ledgers[plan.exhibitId] = {
      exhibitId: plan.exhibitId,
      baselineLuxHours: baseline,
      baselineAt: referenceAt,
      backfilled: true,
      cumulativeLuxHours: baseline,
      through: null
    };
    log(`无历史曝光记录，按当前读数 ${currentLux} lux 回填起点 ${baseline} lux·h（位置与签字保持原样）`, plan.exhibitId);
  }
}

function removeFromLine(state: ExposureState, plan: InstallPlan, now: string, log: Logger): void {
  plan.active = false;
  plan.endedAt = now;
  plan.endReason = '超限撤展';
  const signature = plan.signature;
  plan.signature = null; // 原布展签字失效
  state.transit.occupants.push({ exhibitId: plan.exhibitId, enteredAt: now });
  log(`累计曝光超限，立即退回库房周转区；原布展签字${signature ? `「${signature}」` : ''}失效`, plan.exhibitId);
}

/** 周转区有空位时，按排队顺序撤下展品。 */
export function drainQueue(state: ExposureState, now: string, log: Logger): void {
  while (state.transit.occupants.length < state.transit.capacity && state.transit.queue.length > 0) {
    const next = state.transit.queue.shift()!;
    const plan = state.plans.find((item) => item.exhibitId === next.exhibitId && item.active);
    if (plan) removeFromLine(state, plan, now, log);
  }
}

/** 超限处置：周转区有位立即撤下并作废签字；满了就排队，未轮到的展品留在展线上继续累计。 */
export function enforceBudgets(state: ExposureState, now: string, log: Logger): void {
  for (const plan of state.plans) {
    if (!plan.active) continue;
    const ledger = state.ledgers[plan.exhibitId];
    const budget = state.budgets.find((item) => item.exhibitId === plan.exhibitId);
    if (!ledger || !budget) continue;
    if (ledger.cumulativeLuxHours <= budget.limitLuxHours) continue;
    if (state.transit.occupants.length < state.transit.capacity) {
      removeFromLine(state, plan, now, log);
    } else if (!state.transit.queue.some((entry) => entry.exhibitId === plan.exhibitId)) {
      state.transit.queue.push({ exhibitId: plan.exhibitId, enteredAt: now });
      log('库房周转区已满，排队等待撤展；展品暂留展线，曝光继续累计', plan.exhibitId);
    }
  }
  drainQueue(state, now, log);
}

/** 周转区展品转入库房，腾出位置后自动处理撤展队列。 */
export function releaseTransit(state: ExposureState, exhibitId: string, now: string, log: Logger): void {
  const index = state.transit.occupants.findIndex((entry) => entry.exhibitId === exhibitId);
  if (index === -1) return;
  state.transit.occupants.splice(index, 1);
  log('离开库房周转区，转入库房；周转位已释放', exhibitId);
  drainQueue(state, now, log);
}

export function usageRatio(state: ExposureState, exhibitId: string): number | null {
  const ledger = state.ledgers[exhibitId];
  const budget = state.budgets.find((item) => item.exhibitId === exhibitId);
  if (!ledger || !budget || budget.limitLuxHours <= 0) return null;
  return ledger.cumulativeLuxHours / budget.limitLuxHours;
}
