// The demand review handout. Hidden on screen, it replaces the app when printing.
import { AUDIT_LABEL, type AuditType } from './engine/audit.ts'
import type { Dataset } from './engine/cube.ts'
import { nervousBand } from './engine/metrics.ts'
import { fmtPct, fmtQty, pathOf, type Analysis } from './engine/rank.ts'
import { accuracyLine, fmtDay, LagChart, Waterfall } from './charts.tsx'

export function PrintPack({ ds, an, name, synthetic }: { ds: Dataset; an: Analysis; name: string; synthetic: boolean }) {
  const s = an.summary
  const worst = [...ds.leafNode].sort((a, b) => an.nodes[b].nervousness - an.nodes[a].nervousness).slice(0, 15)
  return (
    <div className="print-pack">
      <header>
        <h1>Forecast trust review</h1>
        <p>{name}{synthetic ? ' (SYNTHETIC SAMPLE: all names and numbers invented)' : ''}. Latest snapshot {fmtDay(ds.snapshots[ds.S - 1])}, compared across {ds.S} snapshots, {ds.L} items.</p>
        <p>Frozen window {an.opts.frozenDays} days. Noise threshold {an.opts.zThreshold}σ. Share jump {(an.opts.shareJumpPP * 100).toFixed(0)} points. Produced locally in the browser; no data was uploaded.</p>
      </header>
      <section className="pp-kpis">
        <div><b>{fmtQty(s.volume)}</b><span>horizon volume</span></div>
        <div><b>{fmtQty(s.latestUnits)}</b><span>units revised, latest snapshot ({fmtPct(s.latestPct)})</span></div>
        <div><b>{fmtQty(s.noiseUnits)}</b><span>of those within normal range</span></div>
        <div><b>{fmtQty(s.signalUnits)}</b><span>outside normal range</span></div>
        <div><b>{fmtQty(s.splitUnits)}</b><span>moved by the split alone</span></div>
        <div><b>{fmtQty(s.distorted)}</b><span>units distorted by the split</span></div>
      </section>
      <h2>What to look at first</h2>
      {an.findings.length === 0 && <p>Nothing here stands out from normal revision noise.</p>}
      <table>
        <thead><tr><th>#</th><th>Item</th><th>Finding</th><th className="num">Units</th><th>Why</th></tr></thead>
        <tbody>{an.findings.slice(0, 20).map((f, i) => <tr key={f.id}><td>{i + 1}</td><td><b>{f.title}</b><br /><small>{f.path}</small></td><td>{f.tag}<br /><small>{f.severity}</small></td><td className="num">{fmtQty(f.units)}</td><td>{f.reason}</td></tr>)}</tbody>
      </table>
      <h2>Disaggregation audit</h2>
      <table>
        <thead><tr><th>Check</th><th className="num">Findings</th><th className="num">Units, latest snapshot</th></tr></thead>
        <tbody>{(Object.keys(AUDIT_LABEL) as AuditType[]).map((t) => <tr key={t}><td>{AUDIT_LABEL[t]}</td><td className="num">{an.audit.byType[t].count}</td><td className="num">{fmtQty(an.audit.byType[t].qty)}</td></tr>)}</tbody>
      </table>
      <p className="pp-note">A child can trip several checks over the same units. Counting each child's largest finding once gives {fmtQty(s.distorted)} units ({fmtPct(s.distortedPct)} of horizon volume).{an.audit.statedParents === 0 ? ' The file stated no parent totals, so sum and rounding checks did not run.' : ''}</p>
      <h2 className="pp-break">Portfolio forecast waterfall</h2>
      <Waterfall ds={ds} node={0} frozenDays={an.opts.frozenDays} mode="revision" />
      {s.accuracy && <><h2>Accuracy by lag</h2><p>{accuracyLine(s.accuracy)}</p><LagChart rows={s.accuracy.byLag} title="Portfolio forecast error by lag" /></>}
      <h2 className="pp-break">Most nervous items</h2>
      <table>
        <thead><tr><th>Item</th><th>Path</th><th className="num">Volume</th><th className="num">Nervousness</th><th className="num">Window churn</th><th className="num">Flip-flops</th><th>Noise test</th></tr></thead>
        <tbody>{worst.map((n) => { const m = an.nodes[n]; return <tr key={n}><td>{ds.nodes[n].label}</td><td>{pathOf(ds, n)}</td><td className="num">{fmtQty(m.volume)}</td><td className="num">{m.nervousness.toFixed(0)} {nervousBand(m.nervousness)}</td><td className="num">{fmtPct(m.frozenChurnLatest)}</td><td className="num">{m.flipCount}</td><td>{m.noise.verdict}</td></tr> })}</tbody>
      </table>
    </div>
  )
}
