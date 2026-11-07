// Hand-rolled SVG and HTML charts. Colours come from CSS tokens, so light, dark and print each get their own selected steps.
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { inWindow, isLive, lagOf, nodeCube, type Dataset } from './engine/cube.ts'
import { disaggFlow, type Flow } from './engine/audit.ts'
import { nervousBand, type Accuracy, type LagRow, type Metrics } from './engine/metrics.ts'
import { fmtPct, fmtQty, type NodeStats } from './engine/rank.ts'
import { squarify } from './engine/layout.ts'

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fmtDay = (iso: string) => `${+iso.slice(8, 10)} ${MONTH[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}`
export const fmtPeriod = (ds: Dataset, iso: string) => (ds.gapDays >= 27 ? `${MONTH[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}` : `${+iso.slice(8, 10)} ${MONTH[+iso.slice(5, 7) - 1]}`)

// Signed revision: amber down, teal up, neutral at zero. Square root so that small moves stay visible next to huge ones.
export function divergeFill(pct: number, full = 0.3): string {
  if (!Number.isFinite(pct)) return 'var(--cell-empty)'
  const t = Math.round(Math.min(1, Math.sqrt(Math.abs(pct) / full)) * 100)
  return `color-mix(in oklab, var(${pct >= 0 ? '--up' : '--down'}) ${t}%, var(--cell0))`
}
// Unsigned magnitude: one hue, light to dark.
export function heatFill(x: number, full = 0.3): string {
  const t = Math.round(Math.min(1, Math.sqrt(Math.max(0, x) / full)) * 100)
  return `color-mix(in oklab, var(--nerv) ${t}%, var(--cell0))`
}
export const nervFill = (n: number) => `color-mix(in oklab, var(--nerv) ${Math.round(Math.min(1, n / 75) * 100)}%, var(--cell0))`

// One tooltip for many marks: anything with data-tip inside this wrapper shows it. Far cheaper than a handler on each cell.
export function TipLayer({ children, className }: { children: ReactNode; className?: string }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  return (
    <div
      className={className}
      onMouseMove={(e) => {
        const t = (e.target as Element).closest?.('[data-tip]')
        const text = t?.getAttribute('data-tip')
        setTip(text ? { x: e.clientX, y: e.clientY, text } : null)
      }}
      onMouseLeave={() => setTip(null)}
    >
      {children}
      {tip && (
        <div className="tip" role="status" style={{ left: Math.min(tip.x + 14, innerWidth - 300), top: Math.max(8, tip.y - 12) }}>
          {tip.text.split('\n').map((l, i) => <div key={i} className={i ? '' : 'tip-head'}>{l}</div>)}
        </div>
      )}
    </div>
  )
}

export function Sparkline({ values, width = 92, height = 24 }: { values: number[]; width?: number; height?: number }) {
  const v = values.filter(Number.isFinite)
  if (v.length < 2) return <span className="muted">n/a</span>
  const mn = Math.min(...v), mx = Math.max(...v), span = mx - mn || 1
  const pts = v.map((y, i) => [(i / (v.length - 1)) * (width - 6) + 2, height - 3 - ((y - mn) / span) * (height - 6)])
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg width={width} height={height} className="spark" aria-hidden="true">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.5" fill="currentColor" />
    </svg>
  )
}

export function NervMeter({ value }: { value: number }) {
  const band = nervousBand(value)
  return (
    <span className="nerv-meter" title={`Nervousness ${value.toFixed(0)} of 100: ${band}`}>
      <span className="nerv-track"><span className="nerv-fill" style={{ width: `${Math.min(100, value)}%`, background: nervFill(value) }} /></span>
      <b>{value.toFixed(0)}</b>
    </span>
  )
}

