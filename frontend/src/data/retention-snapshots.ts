import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

/**
 * 回访分析视图数据快照引擎。
 *
 * 背景：查询条件每变化一次，旧做法把回访模式与分析视图数据整批聚合后固化一版，
 * 重复计算让快照数量快速增长。这里改为局部更新：
 *  - 未受影响的回访模式继续读取上一完整回访曲线，稳定部分的历史边界保持不变；
 *  - 同一查询条件 + 同一度量修订 + 同一批源数据只固化一次，后到请求复用已有快照；
 *  - 并发提交只保留首份增量快照，其余请求照旧返回当前快照；
 *  - 查询条件更新与迟到度量修订撞在同一回访视图时，按「受影响曲线增量」或
 *    「整套度量重算」仲裁，两条路径都保证同一分享入口只指向一个完整快照版本。
 *
 * 数据流：retention 模块的回访模式行 -> 回访曲线 -> 快照（独立 localStorage key）
 * -> 写回 dataview 模块对应分析视图的分享链接（复核清单随快照增量更新）。
 */

/** 回访曲线使用的度量：取自回访模式的数值字段。 */
export const CURVE_METRICS = ['回访频次', '粘性指数', '流失周期'] as const

/** 一条回访曲线：某个回访模式在某个度量下、按回访周期展开的一串点。 */
export type RetentionCurve = {
  curveKey: string
  patternId: number
  patternCode: string
  cohort: string
  metric: string
  points: number[]
  /** 历史边界（首末周期）：复用的曲线跨快照保持这串标记不变 */
  boundary: string
  /** 曲线指纹：源模式数据 + 度量 + 度量修订号，变了才算受影响 */
  fingerprint: string
  /** 本版是否复用上一完整回访曲线 */
  reused: boolean
}

export type SnapshotStatus = 'active' | 'retained' | 'frozen'

/** 回访分析视图数据快照：一次固化的完整视图版本。 */
export type RetentionViewSnapshot = {
  id: number
  viewKey: string
  version: number
  querySignature: string
  metricRevision: string
  curves: RetentionCurve[]
  /** 本版重算的曲线（受影响部分） */
  refreshedKeys: string[]
  /** 本版复用的曲线（稳定部分，历史边界保持不变） */
  reusedKeys: string[]
  /** 数据指纹：查询签名 + 度量修订 + 源数据，用于去重 */
  dataFingerprint: string
  status: SnapshotStatus
  createdAt: string
}

/** 查询条件：与列表筛选同构的「字段 -> 值」。 */
export type SnapshotQuery = Record<string, string>

export type SnapshotComputeRequest = {
  viewKey: string
  query: SnapshotQuery
  metricRevision: string
}

export type SnapshotOutcome = 'computed' | 'reused' | 'joined'

export type SnapshotComputeResult = {
  outcome: SnapshotOutcome
  snapshot: RetentionViewSnapshot | null
  message: string
}

/** 版本冲突仲裁策略：沿受影响曲线增量，或整套度量重算。 */
export type ConflictStrategy = 'incremental' | 'full-recompute'

export type ArbitrationResult = {
  strategy: ConflictStrategy
  snapshot: RetentionViewSnapshot
  refreshedKeys: string[]
  reusedKeys: string[]
  /** 旧快照保留清单（incremental 路径产出） */
  retainedList: number[]
  /** 旧报告冻结清单（full-recompute 路径产出） */
  frozenList: number[]
  /** 分享入口：两条路径都只指向这一个完整快照版本 */
  shareEntry: string
  message: string
}

/** 数据视图复核清单行：评审中的分析视图及其当前指向的快照版本。 */
export type ReviewQueueItem = {
  row: EntryRow
  snapshotVersion: number | null
  shareEntry: string
}

export type ViewCandidate = {
  viewKey: string
  name: string
  status: string
}

// ---- 确定性散列：曲线与指纹都靠它保证「同数据同结果」 ----

