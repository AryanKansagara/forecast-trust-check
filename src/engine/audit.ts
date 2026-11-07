// Disaggregation audit: did splitting totals down to items change the plan in ways nobody intended?
// Every finding carries the exact quantity it distorted in the latest snapshot.
import { isLive, nodeCube, type Dataset } from './cube.ts'
import { DEFAULTS, type Options } from './metrics.ts'

export type AuditType = 'sum_mismatch' | 'rounding_loss' | 'share_jump' | 'new_item' | 'inactive_item' | 'intermittent_smear' | 'mix_divergence'
export const AUDIT_LABEL: Record<AuditType, string> = {
  sum_mismatch: 'Sum mismatch',
  rounding_loss: 'Rounding loss',
  share_jump: 'Share jump, flat parent',
  new_item: 'New item got volume',
  inactive_item: 'Inactive item got volume',
  intermittent_smear: 'Intermittent item smeared',
  mix_divergence: 'Split differs from actual mix',
}
export interface AuditFinding {
  type: AuditType
  parent: number
  child: number // -1 when the finding belongs to the parent as a whole
  qtyLatest: number // units distorted in the latest snapshot
  signedLatest: number
  qtyPeak: number
  snapshotsHit: number
  periods: string[] // periods affected in the latest snapshot
  byPeriod: { period: string; qty: number }[]
  shareBefore?: number
  shareAfter?: number
  lot?: number
  zeroRate?: number
}
export interface AuditResult {
  findings: AuditFinding[]
  byType: Record<AuditType, { qty: number; count: number }>
  uniqueDistorted: number
  statedParents: number
  checkedParents: number
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

const internalNodes = (ds: Dataset) => ds.nodes.filter((n) => n.leaf === -1)

export function runAudit(ds: Dataset, opts: Options = DEFAULTS): AuditResult {
  const { S, P } = ds
  const last = S - 1
  const groups = new Map<string, AuditFinding & { perSnap: Map<number, number> }>()
  const rec = (type: AuditType, parent: number, child: number, s: number, p: number, qty: number, signed: number, extra: Partial<AuditFinding> = {}) => {
    const key = `${type}:${parent}:${child}`
    let g = groups.get(key)
    if (!g) { g = { type, parent, child, qtyLatest: 0, signedLatest: 0, qtyPeak: 0, snapshotsHit: 0, periods: [], byPeriod: [], perSnap: new Map() }; groups.set(key, g) }
    g.perSnap.set(s, (g.perSnap.get(s) ?? 0) + qty)
    if (s === last) {
      g.qtyLatest += qty
      g.signedLatest += signed
      g.periods.push(ds.periods[p])
      g.byPeriod.push({ period: ds.periods[p], qty })
      // The lot size is whatever divides every affected bucket; one bucket alone can overstate it.
      Object.assign(g, extra, extra.lot ? { lot: gcd(g.lot ?? 0, extra.lot) } : {})
    }
  }

  let checkedParents = 0
  for (const n of internalNodes(ds)) {
    if (!n.children.length) continue
    checkedParents++
    const parent = nodeCube(ds, n.idx).q
    const st = ds.stated.get(n.idx)
    // Stated parent total vs the sum of its leaves.
    if (st) {
      for (let s = 0; s < S; s++) for (let p = 0; p < P; p++) {
        if (!isLive(ds, s, p)) continue
        const total = st[s * P + p], sum = parent[s * P + p]
        if (Number.isNaN(total) || Number.isNaN(sum)) continue
        const diff = total - sum
        if (Math.abs(diff) <= Math.max(0.01, 1e-4 * Math.abs(total))) continue
        // If every leaf sits on a common lot size and the gap is smaller than one lot per leaf, rounding did it.
        let lot = 0, allInt = true, count = 0
        for (const lf of n.leaves) {
          const v = ds.q[(lf * S + s) * P + p]
          if (Number.isNaN(v)) continue
          count++
          if (!Number.isInteger(v)) { allInt = false; break }
          lot = gcd(lot, v)
        }
        lot = lot || 1
        if (allInt && Math.abs(diff) < count * lot) rec('rounding_loss', n.idx, -1, s, p, Math.abs(diff), diff, { lot })
        else rec('sum_mismatch', n.idx, -1, s, p, Math.abs(diff), diff)
      }
    }
    // Share jumps: the parent barely moved but the split between its children did.
    const splitsItems = n.idx !== 0 || ds.levels.length === 0
    if (n.children.length >= 2 && splitsItems) {
      for (let s = 1; s < S; s++) for (let p = 0; p < P; p++) {
        if (!isLive(ds, s, p)) continue
        const p0 = parent[(s - 1) * P + p], p1 = parent[s * P + p]
        if (!(p0 > 0) || !(p1 > 0) || Math.abs(p1 - p0) / p0 > opts.parentFlatPct) continue
        for (const c of n.children) {
          const q = nodeCube(ds, c).q
          const v0 = q[(s - 1) * P + p], v1 = q[s * P + p]
          const a = (Number.isNaN(v0) ? 0 : v0) / p0, b = (Number.isNaN(v1) ? 0 : v1) / p1
          if (Math.abs(b - a) >= opts.shareJumpPP) rec('share_jump', n.idx, c, s, p, Math.abs(b - a) * p1, (b - a) * p1, { shareBefore: a, shareAfter: b })
        }
      }
    }
  }

  // The remaining checks compare the latest plan with history, so they only need the latest snapshot.
  const pastPeriods: number[] = []
  for (let p = 0; p < P; p++) if (ds.perEnd[p] <= ds.snapDay[last]) pastPeriods.push(p)
  const liveLatest: number[] = []
  for (let p = 0; p < P; p++) if (isLive(ds, last, p)) liveLatest.push(p)
  const flagged = new Set<number>()
  // One stray actual is not a sales history. History-based checks need a few completed periods to stand on.
  const deepActuals = pastPeriods.filter((p) => { for (let l = 0; l < ds.L; l++) if (!Number.isNaN(ds.a[l * P + p])) return true; return false }).length >= 3
  for (let lf = 0; lf < ds.L; lf++) {
    const node = ds.leafNode[lf]
    const parentIdx = ds.nodes[node].parent
    const cell = (s: number, p: number) => ds.q[(lf * S + s) * P + p]
    const fc = liveLatest.map((p) => cell(last, p)).map((v) => (Number.isNaN(v) ? 0 : v))
    const horizon = fc.reduce((a, b) => a + b, 0)
    if (horizon <= 0) continue
    const hist = pastPeriods.map((p) => ds.a[lf * P + p])
    const known = hist.filter((v) => !Number.isNaN(v))
    const trailing = hist.slice(-6).filter((v) => !Number.isNaN(v))
    const add = (type: AuditType, f: (v: number) => number, extra: Partial<AuditFinding> = {}) => {
      liveLatest.forEach((p, i) => { const qty = f(fc[i]); if (qty > 0) rec(type, parentIdx, node, last, p, qty, qty, extra) })
    }
    if (deepActuals) {
      const earlier = known.slice(0, -6).reduce((a, b) => a + b, 0)
      const recent = trailing.reduce((a, b) => a + b, 0)
      if (known.length >= 6 && recent === 0 && earlier > 0) { add('inactive_item', (v) => v); flagged.add(lf); continue }
      if (known.every((v) => v === 0)) { add('new_item', (v) => v); flagged.add(lf); continue }
    } else if (S >= 3) {
      // No actuals to go on: a first non-zero forecast in the last few snapshots is the best evidence available.
      let firstNonZero = -1
      for (let s = 0; s < S && firstNonZero < 0; s++) for (let p = 0; p < P; p++) if (cell(s, p) > 0) { firstNonZero = s; break }
      if (firstNonZero >= Math.max(1, S - 3)) { add('new_item', (v) => v); flagged.add(lf); continue }
    }
    // Intermittent demand spread across every bucket: stock and capacity get planned for demand that arrives in lumps.
    const nonZeroFc = fc.filter((v) => v > 0).length / fc.length
    if (known.length >= 6) {
      const zeroRate = known.filter((v) => v === 0).length / known.length
      if (zeroRate >= 0.4 && nonZeroFc >= 0.9) add('intermittent_smear', (v) => v * zeroRate, { zeroRate })
    } else if (fc.length >= 3) {
      const fractional = fc.filter((v) => !Number.isInteger(v) && v > 0).length / fc.length
      if (fractional >= 0.5 && horizon / fc.length < 5) add('intermittent_smear', (v) => v - Math.floor(v))
    }
  }

  // Forecast split vs the split actuals show. A child is only flagged if the gap is larger than its own historic wobble.
  if (deepActuals) {
    const recentPast = pastPeriods.slice(-12)
    for (const n of internalNodes(ds)) {
      if (n.children.length < 2 || (n.idx === 0 && ds.levels.length > 0)) continue
      const parent = nodeCube(ds, n.idx)
      const parentActual = recentPast.reduce((t, p) => t + (Number.isNaN(parent.a[p]) ? 0 : parent.a[p]), 0)
      if (parentActual <= 0) continue
      const horizon = liveLatest.reduce((t, p) => t + (Number.isNaN(parent.q[last * P + p]) ? 0 : parent.q[last * P + p]), 0)
      if (horizon <= 0) continue
      for (const c of n.children) {
        const cube = nodeCube(ds, c)
        if (ds.nodes[c].leaf > -1 && flagged.has(ds.nodes[c].leaf)) continue
        const act = recentPast.reduce((t, p) => t + (Number.isNaN(cube.a[p]) ? 0 : cube.a[p]), 0)
        if (recentPast.filter((p) => parent.a[p] > 0).length < 3) continue
        const shares = recentPast.filter((p) => parent.a[p] > 0).map((p) => (Number.isNaN(cube.a[p]) ? 0 : cube.a[p]) / parent.a[p])
        const mean = shares.reduce((a, b) => a + b, 0) / (shares.length || 1)
        const sd = Math.sqrt(shares.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, shares.length - 1))
        const fcQty = liveLatest.reduce((t, p) => t + (Number.isNaN(cube.q[last * P + p]) ? 0 : cube.q[last * P + p]), 0)
        const actShare = act / parentActual, fcShare = fcQty / horizon
        const gap = fcShare - actShare
        if (Math.abs(gap) < opts.shareJumpPP || Math.abs(gap) <= 2 * sd) continue
        for (const p of liveLatest) {
          const pv = parent.q[last * P + p]
          if (!(pv > 0)) continue
          rec('mix_divergence', n.idx, c, last, p, Math.abs(gap) * pv, gap * pv, { shareBefore: actShare, shareAfter: fcShare })
        }
      }
    }
  }

