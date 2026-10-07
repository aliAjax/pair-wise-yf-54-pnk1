<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useExposureStore } from '../stores/exposure';
import { useExhibitionStore } from '../stores/exhibition';

const exposure = useExposureStore();
const exhibition = useExhibitionStore();
const { exposureList, turnoverUsed, queuedCount, failedBatches, exceededCount } = storeToRefs(exposure);

const deviceOptions = computed(() => exposure.positions.map((p) => p.deviceId).filter((v, i, a) => a.indexOf(v) === i));
const exhibitName = (id: string) => exhibition.exhibits.find((e) => e.id === id)?.name ?? id;

// 导入表单
const device = ref(deviceOptions.value[0] ?? 'LT-A1');
const slot = ref(toLocalInput(new Date()));
const lux = ref(300);
const pending = ref<Array<{ deviceId: string; slot: string; lux: number }>>([]);
const lastMsg = ref('');

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function addToPending() {
  pending.value.push({ deviceId: device.value, slot: slot.value.length === 16 ? slot.value.slice(0, 13) : slot.value, lux: Number(lux.value) });
}
function removePending(i: number) { pending.value.splice(i, 1); }
function importPending() {
  if (!pending.value.length) return;
  const res = exposure.importBatch(pending.value);
  if (res.ok) {
    lastMsg.value = `批次 ${res.batch.id} 已导入：${res.batch.readings.length} 条读数，已重算累计曝光并清退超预算展品。`;
    pending.value = [];
  } else {
    lastMsg.value = `批次 ${res.batch.id} 导入失败：${res.batch.error}（批次已保留，可在下方重试）`;
  }
}
function retry(id: string) {
  const res = exposure.retryBatch(id);
  lastMsg.value = res.ok ? `批次 ${id} 重试成功，已重算。` : `批次 ${id} 重试仍失败：${res.batch?.error ?? ''}`;
}
// 一键生成高读数批次，演示超预算清退
function generateOverBudget() {
  const target = exposure.positions[2]?.deviceId ?? 'LT-B1';
  const list: Array<{ deviceId: string; slot: string; lux: number }> = [];
  const now = Date.now();
  for (let h = 5; h >= 1; h--) {
    const d = new Date(now - h * 3600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    list.push({ deviceId: target, slot: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`, lux: 900 });
  }
  pending.value = list;
}

const turnoverItems = computed(() => exposure.turnover.filter((t) => t.status === 'turnover'));
const queueItems = computed(() => exposure.turnover.filter((t) => t.status === 'queued'));
</script>

<template>
  <div>
    <v-row class="mb-5">
      <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">展线上展品</div><div class="metric">{{ exposureList.length }}</div></v-card-text></v-card></v-col>
      <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">超预算</div><div class="metric warn">{{ exceededCount }}</div></v-card-text></v-card></v-col>
      <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">库房周转区</div><div class="metric">{{ turnoverUsed }} / {{ exposure.turnoverCapacity }}</div></v-card-text></v-card></v-col>
      <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">在线排队 / 待重试批次</div><div class="metric">{{ queuedCount }} / {{ failedBatches.length }}</div></v-card-text></v-card></v-col>
    </v-row>

    <v-card class="mb-5">
      <v-card-title>曝光预算台账</v-card-title>
      <v-table>
        <thead><tr><th>展品</th><th>展线位置</th><th>采集设备</th><th>累计曝光 (lux·h)</th><th>预算 (lux·h)</th><th style="width:22%">使用率</th><th>状态</th><th>布展签字</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in exposureList" :key="row.exhibitId">
            <td>{{ row.code }} · {{ row.name }}</td>
            <td>{{ row.positionCode }}</td>
            <td>{{ row.deviceId }}</td>
            <td>{{ row.cumulative }}</td>
            <td>{{ row.budget }}</td>
            <td>
              <v-progress-linear :model-value="Math.min(100, Math.round(row.ratio * 100))" :color="row.exceeded ? 'red' : row.ratio > 0.8 ? 'orange' : 'green'" height="14" rounded />
              <div class="ratio-text">{{ Math.round(row.ratio * 100) }}%</div>
            </td>
            <td>
              <v-chip v-if="row.exceeded" size="small" color="red">超预算</v-chip>
              <v-chip v-else size="small" color="green">正常</v-chip>
              <v-chip v-if="row.backfilled" size="small" color="blue" class="ml-1">已回填起点</v-chip>
            </td>
            <td>
              <v-chip v-for="s in row.signed" :key="s" size="small" class="mr-1">{{ s }}</v-chip>
              <span v-if="!row.signed.length" class="invalid">已失效</span>
            </td>
            <td>
              <v-btn v-if="!row.hasReadings" size="small" color="blue" variant="text" @click="exposure.backfillExposure(row.exhibitId)">按当前读数回填起点</v-btn>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-row>
      <v-col cols="12" md="6">
        <v-card class="mb-5">
          <v-card-title>照度读数导入</v-card-title>
          <v-card-text>
            <v-alert v-if="lastMsg" type="info" variant="tonal" class="mb-3">{{ lastMsg }}</v-alert>
            <v-row>
              <v-col cols="4"><v-select v-model="device" :items="deviceOptions" label="采集设备" density="compact" /></v-col>
              <v-col cols="4"><v-text-field v-model="slot" type="datetime-local" label="时段" density="compact" /></v-col>
              <v-col cols="4"><v-text-field v-model.number="lux" type="number" label="照度 lux" density="compact" /></v-col>
            </v-row>
            <v-btn size="small" variant="tonal" @click="addToPending">加入批次</v-btn>
            <v-btn size="small" color="deep-purple" class="ml-2" @click="importPending" :disabled="!pending.length">导入批次</v-btn>
            <v-btn size="small" color="orange" variant="text" class="ml-2" @click="generateOverBudget">生成超预算读数演示</v-btn>
            <v-checkbox v-model="exposure.failNextImport" label="模拟导入失败（批次保留并重试）" density="compact" class="mt-2" />
            <v-list v-if="pending.length" class="mt-2">
              <v-list-item v-for="(r, i) in pending" :key="i">
                <v-list-item-title>{{ r.deviceId }} · {{ r.slot }} · {{ r.lux }} lux</v-list-item-title>
                <template #append><v-btn size="small" variant="text" @click="removePending(i)">移除</v-btn></template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>

        <v-card class="mb-5">
          <v-card-title>导入批次（失败保留，可重试）</v-card-title>
          <v-list>
            <v-list-item v-for="b in exposure.batches" :key="b.id">
              <v-list-item-title>
                {{ b.id }} · {{ b.readings.length }} 条 · 尝试 {{ b.attempts }} 次
                <v-chip v-if="b.status === 'failed'" size="small" color="red" class="ml-1">失败</v-chip>
                <v-chip v-else size="small" color="green" class="ml-1">已导入</v-chip>
              </v-list-item-title>
              <v-list-item-subtitle v-if="b.error" class="invalid">{{ b.error }}</v-list-item-subtitle>
              <template #append>
                <v-btn v-if="b.status === 'failed'" size="small" color="orange" @click="retry(b.id)">重试</v-btn>
              </template>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card class="mb-5">
          <v-card-title>库房周转区（{{ turnoverUsed }} / {{ exposure.turnoverCapacity }}）</v-card-title>
          <v-card-text>
            <div class="section-label">已退回周转区（签字已失效）</div>
            <v-list>
              <v-list-item v-for="t in turnoverItems" :key="t.exhibitId">
                <v-list-item-title>{{ exhibitName(t.exhibitId) }} · {{ t.exhibitId }}</v-list-item-title>
                <v-list-item-subtitle>原因：累计曝光超预算 · {{ new Date(t.queuedAt).toLocaleString() }}</v-list-item-subtitle>
                <template #append><v-btn size="small" color="green" @click="exposure.removeFromTurnover(t.exhibitId)">办理撤展移出</v-btn></template>
              </v-list-item>
            </v-list>
            <div v-if="!turnoverItems.length" class="muted">周转区为空。</div>
            <v-divider class="my-3" />
            <div class="section-label">在线排队（周转区已满，只能停在线上）</div>
            <v-list>
              <v-list-item v-for="t in queueItems" :key="t.exhibitId">
                <v-list-item-title>{{ exhibitName(t.exhibitId) }} · {{ t.exhibitId }}</v-list-item-title>
                <v-list-item-subtitle>排队中 · {{ new Date(t.queuedAt).toLocaleString() }}</v-list-item-subtitle>
                <template #append><v-chip size="small" color="orange">排队</v-chip></template>
              </v-list-item>
            </v-list>
            <div v-if="!queueItems.length" class="muted">无排队展品。</div>
          </v-card-text>
        </v-card>

        <v-card class="mb-5">
          <v-card-title>展线位置与采集设备</v-card-title>
          <v-list>
            <v-list-item v-for="p in exposure.positions" :key="p.id">
              <v-list-item-title>{{ p.code }} · {{ p.hall }}</v-list-item-title>
              <v-list-item-subtitle>采集设备 {{ p.deviceId }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<style scoped>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.ratio-text { font-size: 12px; color: #6b7280; margin-top: 2px; }
.invalid { color: #b91c1c; font-size: 12px; }
.muted { color: #9ca3af; font-size: 13px; }
.section-label { font-weight: 600; margin-bottom: 6px; }
</style>