function hashNumber(input: string): number {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0
  }
  return hash
}

function hashText(input: string): string {
  return hashNumber(input).toString(36)
}

// ---- 查询条件签名与匹配（语义同 local-service.filterRows） ----

function queryPairs(query: SnapshotQuery): [string, string][] {
  return Object.entries(query)
    .filter(([, value]) => value.trim() !== '')
    .map(([field, value]) => [field, value.trim()] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right))
}

export function querySignature(query: SnapshotQuery): string {
  const pairs = queryPairs(query)
  return pairs.length ? pairs.map(([field, value]) => `${field}=${value}`).join('&') : '(无条件)'
}

function matchQuery(rows: EntryRow[], query: SnapshotQuery): EntryRow[] {
  const pairs = queryPairs(query)
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value)),
  )
}

// ---- 回访模式数据指纹：状态流转不算数据变更，只看业务字段 ----

const PATTERN_FIELDS = ['模式编号', '用户分群', '首次访问窗口', '回访周期天', '回访频次', '粘性指数', '流失周期', '唤醒策略']

function patternHash(pattern: EntryRow): string {
  return hashText(PATTERN_FIELDS.map((field) => String(pattern[field] ?? '')).join('|'))
}

function curveFingerprint(pattern: EntryRow, metric: string, metricRevision: string): string {
  return hashText(`${patternHash(pattern)}::${metric}::${metricRevision}`)
}

function dataFingerprint(viewKey: string, signature: string, metricRevision: string, patterns: EntryRow[]): string {
  const material = patterns
    .map((row) => `${row.id}:${patternHash(row)}`)
    .sort()
    .join(',')
  return hashText(`${viewKey}|${signature}|${metricRevision}|${material}`)
}

// ---- 回访曲线构建：同一份模式数据 + 度量修订，产出完全相同的曲线 ----

const CURVE_PERIODS = 8

function buildCurve(pattern: EntryRow, metric: string, metricRevision: string): RetentionCurve {
  const patternCode = String(pattern['模式编号'] ?? `ID-${pattern.id}`)
  const seed = hashNumber(
    `${patternCode}|${pattern['用户分群'] ?? ''}|${pattern['首次访问窗口'] ?? ''}|${metric}|${metricRevision}`,
  )
  const parsed = Number.parseFloat(String(pattern[metric] ?? ''))
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : (seed % 45) + 35
  const points = Array.from({ length: CURVE_PERIODS }, (_, index) => {
    const decay = Math.round(base * Math.pow(0.82, index))
    const jitter = (seed >> (index % 12)) & 3
    return Math.max(1, decay + jitter - 1)
  })
  return {
    curveKey: `${patternCode}::${metric}`,
    patternId: Number(pattern.id),
    patternCode,
    cohort: String(pattern['用户分群'] ?? ''),
    metric,
    points,
    boundary: `P1-P${CURVE_PERIODS}`,
    fingerprint: curveFingerprint(pattern, metric, metricRevision),
    reused: false,
  }
}

// ---- 快照存储：独立 localStorage key，与条目数据分开 ----

const SNAPSHOT_STORAGE_KEY = 'behavior-event-trace-hub:retention-view-snapshots'

type ViewBucket = {
  sharePointer: number | null
  snapshots: RetentionViewSnapshot[]
}

type SnapshotStoreShape = {
  seq: number
  views: Record<string, ViewBucket>
}

const EMPTY_STORE: SnapshotStoreShape = { seq: 0, views: {} }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let storeCache: SnapshotStoreShape | null = null

function readStore(): SnapshotStoreShape {
  if (storeCache) {
    return storeCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    storeCache = clone(EMPTY_STORE)
    return storeCache
  }
  const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY)
  if (!raw) {
    storeCache = clone(EMPTY_STORE)
    return storeCache
  }
  try {
    const parsed = JSON.parse(raw) as SnapshotStoreShape
    storeCache = { seq: parsed.seq ?? 0, views: parsed.views ?? {} }
  } catch {
    storeCache = clone(EMPTY_STORE)
  }
  return storeCache
}

