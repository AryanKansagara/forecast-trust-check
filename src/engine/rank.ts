// Pulls metrics and audit together into one answer: what to look at first, and why.
import { nodeCube, type Dataset } from './cube.ts'
import { AUDIT_LABEL, runAudit, type AuditFinding, type AuditResult } from './audit.ts'
import { computeAccuracy, computeMetrics, DEFAULTS, nervousBand, spread, stepSeries, type Accuracy, type Metrics, type Options } from './metrics.ts'

export interface Finding {
  id: string
  kind: 'stability' | 'disaggregation'
  tag: string
  node: number
  parent: number
  title: string
  path: string
  reason: string
  units: number
  impact: number
  severity: 'high' | 'medium' | 'low'
  verdict: 'signal' | 'noise' | 'thin' | null
  audit?: AuditFinding
  also: { tag: string; reason: string; units: number }[] // other findings on the same item, so one item takes one row
}
export interface NodeStats extends Metrics { leafNervousness: number; netting: number }
export interface Summary {
  volume: number
  latestUnits: number
  latestNet: number
  latestPct: number
  frozenUnits: number
  frozenPct: number
  noiseUnits: number
  signalUnits: number
  thinUnits: number
  splitUnits: number // moved by a share jump under a flat parent: neither demand signal nor habitual noise
  bands: { calm: number; watch: number; nervous: number }
  distorted: number
  distortedPct: number
  accuracy: Accuracy | null
  flipUnits: number
}
export interface Analysis { nodes: NodeStats[]; audit: AuditResult; findings: Finding[]; summary: Summary; opts: Options; pool: { horizon: number; frozen: number } }

export const fmtQty = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 }))
export const fmtPct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`
export const pathOf = (ds: Dataset, node: number) => {
  const parts: string[] = []
  for (let n = ds.nodes[node].parent; n > 0; n = ds.nodes[n].parent) parts.unshift(ds.nodes[n].label)
  return parts.join(' / ')
}
const sigma = (z: number) => (Math.abs(z) > 10 ? 'more than 10σ' : `${Math.abs(z).toFixed(1)}σ`)
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`

const AUDIT_WEIGHT: Record<AuditFinding['type'], number> = { sum_mismatch: 1.5, inactive_item: 1.5, share_jump: 1.2, mix_divergence: 1, new_item: 0.8, intermittent_smear: 0.8, rounding_loss: 0.6 }

function auditReason(ds: Dataset, f: AuditFinding): string {
  const parentPath = pathOf(ds, f.parent)
  const parent = parentPath ? `${parentPath} / ${ds.nodes[f.parent].label}` : ds.nodes[f.parent].label
  const child = f.child > -1 ? ds.nodes[f.child].label : ''
  const qty = fmtQty(f.qtyLatest)
  const periods = plural(f.periods.length, 'period')
  const recurring = f.snapshotsHit > 1 ? ` This has now happened in ${f.snapshotsHit} snapshots.` : ''
  switch (f.type) {
    case 'sum_mismatch':
      return `${parent}'s stated total is ${f.signedLatest > 0 ? 'higher' : 'lower'} than its items add up to by ${qty} units across ${periods}, so whoever plans from the items sees a different number from whoever reads the total.${recurring}`
    case 'rounding_loss':
      return `Rounding to ${f.lot && f.lot > 1 ? `lots of ${f.lot}` : 'whole units'} ${f.signedLatest > 0 ? 'dropped' : 'added'} ${qty} units from ${parent} across ${periods}. Small per bucket, but it always falls the same way.${recurring}`
    case 'share_jump':
      return `${child}'s share of ${parent} went ${f.signedLatest > 0 ? 'up' : 'down'} from ${fmtPct(f.shareBefore ?? 0, 0)} to ${fmtPct(f.shareAfter ?? 0, 0)} while the ${parent} total stayed flat, moving ${qty} units with no demand change above it.${recurring}`
    case 'new_item':
      return `${child} has no sales history but was handed ${qty} units. Fine if this is a real launch, otherwise the split is feeding an item nobody is selling.`
    case 'inactive_item':
      return `${child} has sold nothing for at least 6 periods, yet the split still gives it ${qty} units. That volume is probably missing from the items that do sell.`
    case 'intermittent_smear':
      return f.zeroRate !== undefined
        ? `${child} has zero demand in ${fmtPct(f.zeroRate, 0)} of past periods, but the plan spreads a little into almost every bucket. ${qty} units sit in buckets that usually sell nothing.`
        : `${child} gets fractional quantities in most buckets, a sign that a small total is being sliced thin. ${qty} units are fractions of a unit.`
    case 'mix_divergence':
      return `The plan gives ${child} ${fmtPct(f.shareAfter ?? 0, 0)} of ${parent}, but it has actually sold ${fmtPct(f.shareBefore ?? 0, 0)} over the last 12 periods. That is ${qty} units allocated against the actual mix.`
  }
}

