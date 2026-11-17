import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  CURVE_METRICS,
  activeSnapshot,
  arbitrateConflict,
  computeSnapshot,
  listSnapshots,
  listViewCandidates,
  resetRetentionViewSnapshots,
  retentionReviewQueue,
  shareEntry,
} from '@/data/retention-snapshots'
import type {
  ArbitrationResult,
  ConflictStrategy,
  RetentionViewSnapshot,
  ReviewQueueItem,
  SnapshotComputeResult,
  SnapshotQuery,
  ViewCandidate,
} from '@/data/retention-snapshots'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===== 回访分析视图数据快照：局部更新、去重、并发与版本冲突仲裁 =====
// 页面只调这里；引擎在 data/retention-snapshots.ts，回访曲线从回访分析流向数据视图。

export const RETENTION_CURVE_METRICS: readonly string[] = CURVE_METRICS

/** 回访视图快照版本列表（新的在前），历史快照都可回看。 */
export function listRetentionViewSnapshots(viewKey: string): RetentionViewSnapshot[] {
  return listSnapshots(viewKey)
}

/** 当前分享入口指向的完整快照版本。 */
export function activeRetentionSnapshot(viewKey: string): RetentionViewSnapshot | null {
  return activeSnapshot(viewKey)
}

/** 分享入口文本：同一入口只指向一个完整快照版本。 */
export function retentionSnapshotShareEntry(viewKey: string): string {
  return shareEntry(viewKey)
}

/** 可挂载回访视图快照的分析视图（数据视图模块里未删除的行）。 */
export function retentionViewCandidates(): ViewCandidate[] {
  return listViewCandidates()
}

/**
 * 增量更新回访分析视图数据快照：只重算受影响曲线，稳定部分复用上版、历史边界不变；
 * 相同查询条件 + 度量修订 + 源数据去重复用；并发提交只留首份，其余照旧返回。
 */
export function computeRetentionViewSnapshot(
  viewKey: string,
  query: SnapshotQuery,
  metricRevision: string,
): Promise<SnapshotComputeResult> {
  return computeSnapshot({ viewKey, query, metricRevision })
}

/**
 * 版本冲突仲裁：查询条件更新与迟到度量修订同时影响同一回访视图时，
 * 沿「受影响曲线增量」产出局部曲线刷新 + 旧快照保留清单，
 * 或沿「整套度量重算」产出新度量完整快照 + 旧报告冻结清单。
 */
export function arbitrateRetentionViewConflict(
  viewKey: string,
  queryUpdate: SnapshotQuery,
  lateMetricRevision: string,
  strategy: ConflictStrategy,
): Promise<ArbitrationResult> {
  return arbitrateConflict(viewKey, queryUpdate, lateMetricRevision, strategy)
}

/** 数据视图模块的复核清单：评审中的分析视图随快照增量更新。 */
export function retentionViewReviewQueue(): ReviewQueueItem[] {
  return retentionReviewQueue()
}

/** 清空全部回访视图快照，并摘掉数据视图行上的快照分享链接。 */
export function resetRetentionSnapshots(): void {
  resetRetentionViewSnapshots()
}
