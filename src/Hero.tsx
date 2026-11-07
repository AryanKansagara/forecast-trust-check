// The hero is the product running: each snapshot of the synthetic electronics sample is replayed through the real engine,
// which only sees what was known at that date.
import { useEffect, useMemo, useState } from 'react'
import { buildDataset, isLive, nodeCube, sliceSnapshots } from './engine/cube.ts'
import { analyze, fmtPct, fmtQty } from './engine/rank.ts'
import { fmtDay, fmtPeriod, heatFill, NervMeter, Sparkline, TipLayer } from './charts.tsx'
import { SAMPLES } from './samples.ts'

const START = 4
const TICK = 1300
const HOLD_TICKS = 4

export function Hero() {
  const ds = useMemo(() => buildDataset(SAMPLES[1].rows()), [])
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const [k, setK] = useState(reduced ? ds.S : START)
  const [playing, setPlaying] = useState(!reduced)
  const an = useMemo(() => analyze(sliceSnapshots(ds, k)), [ds, k])

  useEffect(() => {
    if (!playing) return
    let hold = 0
    const t = setInterval(() => {
      setK((c) => {
        if (c < ds.S) return c + 1
        if (++hold < HOLD_TICKS) return c
        hold = 0
        return START
      })
    }, TICK)
    return () => clearInterval(t)
  }, [playing, ds.S])

  // Churn per cell across items, so offsetting item moves still glow rather than netting away.
  const { cols, churn } = useMemo(() => {
    const { S, P } = ds
    const first = ds.perEnd.findIndex((e) => e > ds.snapDay[0])
    const cols = Array.from({ length: Math.min(P - first, S + 6) }, (_, i) => first + i)
    const churn = new Float64Array(S * P).fill(NaN)
    for (let s = 0; s < S; s++) for (const p of cols) {
      if (!isLive(ds, s, p)) continue
      let abs = 0, prev = 0, any = false
      for (const n of ds.leafNode) {
        const q = nodeCube(ds, n).q
        const b = q[s * P + p]
        if (Number.isNaN(b)) continue
        any = true
        const a = s > 0 ? q[(s - 1) * P + p] : NaN
        if (!Number.isNaN(a)) { abs += Math.abs(b - a); prev += a }
      }
      if (any) churn[s * P + p] = prev > 0 ? abs / prev : 0
    }
    return { cols, churn }
  }, [ds])

  const W = cols.length * 26, ch = 21, H = ds.S * ch + 30
  const items = an.findings.filter((f) => f.kind === 'stability').slice(0, 6)
  const s = an.summary
  return (
    <div className="stage">
      <div className="stage-tri">
        <div className="stage-head">
          <span className="mono-label">Snapshot {k} of {ds.S} · {fmtDay(ds.snapshots[k - 1])}</span>
          <span className="stage-synth">Synthetic sample · real engine</span>
        </div>
        <TipLayer>
          <svg viewBox={`0 0 ${W} ${H}`} className="tri" role="img" aria-label="Forecast triangle: each new row is a snapshot. The near-term diagonal glows because that is where the forecast keeps changing.">
            {cols.map((p, i) => i % 4 === 0 && <text key={p} x={i * 26 + 2} y={14} className="tri-axis">{fmtPeriod(ds, ds.periods[p])}</text>)}
            {Array.from({ length: k }, (_, r) => cols.map((p, i) => {
              const v = churn[r * ds.P + p]
              if (Number.isNaN(v)) return null
              return (
                <rect
                  key={`${r}-${p}`}
                  x={i * 26 + 1}
                  y={24 + r * ch}
                  width={24}
                  height={ch - 2}
                  rx="3"
                  fill={r === 0 ? 'var(--cell0)' : heatFill(v, 0.22)}
                  className={r === k - 1 ? 'ripple' : undefined}
                  style={r === k - 1 ? { animationDelay: `${(i - r) * 26}ms` } : undefined}
                  data-tip={r === 0 ? `${fmtPeriod(ds, ds.periods[p])}\nFirst version` : `${fmtPeriod(ds, ds.periods[p])}, as of ${fmtDay(ds.snapshots[r])}\nItems revised by ${fmtPct(v)} of their volume`}
                />
              )
            }))}
          </svg>
        </TipLayer>
        <div className="stage-controls">
          <button type="button" className="btn hero-outline small" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause replay' : 'Play replay'}>{playing ? 'Pause' : 'Play'}</button>
          <input type="range" min={2} max={ds.S} value={k} aria-label="Replay to snapshot" onChange={(e) => { setPlaying(false); setK(+e.target.value) }} />
          <span className="legend-inline"><span className="ramp ramp-nerv" aria-hidden="true" style={{ width: 64 }} />Stable to churning</span>
        </div>
      </div>
      <div className="stage-side">
        <div className="stage-stats">
          <div><b>{fmtQty(s.frozenUnits)}</b><span>units revised in the next 30 days</span></div>
          <div><b>{fmtPct(s.frozenPct, 0)}</b><span>near-term churn this snapshot</span></div>
          <div><b>{s.bands.nervous}</b><span>of {ds.L} items nervous</span></div>
        </div>
        <div className="stage-head"><span className="mono-label">Flagged now, by impact</span></div>
        <ol className="flag-list" aria-live="off">
          {items.map((f) => {
            const m = an.nodes[f.node]
            return (
              <li key={f.node} className={f.verdict === 'signal' ? 'flag flag-signal' : 'flag'}>
                <div className="flag-top"><b>{f.title}</b><NervMeter value={m.nervousness} /></div>
                <div className="flag-sub">
                  <span key={f.tag} className="flag-tag">{f.tag}</span>
                  <span className="flag-units">{fmtQty(f.units)} units</span>
                  <Sparkline values={m.horizonTrend} width={64} height={18} />
                </div>
              </li>
            )
          })}
          {!items.length && <li className="flag flag-empty">Too little history to judge yet. The engine waits rather than guesses.</li>}
        </ol>
      </div>
    </div>
  )
}