function stabilityReason(m: Metrics, frozenDays: number, acc: Accuracy | null, reallocated: boolean): string {
  const parts: string[] = []
  if (m.frozenUnitsLatest > 0) parts.push(`The next ${frozenDays} days were revised by ${fmtQty(m.frozenUnitsLatest)} units (${fmtPct(m.frozenChurnLatest, 0)}) in the latest snapshot.`)
  else parts.push(`The forecast moved ${fmtPct(m.revWape, 0)} per snapshot on average.`)
  if (m.flipCount >= 2) parts.push(`Across its target periods it reversed direction ${plural(m.flipCount, 'time')}, so ${fmtQty(m.flipUnits)} units were revised and then undone.`)
  if (m.noise.verdict === 'signal' && reallocated) {
    parts.push(`That is ${sigma(m.noise.z)} outside its usual revisions, but the total above it barely moved, so this looks like volume reallocated between siblings rather than a change in demand.`)
  } else if (m.noise.verdict === 'signal') {
    parts.push(m.noise.sustained
      ? `Three straight ${m.noise.z > 0 ? 'increases' : 'cuts'} add up to ${sigma(m.noise.z)} against its usual revisions, so treat this as a real shift.`
      : `That is ${sigma(m.noise.z)} outside its usual revisions, so treat this as a real change, not noise.`)
  } else if (m.noise.verdict === 'noise') {
    parts.push(`This is within its usual range (${sigma(m.noise.z)}), so it is habitual churn, not news.`)
  }
  if (acc?.verdict === 'hurt') parts.push(`Revisions have made accuracy worse by ${(Math.abs(acc.fvaOfRevisions) * 100).toFixed(1)} points.`)
  if (acc?.verdict === 'helped') parts.push(`Revisions have improved accuracy by ${(acc.fvaOfRevisions * 100).toFixed(1)} points, so this churn is earning its keep.`)
  return parts.join(' ')
}