function writeStore(store: SnapshotStoreShape): void {
  storeCache = store
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(store))
  }
}

function bucketOf(store: SnapshotStoreShape, viewKey: string): ViewBucket {
  if (!store.views[viewKey]) {
    store.views[viewKey] = { sharePointer: null, snapshots: [] }
  }
  return store.views[viewKey]
}

// ---- 读侧：版本列表、当前分享指向、分享入口 ----

export function listSnapshots(viewKey: string): RetentionViewSnapshot[] {
  const bucket = readStore().views[viewKey]
  if (!bucket) {
    return []
  }
  return [...bucket.snapshots].sort((left, right) => right.version - left.version)
}

export function activeSnapshot(viewKey: string): RetentionViewSnapshot | null {
  const bucket = readStore().views[viewKey]
  if (!bucket || bucket.sharePointer === null) {
    return null
  }
  return bucket.snapshots.find((item) => item.id === bucket.sharePointer) ?? null
}

export function shareEntryOf(snapshot: RetentionViewSnapshot): string {
  return `retention-view://${snapshot.viewKey}/v${snapshot.version}`
}

export function shareEntry(viewKey: string): string {
  const current = activeSnapshot(viewKey)
  return current ? shareEntryOf(current) : ''
}

// ---- 写回数据视图：只动本视图那一行的分享链接，复核清单其余行保持不变 ----

const SHARE_LINK_PATTERN = /^retention-view:\/\/(.+)\/v(\d+)$/

function syncDataviewRows(snapshot: RetentionViewSnapshot): void {
  const rows = listRows('dataview')
  if (!rows.some((row) => String(row['视图编号'] ?? '') === snapshot.viewKey)) {
    return
  }
  const entry = shareEntryOf(snapshot)
  const next = rows.map((row) =>
    String(row['视图编号'] ?? '') === snapshot.viewKey && row.status !== '已删除'
      ? { ...row, '分享链接': entry }
      : row,
  )
  saveRows('dataview', next)
}

// ---- 局部更新主流程：逐曲线比对指纹，未受影响的整条复用，受影响的才重算 ----

function computeAndStore(request: SnapshotComputeRequest, strategy: ConflictStrategy = 'incremental'): RetentionViewSnapshot {
  const store = readStore()
  const bucket = bucketOf(store, request.viewKey)
  const signature = querySignature(request.query)
  const patterns = matchQuery(listRows('retention'), request.query)
  const previous = bucket.sharePointer === null
    ? null
    : bucket.snapshots.find((item) => item.id === bucket.sharePointer) ?? null
  const reusable = new Map<string, RetentionCurve>()
  if (previous && strategy === 'incremental') {
    for (const curve of previous.curves) {
      reusable.set(curve.curveKey, curve)
    }
  }
  const curves: RetentionCurve[] = []
  const refreshedKeys: string[] = []
  const reusedKeys: string[] = []
  for (const pattern of patterns) {
    for (const metric of CURVE_METRICS) {
      const patternCode = String(pattern['模式编号'] ?? `ID-${pattern.id}`)
      const curveKey = `${patternCode}::${metric}`
      const fingerprint = curveFingerprint(pattern, metric, request.metricRevision)
      const old = reusable.get(curveKey)
      if (old && old.fingerprint === fingerprint) {
        // 未受影响的回访模式：继续读取上一完整回访曲线，历史边界保持不变
        curves.push({ ...old, reused: true })
        reusedKeys.push(curveKey)
      } else {
        curves.push(buildCurve(pattern, metric, request.metricRevision))
        refreshedKeys.push(curveKey)
      }
    }
  }
  const version = bucket.snapshots.reduce((max, item) => Math.max(max, item.version), 0) + 1
  const snapshot: RetentionViewSnapshot = {
    id: store.seq + 1,
    viewKey: request.viewKey,
    version,
    querySignature: signature,
    metricRevision: request.metricRevision,
    curves,
    refreshedKeys,
    reusedKeys,
    dataFingerprint: dataFingerprint(request.viewKey, signature, request.metricRevision, patterns),
    status: 'active',
    createdAt: new Date().toISOString(),
  }
  store.seq = snapshot.id
  for (const item of bucket.snapshots) {
    if (strategy === 'full-recompute') {
      // 整套度量重算：旧版本全部进冻结清单
      item.status = 'frozen'
    } else if (item.status === 'active') {
      // 受影响曲线增量：上一版进保留清单，已冻结的旧报告保持冻结
      item.status = 'retained'
    }
  }
  bucket.snapshots.push(snapshot)
  bucket.sharePointer = snapshot.id
  writeStore(store)
  syncDataviewRows(snapshot)
  return snapshot
}

