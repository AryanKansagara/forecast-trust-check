import type { Dataset } from './cube.ts'
import { nervousBand } from './metrics.ts'
import { pathOf, type Analysis } from './rank.ts'

// A leading = + - @ turns a cell into a formula in Excel, and these labels come from uploaded files.
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toFixed(4))) : ''
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

export function findingsCsv(ds: Dataset, an: Analysis): string {
  const rows: (string | number | null)[][] = [['rank', 'severity', 'type', 'finding', 'item_or_node', 'path', 'units', 'impact_score', 'noise_test', 'periods_affected', 'snapshots_hit', 'reason', 'also_flagged']]
  an.findings.forEach((f, i) => rows.push([i + 1, f.severity, f.kind, f.tag, f.title, pathOf(ds, f.node), f.units, f.impact, f.verdict ?? '', f.audit ? f.audit.periods.length : '', f.audit ? f.audit.snapshotsHit : '', f.reason, f.also.map((a) => `${a.tag}: ${a.reason}`).join(' | ')]))
  return toCsv(rows)
}

export function itemsCsv(ds: Dataset, an: Analysis): string {
  const rows: (string | number | null)[][] = [['item', 'path', 'horizon_volume', 'nervousness', 'band', 'frozen_churn_pct_latest', 'frozen_units_latest', 'revision_wape_pct', 'cov_pct', 'flip_count', 'flip_units', 'bias_drift_pct_per_step', 'noise_verdict', 'noise_z']]
  for (const n of ds.leafNode) {
    const m = an.nodes[n]
    rows.push([ds.nodes[n].label, pathOf(ds, n), m.volume, m.nervousness, nervousBand(m.nervousness), m.frozenChurnLatest * 100, m.frozenUnitsLatest, m.revWape * 100, m.cov * 100, m.flipCount, m.flipUnits, m.driftPct * 100, m.noise.verdict, m.noise.z])
  }
  return toCsv(rows)
}
