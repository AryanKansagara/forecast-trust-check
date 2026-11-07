import { useMemo } from 'react'
import { Hero } from './Hero.tsx'
import { AUDIT_LABEL, disaggFlow, type AuditType } from './engine/audit.ts'
import { buildDataset } from './engine/cube.ts'
import { DEFAULTS } from './engine/metrics.ts'
import { analyze, fmtQty } from './engine/rank.ts'
import { FanChart, fmtDay, RevisionBars, Sankey } from './charts.tsx'
import { SAMPLES } from './samples.ts'
import { Brand, Footer, Link, Lock, ThemeToggle } from './ui.tsx'

const AUDIT_ORDER: AuditType[] = ['share_jump', 'mix_divergence', 'inactive_item', 'new_item', 'sum_mismatch', 'intermittent_smear', 'rounding_loss']
const AUDIT_BLURB: Record<AuditType, string> = {
  share_jump: 'A child\'s share moves while the parent stays flat, so no demand change explains it.',
  mix_divergence: 'The split disagrees with what each item has actually sold.',
  inactive_item: 'Items with no recent sales still receive volume.',
  new_item: 'Items with no history receive volume. Fine for a launch, not by accident.',
  sum_mismatch: 'The stated total and the sum of its items are different numbers.',
  intermittent_smear: 'Lumpy demand gets spread thinly across every bucket.',
  rounding_loss: 'Rounding to units or case lots quietly drops volume, always the same way.',
}