// ---- 去重与并发：同一「视图 + 查询签名 + 度量修订」只固化一次 ----

const inFlight = new Map<string, Promise<RetentionViewSnapshot>>()

function findDuplicated(viewKey: string, fingerprint: string): RetentionViewSnapshot | null {
  const bucket = readStore().views[viewKey]
  if (!bucket) {
    return null
  }
  return bucket.snapshots.find((item) => item.dataFingerprint === fingerprint) ?? null
}

// 去重命中后把分享入口拨回这版（不新增版本）；冻结的旧报告只供回看，不重新指向。
function reactivate(snapshot: RetentionViewSnapshot): void {
  if (snapshot.status === 'frozen') {
    return
  }
  const store = readStore()
  const bucket = bucketOf(store, snapshot.viewKey)
  if (bucket.sharePointer === snapshot.id) {
    return
  }
  for (const item of bucket.snapshots) {
    if (item.status === 'active') {
      item.status = 'retained'
    }
  }
  snapshot.status = 'active'
  bucket.sharePointer = snapshot.id
  writeStore(store)
  syncDataviewRows(snapshot)
}

export async function computeSnapshot(request: SnapshotComputeRequest): Promise<SnapshotComputeResult> {
  const signature = querySignature(request.query)
  const patterns = matchQuery(listRows('retention'), request.query)
  const fingerprint = dataFingerprint(request.viewKey, signature, request.metricRevision, patterns)
  const duplicated = findDuplicated(request.viewKey, fingerprint)
  if (duplicated) {
    reactivate(duplicated)
    const message = duplicated.status === 'frozen'
      ? `命中已冻结的旧报告 v${duplicated.version}，仅供回看，分享入口仍指向现行版本`
      : `查询条件与度量修订未产生新数据，复用已有快照 v${duplicated.version}，不新增版本`
    return { outcome: 'reused', snapshot: duplicated, message }
  }
  const flightKey = `${request.viewKey}::${signature}::${request.metricRevision}`
  const pending = inFlight.get(flightKey)
  if (pending) {
    const current = activeSnapshot(request.viewKey)
    if (current) {
      // 并发提交：只留首份增量快照，本请求照旧返回当前快照
      return {
        outcome: 'joined',
        snapshot: current,
        message: `同一查询条件的增量更新正在固化，本请求照旧返回当前快照 v${current.version}，只保留首份新快照`,
      }
    }
    const snapshot = await pending
    return {
      outcome: 'joined',
      snapshot,
      message: `并发请求复用首份固化结果 v${snapshot.version}，未新增版本`,
    }
  }
  const task = (async () => {
    // 让出一个微任务，同一事件循环里的并发提交都能命中在途登记
    await Promise.resolve()
    return computeAndStore(request)
  })()
  inFlight.set(flightKey, task)
  try {
    const snapshot = await task
    return {
      outcome: 'computed',
      snapshot,
      message: `已固化快照 v${snapshot.version}：重算 ${snapshot.refreshedKeys.length} 条受影响曲线，复用 ${snapshot.reusedKeys.length} 条（历史边界保持不变）`,
    }
  } finally {
    inFlight.delete(flightKey)
  }
}