export function analyze(ds: Dataset, opts: Options = DEFAULTS): Analysis {
  const last = ds.S - 1
  // The historic spread of revisions across the portfolio, excluding the latest step so it cannot excuse itself.
  const poolH: number[] = [], poolF: number[] = []
  for (const n of ds.leafNode) {
    const q = nodeCube(ds, n).q
    poolH.push(...stepSeries(ds, q, null).slice(0, -1).filter(Number.isFinite))
    poolF.push(...stepSeries(ds, q, opts.frozenDays).slice(0, -1).filter(Number.isFinite))
  }
  const pool = { horizon: spread(poolH), frozen: spread(poolF) }
  const base = ds.nodes.map((n) => computeMetrics(ds, n.idx, opts, pool))
  const nodes: NodeStats[] = ds.nodes.map((n, i) => {
    let vol = 0, wtd = 0, leafUnits = 0
    for (const lf of n.leaves) {
      const m = base[ds.leafNode[lf]]
      const w = Math.max(m.volume, 1e-9)
      vol += w; wtd += w * m.nervousness; leafUnits += m.totalChurnUnits
    }
    return { ...base[i], leafNervousness: vol ? wtd / vol : 0, netting: leafUnits > 0 ? Math.max(0, 1 - base[i].totalChurnUnits / leafUnits) : 0 }
  })
  const audit = runAudit(ds, opts)
  const root = nodes[0]
  const volume = Math.max(root.volume, 1)
  const raw: Finding[] = []
  const splitByLeaf = new Map<number, number>()
  for (const f of audit.findings) if (f.type === 'share_jump' && f.qtyLatest > 0 && ds.nodes[f.child].leaf > -1) splitByLeaf.set(f.child, f.qtyLatest)
  let splitUnits = 0
  let noiseUnits = 0, signalUnits = 0, thinUnits = 0, latestUnits = 0, frozenUnits = 0, frozenVol = 0, flipUnits = 0
  const bands = { calm: 0, watch: 0, nervous: 0 }
  for (const nodeIdx of ds.leafNode) {
    const m = nodes[nodeIdx]
    const lastStep = m.stepUnits.length ? m.stepUnits[m.stepUnits.length - 1] : 0
    latestUnits += lastStep; frozenUnits += m.frozenUnitsLatest; frozenVol += m.frozenVolumeLatest; flipUnits += m.flipUnits
    const split = Math.min(lastStep, splitByLeaf.get(nodeIdx) ?? 0)
    splitUnits += split
    if (m.noise.verdict === 'signal') signalUnits += lastStep - split
    else if (m.noise.verdict === 'thin') thinUnits += lastStep - split
    else noiseUnits += lastStep - split
    bands[nervousBand(m.nervousness)]++
    const interesting = m.nervousness >= 20 || m.noise.verdict === 'signal'
    const atStake = m.frozenUnitsLatest * 2 + Math.max(0, lastStep - m.frozenUnitsLatest) + m.flipUnits / Math.max(1, last)
    if (!interesting || atStake < volume * 2e-4) continue
    const acc = ds.hasActuals ? computeAccuracy(ds, nodeIdx) : null
    const impact = atStake * (0.5 + m.nervousness / 100)
    const parentStep = nodes[ds.nodes[nodeIdx].parent].stepSigned
    const parentLast = parentStep.length ? parentStep[parentStep.length - 1] : NaN
    const reallocated = m.noise.verdict === 'signal' && ds.nodes[nodeIdx].parent !== 0 && Math.abs(parentLast) <= opts.parentFlatPct
    const tag = reallocated ? 'Reallocated, flat parent' : m.noise.verdict === 'signal' ? 'Real change' : m.flipCount >= 2 ? 'Flip-flopping' : 'Near-term churn'
    raw.push({ id: `s${nodeIdx}`, kind: 'stability', tag, node: nodeIdx, parent: ds.nodes[nodeIdx].parent, title: ds.nodes[nodeIdx].label, path: pathOf(ds, nodeIdx), reason: stabilityReason(m, opts.frozenDays, acc, reallocated), units: lastStep, impact, severity: 'low', verdict: m.noise.verdict, also: [] })
  }
  for (const f of audit.findings) {
    if (f.qtyLatest <= 0 || f.qtyLatest < volume * 1e-4) continue
    const node = f.child > -1 ? f.child : f.parent
    const path = pathOf(ds, node)
    const title = f.child > -1 || !path ? ds.nodes[node].label : `${path} / ${ds.nodes[node].label}`
    raw.push({ id: `a${f.type}${f.parent}:${f.child}`, kind: 'disaggregation', tag: AUDIT_LABEL[f.type], node, parent: f.parent, title, path, reason: auditReason(ds, f), units: f.qtyLatest, impact: f.qtyLatest * AUDIT_WEIGHT[f.type], severity: 'low', verdict: null, audit: f, also: [] })
  }
  // One row per item. If the split is implicated it leads, because that explains the rest of the movement.
  const byNode = new Map<number, Finding[]>()
  for (const f of raw) byNode.set(f.node, [...(byNode.get(f.node) ?? []), f])
  const findings: Finding[] = []
  for (const group of byNode.values()) {
    group.sort((a, b) => Number(b.kind === 'disaggregation') - Number(a.kind === 'disaggregation') || b.impact - a.impact)
    const [head, ...rest] = group
    findings.push({
      ...head,
      impact: Math.max(...group.map((f) => f.impact)),
      verdict: ds.nodes[head.node].leaf > -1 ? nodes[head.node].noise.verdict : null,
      also: rest.map((f) => ({ tag: f.tag, reason: f.reason, units: f.units })),
    })
  }
  findings.sort((a, b) => b.impact - a.impact)
  for (const f of findings) f.severity = f.impact / volume >= 0.01 ? 'high' : f.impact / volume >= 0.0025 ? 'medium' : 'low'
  const summary: Summary = {
    volume: root.volume,
    latestUnits,
    latestNet: root.stepNet.length ? root.stepNet[root.stepNet.length - 1] : 0,
    latestPct: latestUnits / volume,
    frozenUnits,
    frozenPct: frozenVol > 0 ? frozenUnits / frozenVol : 0,
    noiseUnits, signalUnits, thinUnits, splitUnits, bands,
    distorted: audit.uniqueDistorted,
    distortedPct: audit.uniqueDistorted / volume,
    accuracy: ds.hasActuals ? computeAccuracy(ds, 0) : null,
    flipUnits,
  }
  return { nodes, audit, findings, summary, opts, pool }
}