export default function Landing() {
  const { cpg, cpgAn, el, elAn, flow, nb, ph } = useMemo(() => {
    const cpg = buildDataset(SAMPLES[0].rows())
    const el = buildDataset(SAMPLES[1].rows())
    const bev = cpg.nodes.findIndex((n) => n.label === 'North America' && cpg.nodes[n.parent].label === 'Beverages')
    return {
      cpg, cpgAn: analyze(cpg), el, elAn: analyze(el),
      flow: disaggFlow(cpg, bev, cpg.S - 2, cpg.S - 1),
      nb: el.nodes.findIndex((n) => n.label === 'NB-14-PRO'),
      ph: el.nodes.findIndex((n) => n.label === 'PH-X1-128'),
    }
  }, [])
  const nbFinding = elAn.findings.find((f) => f.node === nb)
  return (
    <div className="landing">
      <header className="topbar">
        <Brand />
        <nav className="topnav" aria-label="Page sections">
          <a href="#questions">What it answers</a>
          <a href="#audit">Split audit</a>
          <a href="#privacy">Privacy</a>
          <a href="#samples">Samples</a>
        </nav>
        <div className="topbar-right">
          <ThemeToggle />
          <Link href="/app" className="btn primary">Check my forecast</Link>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Forecast stability and disaggregation audit</p>
          <h1>Know what moved, and whether to believe it</h1>
          <p className="hero-sub">Upload successive forecast snapshots from any planning tool. See what changed, whether it was noise, and whether splitting totals down to item level distorted the plan.</p>
          <div className="hero-cta">
            <Link href="/app" className="btn hero-solid">Upload snapshots</Link>
            <Link href="/app?sample=cpg" className="btn hero-outline">Open a synthetic sample</Link>
          </div>
          <p className="hero-lock"><Lock /> Your forecast data stays in this browser. Nothing is uploaded, ever.</p>
        </div>
        <Hero />
      </section>

      <section className="band-why">
        <div className="wrap why">
          <div>
            <p className="eyebrow">The real work</p>
            <h2>Scenario planning is the part planners like. This is the part they export to Excel.</h2>
          </div>
          <div className="why-body">
            <p>Before the demand review, someone lines up last week's forecast against this week's, checks if the next 30 days held still, and argues about why a family total became those item numbers. That checking often takes longer than working on the plan.</p>
            <p>This tool does that checking, and only that. It is not a what-if planner and it does not replace your planning system. It reads the exports you already make, from any planning tool.</p>
          </div>
        </div>
      </section>

      <section className="section" id="questions">
        <div className="wrap">
          <p className="eyebrow">Three questions, in order</p>
          <h2 className="section-title">From a wall of numbers to a short list</h2>
          <div className="q-grid">
            <article className="q-card">
              <h3><span>1</span> What moved?</h3>
              <p>Every version of the forecast overlaid. <b>NB-14-PRO</b> fans out in the near term and settles further out.</p>
              <FanChart ds={el} node={nb} height={200} />
              <p className="q-foot">{nbFinding?.reason}</p>
            </article>
            <article className="q-card">
              <h3><span>2</span> Was it noise?</h3>
              <p>Each revision is tested against the item's own history. <b>PH-X1-128</b> sat inside its band for 14 snapshots, then left it.</p>
              <RevisionBars ds={el} m={elAn.nodes[ph]} z={DEFAULTS.zThreshold} />
              <p className="q-foot">{elAn.findings.find((f) => f.node === ph)?.reason}</p>
            </article>
            <article className="q-card q-wide">
              <h3><span>3</span> Did the split distort it?</h3>
              <p>Beverages in North America barely changed, yet {fmtQty(flow.moved)} units moved between items. That is a decision somebody should be able to explain.</p>
              <Sankey ds={cpg} flow={flow} labelA={fmtDay(cpg.snapshots[cpg.S - 2])} labelB={fmtDay(cpg.snapshots[cpg.S - 1])} />
            </article>
          </div>
        </div>
      </section>

      <section className="section band-wash" id="audit">
        <div className="wrap">
          <p className="eyebrow">Disaggregation audit</p>
          <h2 className="section-title">Seven ways a split changes the plan, each with the exact quantity</h2>
          <p className="section-sub">Quantities below come from the synthetic consumer goods sample, which has one of each planted.</p>
          <div className="audit-grid">
            {AUDIT_ORDER.map((t) => (
              <div className="audit-card" key={t}>
                <b className="audit-qty">{fmtQty(cpgAn.audit.byType[t].qty)}</b>
                <span className="audit-unit">units</span>
                <h3>{AUDIT_LABEL[t]}</h3>
                <p>{AUDIT_BLURB[t]}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section band-privacy" id="privacy">
        <div className="wrap privacy">
          <div>
            <p className="eyebrow">Commercially sensitive by default</p>
            <h2><Lock size={26} /> Your forecast never leaves this browser</h2>
            <p>There is no server behind this page. Files are read and analysed on your machine, in this tab. And that is enforced rather than promised: the page ships a security policy telling your browser to refuse every outbound data request, even from this site's own code.</p>
            <ul className="privacy-list">
              <li>No uploads, accounts, analytics or cookies.</li>
              <li>Shared links carry view settings only, never your data.</li>
              <li>Keeping a file between visits is opt-in, stays on this device, and one click forgets it.</li>
            </ul>
          </div>
          <div className="policy-card">
            <span className="mono-label">The policy this page ships, check it in view-source</span>
            <pre><code>{`default-src 'none';
connect-src 'none';
form-action 'none';
script-src 'self' 'unsafe-inline';
style-src  'self' 'unsafe-inline';
font-src   'self' data:;
img-src    'self' data:;
base-uri   'none'`}</code></pre>
            <p><code>connect-src 'none'</code> blocks fetch, XHR, WebSocket and beacons. <code>form-action 'none'</code> blocks form posts.</p>
          </div>
        </div>
      </section>

      <section className="section" id="samples">
        <div className="wrap">
          <p className="eyebrow">Try it without your data</p>
          <h2 className="section-title">Three synthetic datasets, one of them deliberately boring</h2>
          <div className="sample-grid">
            {SAMPLES.map((s) => (
              <Link key={s.id} href={`/app?sample=${s.id}`} className="sample-card">
                <span className="tag-synth">Synthetic</span>
                <h3>{s.name}</h3>
                <p>{s.blurb}</p>
                <p className="sample-plants">{s.plants}</p>
                <span className="sample-go">Open sample <span aria-hidden="true">→</span></span>
              </Link>
            ))}
          </div>
          <p className="section-sub share-note">All sample names and numbers are invented.</p>
        </div>
      </section>
      <Footer />
    </div>
  )
}