const BAND_LABEL = { calm: 'Calm', watch: 'Watch', nervous: 'Nervous' }
export const BandChip = ({ value }: { value: number }) => { const b = nervousBand(value); return <span className={`chip band-${b}`}><i aria-hidden="true" />{BAND_LABEL[b]}</span> }
export const VerdictChip = ({ verdict }: { verdict: Metrics['noise']['verdict'] | null }) => {
  if (!verdict) return null
  const t = { signal: 'Outside normal range', noise: 'Within normal range', thin: 'Too little history' }[verdict]
  return <span className={`chip verdict-${verdict}`}><i aria-hidden="true" />{t}</span>
}

// The forecast waterfall: each row is a snapshot, each column a target period, each cell what that snapshot said.
export function Waterfall({ ds, node, frozenDays, mode, compact }: { ds: Dataset; node: number; frozenDays: number; mode: 'revision' | 'quantity'; compact?: boolean }) {
  const { q, a } = nodeCube(ds, node)
  const { S, P } = ds
  const cols = useMemo(() => {
    const out: number[] = []
    for (let p = 0; p < P; p++) {
      let any = false
      for (let s = 0; s < S && !any; s++) any = isLive(ds, s, p) && !Number.isNaN(q[s * P + p])
      if (any) out.push(p)
    }
    return out
  }, [ds, q, S, P])
  const maxQ = useMemo(() => { let m = 0; for (let i = 0; i < q.length; i++) if (q[i] > m) m = q[i]; return m || 1 }, [q])
  const cw = compact ? 14 : Math.max(14, Math.min(30, 900 / Math.max(1, cols.length)))
  const ch = compact ? 11 : Math.max(14, Math.min(24, 440 / Math.max(1, S)))
  const lx = 66, ty = 40, rowsH = ch * S, showActual = ds.hasActuals
  const W = lx + cw * cols.length + 40
  const H = ty + rowsH + (showActual ? ch + 10 : 2) + 2
  const every = Math.ceil(30 / cw)
  // The frozen window drawn as a staircase running down the triangle.
  const stair: string[] = []
  cols.length && Array.from({ length: S }, (_, s) => {
    let last = -1
    cols.forEach((p, i) => { if (inWindow(ds, s, p, frozenDays)) last = i })
    if (last > -1) { const x = lx + (last + 1) * cw; stair.push(`${x},${ty + s * ch}`, `${x},${ty + (s + 1) * ch}`) }
  })
  return (
    <TipLayer className="chart-scroll">
      <svg width={W} height={H} className="waterfall" role="img" aria-label={`Forecast waterfall with ${S} snapshots across ${cols.length} periods`}>
        {cols.map((p, i) => i % every === 0 && <text key={p} x={lx + i * cw + cw / 2} y={ty - 8} className="axis" textAnchor="start" transform={`rotate(-40 ${lx + i * cw + cw / 2} ${ty - 8})`}>{fmtPeriod(ds, ds.periods[p])}</text>)}
        {Array.from({ length: S }, (_, s) => (
          <g key={s}>
            {(s === S - 1 || (s % Math.ceil(13 / ch) === 0 && (S - 1 - s) * ch >= 13)) && <text x={lx - 8} y={ty + s * ch + ch / 2 + 3} textAnchor="end" className="axis">{fmtDay(ds.snapshots[s]).slice(0, -3)}</text>}
            {cols.map((p, i) => {
              const v = q[s * P + p]
              if (Number.isNaN(v) || !isLive(ds, s, p)) return null
              const prev = s > 0 ? q[(s - 1) * P + p] : NaN
              const d = v - prev
              const pct = prev > 0 ? d / prev : NaN
              const fill = mode === 'quantity' ? `color-mix(in oklab, var(--seq) ${Math.round((v / maxQ) * 100)}%, var(--cell0))` : Number.isNaN(pct) ? 'var(--cell0)' : divergeFill(pct)
              const tip = `${fmtPeriod(ds, ds.periods[p])}, as of ${fmtDay(ds.snapshots[s])}\nForecast ${fmtQty(v)} (lag ${lagOf(ds, s, p)})\n${Number.isNaN(pct) ? 'First version of this period' : `Revision ${d >= 0 ? '+' : ''}${fmtQty(d)} (${(pct * 100).toFixed(1)}%)`}`
              return <rect key={p} x={lx + i * cw + 0.5} y={ty + s * ch + 0.5} width={cw - 1} height={ch - 1} rx="2" fill={fill} data-tip={tip} />
            })}
          </g>
        ))}
        <polyline points={stair.join(' ')} fill="none" className="stair" />
        {showActual && <>
          <text x={lx - 8} y={ty + rowsH + 10 + ch / 2 + 3} textAnchor="end" className="axis">Actual</text>
          {cols.map((p, i) => {
            const v = a[p]
            if (Number.isNaN(v)) return null
            return <rect key={p} x={lx + i * cw + 0.5} y={ty + rowsH + 10.5} width={cw - 1} height={ch - 1} rx="2" className="actual-cell" data-tip={`${fmtPeriod(ds, ds.periods[p])}\nActual ${fmtQty(v)}`} />
          })}
        </>}
      </svg>
    </TipLayer>
  )
}

