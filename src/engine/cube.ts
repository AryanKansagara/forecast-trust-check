// The dataset: leaf forecasts as a flat snapshot x period cube, plus the hierarchy and any parent totals the file stated.
import type { CleanRow, ImportReport } from './csv.ts'

export type LevelName = 'family' | 'region' | 'customer'
export interface TreeNode { idx: number; id: string; label: string; depth: number; parent: number; children: number[]; leaves: number[]; leaf: number; levelName: string }
export interface Dataset {
  levels: LevelName[]
  snapshots: string[]
  periods: string[]
  S: number
  P: number
  L: number
  snapDay: number[]
  perStart: number[]
  perEnd: number[]
  gapDays: number
  nodes: TreeNode[]
  leafNode: number[]
  q: Float64Array // L * S * P
  a: Float64Array // L * P
  stated: Map<number, Float64Array> // node -> S * P
  hasActuals: boolean
}

const dayOf = (iso: string) => Math.round(Date.parse(iso + 'T00:00:00Z') / 864e5)
const SEP = '\u001f'

export function buildDataset(rows: CleanRow[], report?: ImportReport): Dataset {
  const lv: LevelName[] = (['family', 'region', 'customer'] as const).filter((l) => rows.some((r) => r[l]))
  const snapshots = [...new Set(rows.flatMap((r) => (r.snapshot ? [r.snapshot] : [])))].sort()
  const periods = [...new Set(rows.map((r) => r.period))].sort()
  const S = snapshots.length, P = periods.length
  const snapI = new Map(snapshots.map((s, i) => [s, i]))
  const perI = new Map(periods.map((s, i) => [s, i]))
  const nodes: TreeNode[] = [{ idx: 0, id: 'root', label: 'All items', depth: 0, parent: -1, children: [], leaves: [], leaf: -1, levelName: 'all' }]
  const byId = new Map<string, number>([['root', 0]])
  const child = (parent: number, label: string, levelName: string): number => {
    const id = nodes[parent].id + SEP + label
    let i = byId.get(id)
    if (i === undefined) {
      i = nodes.length
      byId.set(id, i)
      nodes.push({ idx: i, id, label, depth: nodes[parent].depth + 1, parent, children: [], leaves: [], leaf: -1, levelName })
      nodes[parent].children.push(i)
    }
    return i
  }
  const leafNode: number[] = []
  const pathOf = (r: CleanRow) => {
    let n = 0
    for (const l of lv) n = child(n, r[l] || '(none)', l)
    return n
  }
  for (const r of rows) {
    if (!r.item) continue
    const n = child(pathOf(r), r.item, 'item')
    if (nodes[n].leaf === -1) {
      nodes[n].leaf = leafNode.length
      leafNode.push(n)
      for (let a = n; a !== -1; a = nodes[a].parent) nodes[a].leaves.push(nodes[n].leaf)
    }
  }
  const L = leafNode.length
  const q = new Float64Array(L * S * P).fill(NaN)
  const a = new Float64Array(L * P).fill(NaN)
  const stated = new Map<number, Float64Array>()
  let dup = 0
  const statedPath = (r: CleanRow): number => {
    let n = 0
    for (const l of lv) {
      if (!r[l]) break
      const i = byId.get(nodes[n].id + SEP + r[l])
      if (i === undefined) return -1
      n = i
    }
    return n
  }
  for (const r of rows) {
    const p = perI.get(r.period)!
    const s = r.snapshot ? snapI.get(r.snapshot)! : -1
    if (r.item) {
      const lf = nodes[byId.get(nodes[pathOf(r)].id + SEP + r.item)!].leaf
      if (s > -1 && r.qty !== null) {
        const k = (lf * S + s) * P + p
        // Same key twice usually means the export has a dimension that was not mapped, so the rows are additive.
        if (Number.isNaN(q[k])) q[k] = r.qty
        else { q[k] += r.qty; dup++ }
      }
      if (r.actual !== null) a[lf * P + p] = r.actual
    } else if (s > -1 && r.qty !== null) {
      const n = statedPath(r)
      if (n === -1) continue
      let m = stated.get(n)
      if (!m) { m = new Float64Array(S * P).fill(NaN); stated.set(n, m) }
      m[s * P + p] = r.qty
    }
  }
  if (report) report.duplicates += dup
  const snapDay = snapshots.map(dayOf)
  const perStart = periods.map(dayOf)
  const gaps = perStart.slice(1).map((d, i) => d - perStart[i]).sort((x, y) => x - y)
  const gapDays = gaps.length ? gaps[gaps.length >> 1] : 7
  const perEnd = perStart.map((d, i) => (i + 1 < P ? perStart[i + 1] : d + gapDays))
  return { levels: lv, snapshots, periods, S, P, L, snapDay, perStart, perEnd, gapDays, nodes, leafNode, q, a, stated, hasActuals: a.some((v) => !Number.isNaN(v)) }
}

