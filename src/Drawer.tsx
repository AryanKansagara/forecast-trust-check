import { useEffect, useRef } from 'react'
import type { Dataset } from './engine/cube.ts'
import { computeAccuracy, nervousBand } from './engine/metrics.ts'
import { fmtPct, fmtQty, pathOf, type Analysis, type Finding } from './engine/rank.ts'
import { accuracyLine, BandChip, FanChart, LagChart, RevisionBars, Sparkline, VerdictChip, Waterfall, WaterfallLegend } from './charts.tsx'

const METRICS: { label: string; tip: string; get: (m: Analysis['nodes'][number]) => string }[] = [
  { label: 'Next-window churn', tip: 'Units revised inside the frozen window in the latest snapshot, over the prior forecast for those periods.', get: (m) => fmtPct(m.frozenChurnLatest) },
  { label: 'Revision (MAPE-style)', tip: 'Sum of absolute revisions between consecutive snapshots over the sum of prior forecasts, all live periods.', get: (m) => fmtPct(m.revWape) },
  { label: 'COV, change over versions', tip: 'For each target period, the standard deviation of all its versions over their mean, volume weighted.', get: (m) => fmtPct(m.cov) },
  { label: 'Flip-flops', tip: 'Meaningful revisions followed by a meaningful revision in the opposite direction, counted across target periods.', get: (m) => `${m.flipCount} (${fmtQty(m.flipUnits)} units)` },
  { label: 'Bias drift per snapshot', tip: 'Average net revision per snapshot. Consistently one-sided revisions mean the forecast is walking, not wobbling.', get: (m) => `${m.driftPct >= 0 ? '+' : ''}${(m.driftPct * 100).toFixed(1)}%` },
  { label: 'One-way share', tip: 'Share of snapshots whose net revision went in the dominant direction.', get: (m) => fmtPct(m.sameSignShare, 0) },
]

export function Drawer({ ds, an, node, finding, onClose, onStep }: { ds: Dataset; an: Analysis; node: number | null; finding: Finding | null; onClose: () => void; onStep: (d: number) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (node !== null && !d.open) { d.showModal(); d.querySelector<HTMLElement>('.drawer-close')?.focus() }
    if (node === null && d.open) d.close()
    d.scrollTop = 0
  }, [node])
  const n = node === null ? null : ds.nodes[node]
  const m = node === null ? null : an.nodes[node]
  const acc = node !== null && ds.hasActuals ? computeAccuracy(ds, node) : null
  return (
    <dialog ref={ref} className="drawer" aria-label={n ? `Detail for ${n.label}` : 'Item detail'} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      {n && m && (
        <div className="drawer-body">
          <header className="drawer-head">
            <div>
              <p className="eyebrow">{pathOf(ds, n.idx) || 'Portfolio'}</p>
              <h2>{n.label}</h2>
              <div className="chips"><BandChip value={m.leafNervousness} /><VerdictChip verdict={n.leaf > -1 ? m.noise.verdict : null} /></div>
            </div>
            <div className="drawer-nav">
              <button type="button" className="btn ghost small" onClick={() => onStep(-1)} aria-label="Previous finding">Prev</button>
              <button type="button" className="btn ghost small" onClick={() => onStep(1)} aria-label="Next finding">Next</button>
              <button type="button" className="btn ghost small drawer-close" onClick={onClose}>Close</button>
            </div>
          </header>
          {finding && finding.node === n.idx && (
            <section className="why-box">
              <h3>Why it is on the list</h3>
              <p><b>{finding.tag}.</b> {finding.reason}</p>
              {finding.also.map((a) => <p key={a.tag}><b>{a.tag}.</b> {a.reason}</p>)}
            </section>
          )}
          <section className="metric-grid">
            <div className="metric"><span>Nervousness</span><b>{m.nervousness.toFixed(0)}<small> / 100, {nervousBand(m.nervousness)}</small></b></div>
            <div className="metric"><span>Horizon volume</span><b>{fmtQty(m.volume)}</b><Sparkline values={m.horizonTrend} /></div>
            {METRICS.map((x) => <div className="metric" key={x.label} title={x.tip}><span>{x.label}</span><b>{x.get(m)}</b></div>)}
          </section>
          <section><h3>Revision fan</h3><FanChart ds={ds} node={n.idx} /></section>
          <section><h3>Noise test: net revision per snapshot</h3><RevisionBars ds={ds} m={m} z={an.opts.zThreshold} /></section>
          <section><h3>Forecast waterfall</h3><Waterfall ds={ds} node={n.idx} frozenDays={an.opts.frozenDays} mode="revision" compact /><WaterfallLegend mode="revision" frozenDays={an.opts.frozenDays} /></section>
          <section>
            <h3>Accuracy by lag</h3>
            {acc ? <><p className="accuracy-line">{accuracyLine(acc)}</p>{Number.isFinite(acc.fvaVsNaive) && <p className="muted small">Against a naive forecast (repeat the last actual) this forecast is {acc.fvaVsNaive >= 0 ? 'better' : 'worse'} by {(Math.abs(acc.fvaVsNaive) * 100).toFixed(1)} points of error.</p>}<LagChart rows={acc.byLag} title={`Forecast error by lag for ${n.label}`} /></> : <p className="muted">No actuals in this dataset. Map an actuals column to score accuracy by lag.</p>}
          </section>
        </div>
      )}
    </dialog>
  )
}