  const findings: AuditFinding[] = []
  for (const g of groups.values()) {
    const { perSnap, ...f } = g
    f.qtyPeak = Math.max(...perSnap.values())
    f.snapshotsHit = perSnap.size
    findings.push(f)
  }
  findings.sort((a, b) => b.qtyLatest - a.qtyLatest || b.qtyPeak - a.qtyPeak)
  const byType = Object.fromEntries((Object.keys(AUDIT_LABEL) as AuditType[]).map((t) => [t, { qty: 0, count: 0 }])) as AuditResult['byType']
  // A child can trip several checks over the same units, so the headline counts each child's largest finding once.
  const perChild = new Map<string, number>()
  for (const f of findings) {
    if (f.qtyLatest <= 0) continue
    byType[f.type].qty += f.qtyLatest
    byType[f.type].count++
    const k = f.child === -1 ? `p${f.parent}` : `c${f.child}`
    perChild.set(k, Math.max(perChild.get(k) ?? 0, f.qtyLatest))
  }
  return { findings, byType, uniqueDistorted: [...perChild.values()].reduce((a, b) => a + b, 0), statedParents: ds.stated.size, checkedParents }
}

export interface FlowLink { from: number; to: number; qty: number } // child node, -1 = parent grew / parent shrank
export interface Flow { parent: number; children: { node: number; a: number; b: number; shareA: number; shareB: number }[]; links: FlowLink[]; totalA: number; totalB: number; moved: number; added: number; removed: number }