// ---- 版本冲突仲裁：查询条件更新与迟到度量修订同时落到同一回访视图 ----

export async function arbitrateConflict(
  viewKey: string,
  queryUpdate: SnapshotQuery,
  lateMetricRevision: string,
  strategy: ConflictStrategy,
): Promise<ArbitrationResult> {
  const request: SnapshotComputeRequest = { viewKey, query: queryUpdate, metricRevision: lateMetricRevision }
  const signature = querySignature(request.query)
  const patterns = matchQuery(listRows('retention'), request.query)
  const fingerprint = dataFingerprint(viewKey, signature, lateMetricRevision, patterns)
  const duplicated = findDuplicated(viewKey, fingerprint)
  if (duplicated && duplicated.status !== 'frozen') {
    reactivate(duplicated)
    return buildArbitrationResult(strategy, duplicated, '冲突双方与现有快照数据一致，复用已有版本，不新增快照')
  }
  const snapshot = computeAndStore(request, strategy)
  return buildArbitrationResult(strategy, snapshot, '')
}

function buildArbitrationResult(strategy: ConflictStrategy, snapshot: RetentionViewSnapshot, note: string): ArbitrationResult {
  const bucket = readStore().views[snapshot.viewKey]
  const retainedList = bucket
    ? bucket.snapshots.filter((item) => item.status === 'retained').map((item) => item.version)
    : []
  const frozenList = bucket
    ? bucket.snapshots.filter((item) => item.status === 'frozen').map((item) => item.version)
    : []
  const entry = shareEntryOf(snapshot)
  const base = strategy === 'full-recompute'
    ? `整套度量重算：新度量完整快照 v${snapshot.version}（${snapshot.refreshedKeys.length} 条曲线全部重算），旧报告冻结清单 [${frozenList.join('、') || '无'}]`
    : `受影响曲线增量：局部刷新 ${snapshot.refreshedKeys.length} 条曲线，复用 ${snapshot.reusedKeys.length} 条，旧快照保留清单 [${retainedList.join('、') || '无'}]`
  return {
    strategy,
    snapshot,
    refreshedKeys: snapshot.refreshedKeys,
    reusedKeys: snapshot.reusedKeys,
    retainedList,
    frozenList,
    shareEntry: entry,
    message: `${note ? `${note}；` : ''}${base}，分享入口唯一指向 v${snapshot.version}`,
  }
}

// ---- 跨模块读侧：数据视图复核清单、可选视图、重置 ----

export function retentionReviewQueue(): ReviewQueueItem[] {
  return listRows('dataview')
    .filter((row) => row.status === '视图评审中')
    .map((row) => {
      const link = String(row['分享链接'] ?? '')
      const matched = SHARE_LINK_PATTERN.exec(link)
      return {
        row,
        snapshotVersion: matched ? Number(matched[2]) : null,
        shareEntry: matched ? link : '',
      }
    })
}

export function listViewCandidates(): ViewCandidate[] {
  return listRows('dataview')
    .filter((row) => row.status !== '已删除')
    .map((row) => ({
      viewKey: String(row['视图编号'] ?? `ID-${row.id}`),
      name: String(row['视图名称'] ?? ''),
      status: String(row.status),
    }))
}

export function resetRetentionViewSnapshots(): void {
  writeStore(clone(EMPTY_STORE))
  const rows = listRows('dataview')
  if (rows.some((row) => SHARE_LINK_PATTERN.test(String(row['分享链接'] ?? '')))) {
    saveRows(
      'dataview',
      rows.map((row) =>
        SHARE_LINK_PATTERN.test(String(row['分享链接'] ?? '')) ? { ...row, '分享链接': '' } : row,
      ),
    )
  }
}