const cubes = new WeakMap<Dataset, Map<number, { q: Float64Array; a: Float64Array }>>()

// The summed forecast and actuals under any node. A cell is missing only if every leaf is missing.
export function nodeCube(ds: Dataset, node: number): { q: Float64Array; a: Float64Array } {
  let cache = cubes.get(ds)
  if (!cache) cubes.set(ds, (cache = new Map()))
  const hit = cache.get(node)
  if (hit) return hit
  const { S, P } = ds
  const n = ds.nodes[node]
  const q = new Float64Array(S * P).fill(NaN)
  const a = new Float64Array(P).fill(NaN)
  for (const lf of n.leaves) {
    const off = lf * S * P
    for (let i = 0; i < S * P; i++) { const v = ds.q[off + i]; if (!Number.isNaN(v)) q[i] = (Number.isNaN(q[i]) ? 0 : q[i]) + v }
    for (let p = 0; p < P; p++) { const v = ds.a[lf * P + p]; if (!Number.isNaN(v)) a[p] = (Number.isNaN(a[p]) ? 0 : a[p]) + v }
  }
  const out = { q, a }
  cache.set(node, out)
  return out
}

// A period is still forecastable at a snapshot if its bucket has not fully ended.
export const isLive = (ds: Dataset, s: number, p: number) => ds.perEnd[p] > ds.snapDay[s]
export const inWindow = (ds: Dataset, s: number, p: number, days: number) => ds.perEnd[p] > ds.snapDay[s] && ds.perStart[p] < ds.snapDay[s] + days

// How many buckets ahead of the snapshot a period sits. Negative = already over.
export function lagOf(ds: Dataset, s: number, p: number): number {
  // Snapshot earlier than any bucket in the file: count the calendar buckets that are missing in between.
  if (ds.snapDay[s] < ds.perStart[0]) return p + Math.round((ds.perStart[0] - ds.snapDay[s]) / ds.gapDays)
  for (let i = 0; i < ds.P; i++) if (ds.perEnd[i] > ds.snapDay[s]) return p - i
  return p - ds.P
}

// Same data as if only the first k+1 snapshots existed. The hero uses this to replay history through the real engine.
export function sliceSnapshots(ds: Dataset, count: number): Dataset {
  const S = Math.max(1, Math.min(count, ds.S))
  const q = new Float64Array(ds.L * S * ds.P)
  for (let l = 0; l < ds.L; l++) q.set(ds.q.subarray(l * ds.S * ds.P, (l * ds.S + S) * ds.P), l * S * ds.P)
  const asOf = ds.snapDay[S - 1]
  // Actuals not yet known at the cut-off must not leak into the replay.
  const a = ds.a.slice()
  for (let p = 0; p < ds.P; p++) if (ds.perEnd[p] > asOf) for (let l = 0; l < ds.L; l++) a[l * ds.P + p] = NaN
  const stated = new Map<number, Float64Array>()
  for (const [k, m] of ds.stated) stated.set(k, m.slice(0, S * ds.P))
  return { ...ds, S, snapshots: ds.snapshots.slice(0, S), snapDay: ds.snapDay.slice(0, S), q, a, stated, hasActuals: a.some((v) => !Number.isNaN(v)) }
}