// Parent-to-children split between two snapshots: what each child kept, gave up and received.
export function disaggFlow(ds: Dataset, parent: number, sA: number, sB: number, frozenDays: number | null = null): Flow {
  const { P } = ds
  const periods: number[] = []
  const hi = Math.max(sA, sB)
  const parentQ = nodeCube(ds, parent).q
  for (let p = 0; p < P; p++) {
    if (!isLive(ds, hi, p)) continue
    // A period only one snapshot knows about is the horizon rolling forward, not the parent growing.
    if (Number.isNaN(parentQ[sA * P + p]) || Number.isNaN(parentQ[sB * P + p])) continue
    if (frozenDays !== null && ds.perStart[p] >= ds.snapDay[hi] + frozenDays) continue
    periods.push(p)
  }
  const sum = (q: Float64Array, s: number) => periods.reduce((t, p) => { const v = q[s * P + p]; return t + (Number.isNaN(v) ? 0 : v) }, 0)
  const raw = ds.nodes[parent].children.map((c) => { const { q } = nodeCube(ds, c); return { node: c, a: sum(q, sA), b: sum(q, sB) } })
  const totalA = raw.reduce((t, c) => t + c.a, 0), totalB = raw.reduce((t, c) => t + c.b, 0)
  const children = raw.map((c) => ({ ...c, shareA: totalA ? c.a / totalA : 0, shareB: totalB ? c.b / totalB : 0 }))
  const down = children.filter((c) => c.a > c.b), up = children.filter((c) => c.b > c.a)
  const gave = down.reduce((t, c) => t + c.a - c.b, 0), got = up.reduce((t, c) => t + c.b - c.a, 0)
  const pool = Math.max(gave, got)
  const links: FlowLink[] = []
  for (const c of children) { const kept = Math.min(c.a, c.b); if (kept > 0) links.push({ from: c.node, to: c.node, qty: kept }) }
  if (pool > 0) {
    for (const d of down) for (const u of up) {
      const qty = ((d.a - d.b) * (u.b - u.a)) / pool
      if (qty > 0) links.push({ from: d.node, to: u.node, qty })
    }
    if (got > gave) for (const u of up) links.push({ from: -1, to: u.node, qty: ((u.b - u.a) * (got - gave)) / got })
    if (gave > got) for (const d of down) links.push({ from: d.node, to: -1, qty: ((d.a - d.b) * (gave - got)) / gave })
  }
  return { parent, children, links, totalA, totalB, moved: Math.min(gave, got), added: Math.max(0, got - gave), removed: Math.max(0, gave - got) }
}
