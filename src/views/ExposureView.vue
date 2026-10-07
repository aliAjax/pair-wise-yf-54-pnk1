<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { useExhibitionStore } from '../stores/exhibition';
import { useExposureStore } from '../stores/exposure';
import type { InstallPlan } from '../services/exposure';

const exposure = useExposureStore();
const exhibition = useExhibitionStore();
const online = useOnline();
const tab = ref<'ledger' | 'import' | 'transit' | 'audit'>('ledger');
const importText = ref('');
const importMsg = ref<{ type: 'success' | 'error'; text: string } | null>(null);

// 进入页面即完成闭环：缺失台账按当前读数回填起点 → 重算累计量 → 超限撤展/排队
onMounted(() => exposure.refresh());

const exhibitOf = (id: string) => exhibition.exhibits.find((item) => item.id === id);
const positionOf = (id: string) => exposure.positions.find((item) => item.id === id);
const fmtNum = (value: number) => Math.round(value).toLocaleString('zh-CN');
const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

interface PlanRow {
  plan: InstallPlan;
  usage: number | null;
  status: { label: string; color: string };
  rank: number;
}

const rows = computed<PlanRow[]>(() => exposure.plans.map((plan) => {
  const usage = exposure.usage(plan.exhibitId);
  const queued = exposure.queuedIds.has(plan.exhibitId);
  const inTransit = exposure.occupantIds.has(plan.exhibitId);
  let status: PlanRow['status'];
  if (!plan.active) status = inTransit ? { label: '已撤回周转区', color: 'blue' } : { label: '已入库', color: 'grey' };
  else if (queued) status = { label: '超限排队待撤', color: 'orange' };
  else if (usage !== null && usage >= 1) status = { label: '超限', color: 'red' };
  else if (usage !== null && usage >= 0.8) status = { label: '临近限值', color: 'amber-darken-2' };
  else status = { label: '在展', color: 'green' };
  return { plan, usage, status, rank: plan.active ? 0 : 1 };
}).sort((a, b) => a.rank - b.rank || (b.usage ?? -1) - (a.usage ?? -1)));

const usageColor = (usage: number | null) => (usage === null ? 'grey' : usage >= 1 ? 'red' : usage >= 0.8 ? 'amber-darken-2' : 'green');
const pct = (usage: number | null) => Math.min(100, Math.round((usage ?? 0) * 100));

const exampleBatch = JSON.stringify([
  { deviceId: 'D-A2-04', slotStart: '2026-09-22T09:00:00', slotHours: 3, lux: 520 },
  { deviceId: 'D-B1-02', slotStart: '2026-10-07T09:00:00', slotHours: 3, lux: 88 }
], null, 2);

function submitImport() {
  importMsg.value = null;
  let payload: unknown;
  try {
    payload = JSON.parse(importText.value);
  } catch {
    importMsg.value = { type: 'error', text: 'JSON 解析失败，请检查格式' };
    return;
  }
  const result = exposure.importRows(payload);
  importMsg.value = result.ok
    ? { type: 'success', text: '导入成功：读数已按设备+时段去重合并，累计曝光已重算' }
    : { type: 'error', text: `导入失败，批次已保留可重试：${result.error ?? ''}` };
  if (result.ok) importText.value = '';
}
</script>

