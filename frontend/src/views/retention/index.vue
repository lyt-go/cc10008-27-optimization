<template>
  <section class="page" data-module="retention">
    <header class="page-head">
      <div>
        <h2>回访分析管理</h2>
        <p class="page-desc">分析用户回访行为模式，计算粘性指数和流失周期。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记回访模式</button>
        <button class="btn" type="button" @click="exportRows">导出回访分析清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无回访分析数据，可先登记回访模式</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <h3>回访视图快照</h3>
      <p class="page-desc">
        查询条件取自上方筛选栏；增量更新只重算受影响曲线，未受影响的回访模式继续读取上一完整回访曲线，历史边界保持不变。
      </p>
      <div class="panel-controls">
        <label>
          <span>分析视图</span>
          <select v-model="viewKey">
            <option v-for="item in viewCandidates" :key="item.viewKey" :value="item.viewKey">
              {{ item.viewKey }} · {{ item.name }}（{{ item.status }}）
            </option>
          </select>
        </label>
        <label>
          <span>度量修订号</span>
          <input v-model="metricRevision" placeholder="如 M1" />
        </label>
        <button class="btn primary" type="button" @click="computeSnapshot">增量更新快照</button>
        <button class="btn" type="button" @click="computeConcurrent">并发提交两次</button>
      </div>
      <div class="panel-controls">
        <label>
          <span>迟到度量修订号</span>
          <input v-model="lateMetricRevision" placeholder="如 M2" />
        </label>
        <label>
          <span>仲裁策略</span>
          <select v-model="strategy">
            <option value="incremental">受影响曲线增量（局部刷新 + 旧快照保留清单）</option>
            <option value="full-recompute">整套度量重算（新完整快照 + 旧报告冻结清单）</option>
          </select>
        </label>
        <button class="btn" type="button" @click="arbitrate">执行版本冲突仲裁</button>
        <button class="btn ghost" type="button" @click="resetSnapshots">清空快照</button>
      </div>
      <p v-if="snapshotMessage" class="panel-message">{{ snapshotMessage }}</p>
      <p class="share-entry">分享入口：{{ shareEntryText || '尚未固化快照' }}</p>

      <table class="data-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>状态</th>
            <th>查询签名</th>
            <th>度量修订</th>
            <th>重算曲线</th>
            <th>复用曲线</th>
            <th>固化时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="snap in snapshots" :key="snap.id">
            <td>v{{ snap.version }}</td>
            <td><span class="tag" :class="snap.status">{{ statusLabel(snap.status) }}</span></td>
            <td>{{ snap.querySignature }}</td>
            <td>{{ snap.metricRevision }}</td>
            <td>{{ snap.refreshedKeys.length }}</td>
            <td>{{ snap.reusedKeys.length }}</td>
            <td>{{ formatTime(snap.createdAt) }}</td>
            <td><button class="link" type="button" @click="reviewSnapshot(snap)">回看</button></td>
          </tr>
          <tr v-if="!snapshots.length">
            <td colspan="8" class="empty-state">暂无快照，切换查询条件后点「增量更新快照」</td>
          </tr>
        </tbody>
      </table>

      <div v-if="reviewing" class="curve-panel">
        <h4>快照 v{{ reviewing.version }} 曲线明细（{{ statusLabel(reviewing.status) }}）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>曲线</th>
              <th>用户分群</th>
              <th>度量</th>
              <th>历史边界</th>
              <th>曲线点</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="curve in reviewing.curves" :key="curve.curveKey">
              <td>{{ curve.curveKey }}</td>
              <td>{{ curve.cohort }}</td>
              <td>{{ curve.metric }}</td>
              <td>{{ curve.boundary }}</td>
              <td>{{ curve.points.join(' → ') }}</td>
              <td>{{ curve.reused ? '复用上版（未受影响）' : '本版重算' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条回访分析记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import {
  computeRetentionViewSnapshot,
  arbitrateRetentionViewConflict,
  downloadEntries,
  listEntries,
  listRetentionViewSnapshots,
  moduleMeta,
  resetRetentionSnapshots,
  retentionSnapshotShareEntry,
  retentionViewCandidates,
  runAction as applyAction,
} from '@/api/local-service'
import type {
  ConflictStrategy,
  RetentionViewSnapshot,
  SnapshotStatus,
  ViewCandidate,
} from '@/data/retention-snapshots'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('retention')
const columns = ["模式编号", "用户分群", "首次访问窗口", "回访周期天", "回访频次", "粘性指数", "流失周期", "唤醒策略"]
const actions = ["发起分析", "确认模式", "归档模式"]
const statuses = ["草稿", "分析中", "已确认", "已归档"]
const stats = [{"label": "回访模式总数", "value": 0}, {"label": "已确认模式", "value": 0}, {"label": "分析中模式", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// ---- 回访视图快照：查询条件来自筛选栏，快照是分享与回看的唯一入口 ----

const viewCandidates = ref<ViewCandidate[]>([])
const viewKey = ref('')
const metricRevision = ref('M1')
const lateMetricRevision = ref('M2')
const strategy = ref<ConflictStrategy>('incremental')
const snapshots = ref<RetentionViewSnapshot[]>([])
const reviewing = ref<RetentionViewSnapshot | null>(null)
const snapshotMessage = ref('')
const shareEntryText = ref('')

const STATUS_LABELS: Record<SnapshotStatus, string> = {
  active: '当前（分享指向）',
  retained: '保留（可回看）',
  frozen: '冻结（旧报告）',
}

function statusLabel(status: SnapshotStatus): string {
  return STATUS_LABELS[status]
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function currentQuery(): Record<string, string> {
  return { ...filters.value }
}

async function computeSnapshot() {
  snapshotMessage.value = ''
  const result = await computeRetentionViewSnapshot(viewKey.value, currentQuery(), metricRevision.value)
  snapshotMessage.value = result.message
  refreshSnapshots()
}

async function computeConcurrent() {
  snapshotMessage.value = ''
  const [first, second] = await Promise.all([
    computeRetentionViewSnapshot(viewKey.value, currentQuery(), metricRevision.value),
    computeRetentionViewSnapshot(viewKey.value, currentQuery(), metricRevision.value),
  ])
  snapshotMessage.value = `首份：${first.message} ｜ 并发另一回：${second.message}`
  refreshSnapshots()
}

async function arbitrate() {
  snapshotMessage.value = ''
  const result = await arbitrateRetentionViewConflict(
    viewKey.value,
    currentQuery(),
    lateMetricRevision.value,
    strategy.value,
  )
  snapshotMessage.value = result.message
  metricRevision.value = lateMetricRevision.value
  refreshSnapshots()
}

function reviewSnapshot(snap: RetentionViewSnapshot) {
  reviewing.value = snap
}

function resetSnapshots() {
  resetRetentionSnapshots()
  snapshotMessage.value = '快照已清空，数据视图行的快照分享链接已一并摘除'
  refreshSnapshots()
}

function refreshSnapshots() {
  viewCandidates.value = retentionViewCandidates()
  if (!viewKey.value && viewCandidates.value.length) {
    viewKey.value = viewCandidates.value[0].viewKey
  }
  snapshots.value = listRetentionViewSnapshots(viewKey.value)
  shareEntryText.value = retentionSnapshotShareEntry(viewKey.value)
  if (reviewing.value) {
    reviewing.value = snapshots.value.find((snap) => snap.id === reviewing.value?.id) ?? null
  }
}

watch(viewKey, () => {
  reviewing.value = null
  refreshSnapshots()
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '回访模式登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '回访分析列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshSnapshots()
})
</script>