export function WaterfallLegend({ mode, frozenDays }: { mode: 'revision' | 'quantity'; frozenDays: number }) {
  return (
    <div className="legend">
      {mode === 'revision'
        ? <><span className="ramp ramp-div" aria-hidden="true" /><span>Cut 30% or more</span><span className="legend-mid">no change</span><span>Raised 30% or more</span></>
        : <><span className="ramp ramp-seq" aria-hidden="true" /><span>Low to high quantity</span></>}
      <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><path d="M1 9V5h8V1h8" fill="none" className="stair" /></svg>Edge of next {frozenDays} days</span>
    </div>
  )
}

// Revision fan: every version of the forecast overlaid, so spread is visible at a glance.
export function FanChart({ ds, node, height = 240 }: { ds: Dataset; node: number; height?: number }) {
  const { q, a } = nodeCube(ds, node)
  const { S, P } = ds
  const W = 640, H = height, L = 52, R = 14, T = 12, B = 26
  const cols: number[] = []
  for (let p = 0; p < P; p++) { let any = false; for (let s = 0; s < S; s++) if (isLive(ds, s, p) && !Number.isNaN(q[s * P + p])) any = true; if (any) cols.push(p) }
  if (!cols.length) return <p className="muted">No live forecast cells for this node.</p>
  const x = (i: number) => L + (i / Math.max(1, cols.length - 1)) * (W - L - R)
  let mx = 0
  for (const p of cols) { for (let s = 0; s < S; s++) { const v = q[s * P + p]; if (isLive(ds, s, p) && v > mx) mx = v } if (a[p] > mx) mx = a[p] }
  mx = mx * 1.06 || 1
  const y = (v: number) => T + (1 - v / mx) * (H - T - B)
  const ranges = cols.map((p) => {
    const vals: number[] = []
    for (let s = 0; s < S; s++) { const v = q[s * P + p]; if (isLive(ds, s, p) && !Number.isNaN(v)) vals.push(v) }
    return { lo: Math.min(...vals), hi: Math.max(...vals), n: vals.length }
  })
  const band = [...ranges.map((r, i) => `${x(i)},${y(r.hi)}`), ...[...ranges].reverse().map((r, i) => `${x(ranges.length - 1 - i)},${y(r.lo)}`)].join(' ')
  const lines = Array.from({ length: S }, (_, s) => {
    const pts: string[] = []
    cols.forEach((p, i) => { const v = q[s * P + p]; if (isLive(ds, s, p) && !Number.isNaN(v)) pts.push(`${x(i)},${y(v)}`) })
    return pts.join(' ')
  })
  const ticks = [0, 0.5, 1].map((t) => t * mx)
  const every = Math.ceil(cols.length / 7)
  return (
    <TipLayer>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-fluid" role="img" aria-label={`Revision fan: ${S} forecast versions across ${cols.length} periods`}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 8} y={y(t) + 3} textAnchor="end" className="axis">{fmtQty(t)}</text></g>)}
        {cols.map((p, i) => i % every === 0 && <text key={p} x={x(i)} y={H - 8} textAnchor="middle" className="axis">{fmtPeriod(ds, ds.periods[p])}</text>)}
        <polygon points={band} className="fan-band" />
        {lines.map((pts, s) => s < S - 1 && <polyline key={s} points={pts} fill="none" className="fan-line" style={{ opacity: 0.16 + 0.5 * (s / Math.max(1, S - 1)) }} />)}
        <polyline points={lines[S - 1]} fill="none" className="fan-latest" />
        {cols.map((p, i) => !Number.isNaN(a[p]) && <circle key={p} cx={x(i)} cy={y(a[p])} r="4" className="fan-actual" />)}
        {cols.map((p, i) => {
          const r = ranges[i]
          const latest = q[(S - 1) * P + p]
          const hw = (W - L - R) / Math.max(1, cols.length - 1) / 2
          return <rect key={p} x={x(i) - hw} y={T} width={hw * 2} height={H - T - B} fill="transparent" data-tip={`${fmtPeriod(ds, ds.periods[p])}\n${r.n} versions, range ${fmtQty(r.lo)} to ${fmtQty(r.hi)}${Number.isNaN(latest) ? '' : `\nLatest ${fmtQty(latest)}`}${Number.isNaN(a[p]) ? '' : `\nActual ${fmtQty(a[p])}`}`} />
        })}
      </svg>
      <div className="legend">
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" rx="2" className="fan-band" /></svg>Range of all versions</span>
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" className="fan-line" style={{ opacity: 0.5 }} /></svg>Earlier snapshots</span>
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" className="fan-latest" /></svg>Latest snapshot</span>
        {ds.hasActuals && <span className="legend-key"><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" className="fan-actual" /></svg>Actual</span>}
      </div>
    </TipLayer>
  )
}

// Each snapshot's net revision against the band this item normally moves in. This is the noise test made visible.
export function RevisionBars({ ds, m, z }: { ds: Dataset; m: Metrics; z: number }) {
  const W = 640, H = 150, L = 46, R = 8, T = 10, B = 22
  const vals = m.noise.scope === 'frozen' ? m.frozenSigned : m.stepSigned
  const finite = vals.filter(Number.isFinite)
  if (!finite.length) return <p className="muted">Needs at least two snapshots.</p>
  const lim = Math.max(0.02, ...finite.map(Math.abs), z * m.noise.sigma) * 1.1
  const y = (v: number) => T + ((lim - v) / (2 * lim)) * (H - T - B)
  const bw = (W - L - R) / vals.length
  const band = z * m.noise.sigma
  return (
    <TipLayer>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-fluid" role="img" aria-label="Net revision per snapshot compared with the normal range">
        {m.noise.sigma > 0 && <rect x={L} width={W - L - R} y={y(band)} height={Math.max(0, y(-band) - y(band))} className="noise-band" />}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="zero" />
        <text x={L - 6} y={y(lim / 1.1) + 8} textAnchor="end" className="axis">+{(lim / 1.1 * 100).toFixed(0)}%</text>
        <text x={L - 6} y={y(-lim / 1.1)} textAnchor="end" className="axis">-{(lim / 1.1 * 100).toFixed(0)}%</text>
        {vals.map((v, i) => {
          if (!Number.isFinite(v)) return null
          const top = y(Math.max(v, 0)), h = Math.max(1.5, Math.abs(y(v) - y(0)))
          const isLast = i === vals.length - 1
          return <g key={i} data-tip={`${fmtDay(ds.snapshots[i + 1])}\nNet revision ${(v * 100).toFixed(1)}%`}>
            <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
            <rect x={L + i * bw + Math.max(1, bw * 0.16)} y={top} width={Math.max(2, bw * 0.68)} height={h} rx="2" className={isLast ? 'bar-latest' : v >= 0 ? 'bar-up' : 'bar-down'} />
          </g>
        })}
        <text x={L} y={H - 6} className="axis">{fmtDay(ds.snapshots[1])}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="axis">{fmtDay(ds.snapshots[ds.S - 1])}</text>
      </svg>
      <div className="legend">
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" className="noise-band" /></svg>Normal range ({z}σ, {m.noise.scope === 'frozen' ? 'near-term' : 'whole horizon'})</span>
        <span className="legend-key"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" className="bar-latest" /></svg>Latest revision</span>
      </div>
    </TipLayer>
  )
}

export function LagChart({ rows, title }: { rows: LagRow[]; title: string }) {
  const show = rows.filter((r) => Number.isFinite(r.wape)).slice(0, 18)
  if (!show.length) return <p className="muted">No completed periods with both a forecast and an actual.</p>
  const W = 640, H = 200, L = 40, R = 8, T = 10, B = 34
  const mx = Math.max(0.05, ...show.map((r) => r.wape), ...show.map((r) => (Number.isFinite(r.naiveWape) ? r.naiveWape : 0))) * 1.1
  const y = (v: number) => T + (1 - v / mx) * (H - T - B)
  const bw = (W - L - R) / show.length
  return (
    <TipLayer>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-fluid" role="img" aria-label={title}>
        {[0, 0.5, 1].map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t * mx)} y2={y(t * mx)} className="grid" /><text x={L - 6} y={y(t * mx) + 3} textAnchor="end" className="axis">{(t * mx * 100).toFixed(0)}%</text></g>)}
        {show.map((r, i) => (
          <g key={r.lag} data-tip={`Lag ${r.lag}\nError ${fmtPct(r.wape)}, bias ${(r.bias * 100).toFixed(1)}%${Number.isFinite(r.naiveWape) ? `\nNaive ${fmtPct(r.naiveWape)}` : ''}\n${r.n} forecasts`}>
            <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
            <rect x={L + i * bw + bw * 0.18} y={y(r.wape)} width={bw * 0.64} height={Math.max(1, y(0) - y(r.wape))} rx="3" className="bar-lag" />
            {Number.isFinite(r.naiveWape) && <line x1={L + i * bw + bw * 0.06} x2={L + i * bw + bw * 0.94} y1={y(r.naiveWape)} y2={y(r.naiveWape)} className="naive-tick" />}
            {(show.length <= 12 || i % 2 === 0) && <text x={L + i * bw + bw / 2} y={H - B + 14} textAnchor="middle" className="axis">{r.lag}</text>}
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" className="axis">Buckets ahead when the forecast was made (lag)</text>
      </svg>
      <div className="legend">
        <span className="legend-key"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" className="bar-lag" /></svg>Forecast error (WAPE)</span>
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" className="naive-tick" /></svg>Naive: repeat last actual</span>
      </div>
    </TipLayer>
  )
}

export const accuracyLine = (a: Accuracy) => {
  if (a.verdict === 'none') return 'No completed periods to score yet.'
  const p = (x: number) => `${(Math.abs(x) * 100).toFixed(1)} points`
  if (a.verdict === 'helped') return `Revisions improved accuracy: error fell ${p(a.fvaOfRevisions)}, from ${fmtPct(a.wapeFirst)} on the first version to ${fmtPct(a.wapeFinal)} on the last.`
  if (a.verdict === 'hurt') return `Revisions made accuracy worse: error rose ${p(a.fvaOfRevisions)}, from ${fmtPct(a.wapeFirst)} on the first version to ${fmtPct(a.wapeFinal)} on the last.`
  return `Revisions made no real difference: error went from ${fmtPct(a.wapeFirst)} on the first version to ${fmtPct(a.wapeFinal)} on the last.`
}

// Drill-down treemap: area is volume, colour is the volume-weighted nervousness of the items underneath.
export function Treemap({ ds, nodes, root, onDrill, onItem, selected }: { ds: Dataset; nodes: NodeStats[]; root: number; onDrill: (n: number) => void; onItem: (n: number) => void; selected: number }) {
  const kids = ds.nodes[root].children.filter((c) => nodes[c].volume > 0)
  const rects = squarify(kids.map((c) => nodes[c].volume), 1000, 560)
  const crumbs: number[] = []
  for (let n = root; n !== -1; n = ds.nodes[n].parent) crumbs.unshift(n)
  const here = nodes[root]
  return (
    <div>
      <nav className="crumbs" aria-label="Hierarchy path">
        {crumbs.map((c, i) => <span key={c}>{i > 0 && <span aria-hidden="true"> / </span>}<button type="button" className="crumb" disabled={c === root} onClick={() => onDrill(c)}>{ds.nodes[c].label}</button></span>)}
      </nav>
      <div className="treemap" key={root}>
        {rects.map((r) => {
          const c = kids[r.i]
          const m = nodes[c]
          const n = ds.nodes[c]
          const dark = m.leafNervousness >= 60
          const small = r.w * r.h < 18000
          return (
            <button
              type="button"
              key={c}
              className={`tile${dark ? ' tile-dark' : ''}${selected === c ? ' tile-sel' : ''}`}
              style={{ left: `${r.x / 10}%`, top: `${(r.y / 560) * 100}%`, width: `${r.w / 10}%`, height: `${(r.h / 560) * 100}%`, background: nervFill(m.leafNervousness) }}
              onClick={() => (n.leaf > -1 ? onItem(c) : onDrill(c))}
              title={`${n.label}: volume ${fmtQty(m.volume)}, nervousness ${m.leafNervousness.toFixed(0)}`}
            >
              <b>{n.label}</b>
              {!small && <span>{fmtQty(m.volume)} units</span>}
              {!small && <span>Nervousness {m.leafNervousness.toFixed(0)}</span>}
              {!small && n.leaf === -1 && m.netting > 0.25 && <span className="tile-note">{fmtPct(m.netting, 0)} of item churn nets out here</span>}
            </button>
          )
        })}
      </div>
      <div className="legend">
        <span className="ramp ramp-nerv" aria-hidden="true" /><span>Calm to nervous</span>
        <span className="legend-key">Area shows forecast volume. {root !== 0 || here.netting <= 0.25 ? '' : `At the top level, ${fmtPct(here.netting, 0)} of item-level movement cancels out and looks stable.`}</span>
      </div>
    </div>
  )
}

// Parent-to-children split between two snapshots. Grey ribbons kept their place; coloured ribbons changed hands.
export function Sankey({ ds, flow, labelA, labelB }: { ds: Dataset; flow: Flow; labelA: string; labelB: string }) {
  const W = 860, gap = 12, top = 30, bar = 14, pad = 190
  const kids = [...flow.children].sort((a, b) => Math.max(b.a, b.b) - Math.max(a.a, a.b))
  const hasAdd = flow.added > 0, hasCut = flow.removed > 0
  const rows = kids.length + 1
  const avail = 400
  const total = Math.max(flow.totalA + flow.added, flow.totalB + flow.removed) || 1
  const scale = (avail - gap * (rows - 1)) / total
  const ref = useRef<SVGSVGElement>(null)
  const leftY = new Map<number, number>(), rightY = new Map<number, number>()
  let ly = top, ry = top
  const leftCur = new Map<number, number>(), rightCur = new Map<number, number>()
  for (const c of kids) { leftY.set(c.node, ly); leftCur.set(c.node, ly); ly += c.a * scale + gap; rightY.set(c.node, ry); rightCur.set(c.node, ry); ry += c.b * scale + gap }
  if (hasAdd) { leftY.set(-1, ly); leftCur.set(-1, ly) }
  if (hasCut) { rightY.set(-1, ry); rightCur.set(-1, ry) }
  const H = Math.max(ly + flow.added * scale, ry + flow.removed * scale) + 20
  const order = new Map(kids.map((c, i) => [c.node, i]))
  const links = [...flow.links].sort((a, b) => (order.get(a.from) ?? 99) - (order.get(b.from) ?? 99) || (order.get(a.to) ?? 99) - (order.get(b.to) ?? 99))
  const x0 = pad + bar, x1 = W - pad - bar, mid = (x0 + x1) / 2
  const label = (n: number) => (n === -1 ? '' : ds.nodes[n].label)
  return (
    <TipLayer className="chart-scroll">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="sankey" role="img" aria-label={`Split of ${ds.nodes[flow.parent].label} from ${labelA} to ${labelB}`}>
        <text x={pad} y={16} className="axis-strong" textAnchor="end">{labelA}: {fmtQty(flow.totalA)}</text>
        <text x={W - pad} y={16} className="axis-strong">{labelB}: {fmtQty(flow.totalB)}</text>
        {links.map((l, i) => {
          const h = l.qty * scale
          const a = leftCur.get(l.from) ?? 0, b = rightCur.get(l.to) ?? 0
          leftCur.set(l.from, a + h); rightCur.set(l.to, b + h)
          const kept = l.from === l.to
          const d = `M${x0},${a} C${mid},${a} ${mid},${b} ${x1},${b} L${x1},${b + h} C${mid},${b + h} ${mid},${a + h} ${x0},${a + h} Z`
          const name = l.from === -1 ? `Parent increase to ${label(l.to)}` : l.to === -1 ? `${label(l.from)} to parent decrease` : kept ? `${label(l.from)} kept` : `${label(l.from)} to ${label(l.to)}`
          return <path key={i} d={d} className={kept ? 'ribbon-kept' : l.from === -1 || l.to === -1 ? 'ribbon-parent' : 'ribbon-moved'} data-tip={`${name}\n${fmtQty(l.qty)} units`} />
        })}
        {kids.map((c) => (
          <g key={c.node}>
            <rect x={pad} y={leftY.get(c.node)} width={bar} height={Math.max(1, c.a * scale)} rx="2" className="sankey-node" />
            <rect x={W - pad - bar} y={rightY.get(c.node)} width={bar} height={Math.max(1, c.b * scale)} rx="2" className="sankey-node" />
            <text x={pad - 8} y={leftY.get(c.node)! + 11} textAnchor="end" className="axis-strong">{trim(ds.nodes[c.node].label)}</text>
            <text x={pad - 8} y={leftY.get(c.node)! + 24} textAnchor="end" className="axis">{fmtQty(c.a)} · {fmtPct(c.shareA, 0)}</text>
            <text x={W - pad + 8} y={rightY.get(c.node)! + 11} className="axis-strong">{trim(ds.nodes[c.node].label)}</text>
            <text x={W - pad + 8} y={rightY.get(c.node)! + 24} className="axis">{fmtQty(c.b)} · {fmtPct(c.shareB, 0)}</text>
          </g>
        ))}
        {hasAdd && <><rect x={pad} y={leftY.get(-1)} width={bar} height={Math.max(1, flow.added * scale)} rx="2" className="sankey-parent" /><text x={pad - 8} y={leftY.get(-1)! + 11} textAnchor="end" className="axis-strong">Parent grew {fmtQty(flow.added)}</text></>}
        {hasCut && <><rect x={W - pad - bar} y={rightY.get(-1)} width={bar} height={Math.max(1, flow.removed * scale)} rx="2" className="sankey-parent" /><text x={W - pad + 8} y={rightY.get(-1)! + 11} className="axis-strong">Parent shrank {fmtQty(flow.removed)}</text></>}
      </svg>
      <div className="legend">
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" rx="2" className="ribbon-kept" /></svg>Stayed with the same child</span>
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" rx="2" className="ribbon-moved" /></svg>Moved between children</span>
        <span className="legend-key"><svg width="18" height="10" aria-hidden="true"><rect width="18" height="10" rx="2" className="ribbon-parent" /></svg>Parent total changed</span>
      </div>
    </TipLayer>
  )
}
const trim = (s: string) => (s.length > 24 ? s.slice(0, 23) + '…' : s)

export { disaggFlow }