<template>
  <v-app-bar color="teal-darken-3" flat>
    <v-btn icon="mdi-arrow-left" to="/" class="ml-1" />
    <v-app-bar-title>{{ $t('exposureTitle') }}</v-app-bar-title>
    <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
    <v-btn prepend-icon="mdi-recycle" variant="tonal" @click="exposure.refresh()">重新核算</v-btn>
  </v-app-bar>
  <v-main class="bg-grey-lighten-4">
    <v-container fluid class="pa-6">
      <v-alert v-if="exposure.failedBatches.length" color="red-lighten-4" icon="mdi-package-variant-remove" class="mb-4">
        {{ exposure.failedBatches.length }} 个读数批次导入失败已保留，可在「读数导入」中重试。
      </v-alert>
      <v-alert v-if="exposure.transit.queue.length" color="orange-lighten-4" icon="mdi-clock-alert-outline" class="mb-4">
        库房周转区已满，{{ exposure.transit.queue.length }} 件超限展品排队待撤，未轮到的展品留在展线上继续累计曝光。
      </v-alert>

      <v-row class="mb-5">
        <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">在展展品</div><div class="metric">{{ exposure.activePlans.length }}</div></v-card-text></v-card></v-col>
        <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">排队待撤</div><div class="metric warn">{{ exposure.transit.queue.length }}</div></v-card-text></v-card></v-col>
        <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">周转区占用</div><div class="metric">{{ exposure.transit.occupants.length }} / {{ exposure.transit.capacity }}</div></v-card-text></v-card></v-col>
        <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">失败批次</div><div class="metric warn">{{ exposure.failedBatches.length }}</div></v-card-text></v-card></v-col>
      </v-row>

      <v-card>
        <v-tabs v-model="tab" color="teal">
          <v-tab value="ledger">曝光台账</v-tab>
          <v-tab value="import">读数导入</v-tab>
          <v-tab value="transit">周转区与队列</v-tab>
          <v-tab value="audit">操作记录</v-tab>
        </v-tabs>
        <v-window v-model="tab">
          <v-window-item value="ledger">
            <v-table>
              <thead>
                <tr><th>展品</th><th>展线位置</th><th>布展签字</th><th>累计曝光 (lux·h)</th><th>预算限值</th><th>用量</th><th>状态</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.plan.id">
                  <td>
                    <b>{{ exhibitOf(row.plan.exhibitId)?.code ?? row.plan.exhibitId }}</b>
                    {{ exhibitOf(row.plan.exhibitId)?.name ?? '' }}
                  </td>
                  <td>{{ positionOf(row.plan.positionId)?.code ?? row.plan.positionId }}</td>
                  <td>
                    <v-chip v-if="row.plan.active && row.plan.signature" size="small" color="green" variant="tonal">{{ row.plan.signature }}</v-chip>
                    <v-chip v-else-if="!row.plan.active" size="small" color="red" variant="outlined">签字已失效</v-chip>
                    <v-chip v-else size="small" color="grey" variant="outlined">未签字</v-chip>
                  </td>
                  <td>
                    {{ fmtNum(exposure.ledgers[row.plan.exhibitId]?.cumulativeLuxHours ?? 0) }}
                    <v-chip v-if="exposure.ledgers[row.plan.exhibitId]?.backfilled" size="x-small" color="indigo" variant="tonal" class="ml-1">起点已回填</v-chip>
                    <div class="text-caption text-grey">结算至 {{ fmtTime(exposure.ledgers[row.plan.exhibitId]?.through) }}</div>
                  </td>
                  <td>{{ fmtNum(exposure.budgets.find((b) => b.exhibitId === row.plan.exhibitId)?.limitLuxHours ?? 0) }}</td>
                  <td style="min-width: 140px">
                    <v-progress-linear :model-value="pct(row.usage)" :color="usageColor(row.usage)" height="8" rounded />
                    <span class="text-caption">{{ row.usage === null ? '—' : `${Math.round(row.usage * 100)}%` }}</span>
                  </td>
                  <td><v-chip size="small" :color="row.status.color">{{ row.status.label }}</v-chip></td>
                </tr>
              </tbody>
            </v-table>
          </v-window-item>

          <v-window-item value="import">
            <div class="pa-5">
              <p class="text-body-2 mb-3">
                粘贴读数 JSON 数组导入。同一设备同一时段的读数以晚到为准（去重合并），晚到读数会更新原时段并重算累计曝光；离线或校验失败时批次保留，可在此重试。
              </p>
              <v-textarea v-model="importText" rows="7" variant="outlined" label='读数批次 JSON：[{ "deviceId", "slotStart", "slotHours", "lux" }]' />
              <div class="d-flex ga-3 mb-4">
                <v-btn color="teal" prepend-icon="mdi-upload" @click="submitImport">导入批次</v-btn>
                <v-btn variant="tonal" prepend-icon="mdi-file-document-plus-outline" @click="importText = exampleBatch">填入示例批次</v-btn>
              </div>
              <v-alert v-if="importMsg" :type="importMsg.type" variant="tonal" class="mb-4">{{ importMsg.text }}</v-alert>

              <v-divider class="mb-4" />
              <div class="text-subtitle-1 mb-2">导入批次</div>
              <v-list lines="three">
                <v-list-item v-for="batch in exposure.batches" :key="batch.id">
                  <v-list-item-title>
                    {{ batch.id }} · {{ batch.rows.length }} 条读数
                    <v-chip size="x-small" class="ml-2" :color="batch.status === 'applied' ? 'green' : 'red'">{{ batch.status === 'applied' ? '已导入' : '失败待重试' }}</v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle>
                    创建 {{ fmtTime(batch.createdAt) }} · 尝试 {{ batch.attempts }} 次
                    <span v-if="batch.error" class="text-red"> · {{ batch.error }}</span>
                  </v-list-item-subtitle>
                  <template #append>
                    <template v-if="batch.status === 'failed'">
                      <v-btn size="small" color="teal" variant="tonal" class="mr-2" @click="exposure.retryBatch(batch.id)">重试</v-btn>
                      <v-btn size="small" color="grey" variant="text" @click="exposure.discardBatch(batch.id)">作废</v-btn>
                    </template>
                  </template>
                </v-list-item>
              </v-list>
            </div>
          </v-window-item>

          <v-window-item value="transit">
            <div class="pa-5">
              <div class="d-flex align-center ga-4 mb-4">
                <div class="text-subtitle-1">库房周转区 {{ exposure.transit.occupants.length }} / {{ exposure.transit.capacity }}</div>
                <v-progress-linear :model-value="(exposure.transit.occupants.length / exposure.transit.capacity) * 100" color="teal" height="10" rounded style="max-width: 320px" />
              </div>
              <v-list lines="two">
                <v-list-item v-for="entry in exposure.transit.occupants" :key="entry.exhibitId">
                  <template #prepend><v-icon color="blue">mdi-warehouse</v-icon></template>
                  <v-list-item-title>{{ exhibitOf(entry.exhibitId)?.name ?? entry.exhibitId }} · {{ exhibitOf(entry.exhibitId)?.code }}</v-list-item-title>
                  <v-list-item-subtitle>撤回时间 {{ fmtTime(entry.enteredAt) }} · 累计曝光冻结于 {{ fmtNum(exposure.ledgers[entry.exhibitId]?.cumulativeLuxHours ?? 0) }} lux·h · 原布展签字已失效</v-list-item-subtitle>
                  <template #append><v-btn size="small" color="teal" variant="tonal" @click="exposure.releaseToStorage(entry.exhibitId)">转入库房</v-btn></template>
                </v-list-item>
                <v-list-item v-if="!exposure.transit.occupants.length"><v-list-item-title class="text-grey">周转区暂无展品</v-list-item-title></v-list-item>
              </v-list>

              <v-divider class="my-4" />
              <div class="text-subtitle-1 mb-2">撤展队列（周转区满时排队，未轮到的展品留在展线上继续累计）</div>
              <v-list lines="two">
                <v-list-item v-for="(entry, index) in exposure.transit.queue" :key="entry.exhibitId">
                  <template #prepend><v-chip size="small" color="orange">{{ index + 1 }}</v-chip></template>
                  <v-list-item-title>{{ exhibitOf(entry.exhibitId)?.name ?? entry.exhibitId }} · {{ exhibitOf(entry.exhibitId)?.code }}</v-list-item-title>
                  <v-list-item-subtitle>排队时间 {{ fmtTime(entry.enteredAt) }} · 当前累计 {{ fmtNum(exposure.ledgers[entry.exhibitId]?.cumulativeLuxHours ?? 0) }} lux·h（仍在展线上累计）</v-list-item-subtitle>
                </v-list-item>
                <v-list-item v-if="!exposure.transit.queue.length"><v-list-item-title class="text-grey">队列为空</v-list-item-title></v-list-item>
              </v-list>
            </div>
          </v-window-item>

          <v-window-item value="audit">
            <v-list lines="two">
              <v-list-item v-for="entry in exposure.audit" :key="entry.id">
                <v-list-item-title>{{ entry.message }}</v-list-item-title>
                <v-list-item-subtitle>{{ fmtTime(entry.at) }}<span v-if="entry.exhibitId"> · {{ exhibitOf(entry.exhibitId)?.code ?? entry.exhibitId }}</span></v-list-item-subtitle>
              </v-list-item>
              <v-list-item v-if="!exposure.audit.length"><v-list-item-title class="text-grey">暂无操作记录</v-list-item-title></v-list-item>
            </v-list>
          </v-window-item>
        </v-window>
      </v-card>
    </v-container>
  </v-main>
</template>

<style scoped>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #0f766e; }
.metric.warn { color: #b91c1c; }
</style>
