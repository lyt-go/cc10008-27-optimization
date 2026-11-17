<template>
  <section class="page" data-module="dataview">
    <header class="page-head">
      <div>
        <h2>数据视图管理</h2>
        <p class="page-desc">管理可定制和分享的数据分析视图，组合多个数据源、过滤条件和度量。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记分析视图</button>
        <button class="btn" type="button" @click="exportRows">导出数据视图清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无数据视图数据，可先登记分析视图</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <h3>复核清单</h3>
      <p class="page-desc">
        评审中的分析视图随回访分析视图数据快照增量更新；分享入口只指向一个完整快照版本，历史版本在回访分析页回看。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>视图编号</th>
            <th>视图名称</th>
            <th>当前状态</th>
            <th>快照版本</th>
            <th>分享入口</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviewQueue" :key="String(item.row.id)">
            <td>{{ item.row['视图编号'] }}</td>
            <td>{{ item.row['视图名称'] }}</td>
            <td>{{ item.row.status }}</td>
            <td>{{ item.snapshotVersion ? `v${item.snapshotVersion}` : '未固化' }}</td>
            <td>{{ item.shareEntry || '—' }}</td>
          </tr>
          <tr v-if="!reviewQueue.length">
            <td colspan="5" class="empty-state">复核清单为空：没有评审中的分析视图</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据视图记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  retentionViewReviewQueue,
  runAction as applyAction,
} from '@/api/local-service'
import type { ReviewQueueItem } from '@/data/retention-snapshots'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dataview')
const columns = ["视图编号", "视图名称", "数据源组合", "过滤条件集", "维度选择", "度量选择", "排序规则", "分享链接"]
const actions = ["提交视图评审", "保存视图", "删除视图"]
const statuses = ["草稿", "视图评审中", "已保存", "已删除"]
const stats = [{"label": "分析视图总数", "value": 0}, {"label": "已保存视图", "value": 0}, {"label": "评审中视图", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 复核清单：评审中的分析视图，随回访视图快照增量更新
const reviewQueue = ref<ReviewQueueItem[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '分析视图登记入口尚未接入审批流'
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
    reviewQueue.value = retentionViewReviewQueue()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据视图列表读取失败'
  }
}

onMounted(reload)
</script>
