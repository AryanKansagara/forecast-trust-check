import { Brand, Footer, Link, ThemeToggle } from './ui.tsx'
import { STEO_SOURCE } from './steoData.ts'

export default function Docs() {
  return (
    <div className="landing">
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          <ThemeToggle />
          <Link href="/app" className="btn primary">Check my forecast</Link>
        </div>
      </header>
      <main className="section docs">
        <div className="wrap">
          <p className="eyebrow">Docs</p>
          <h1 className="section-title">How the checks work</h1>

          <h2>What to upload</h2>
          <p>One or more CSV exports, each holding the forecast as it stood on a snapshot (release, cycle or as-of) date. Long files have one row per item and period. Wide files have one column per bucket. The snapshot date comes from a column or from a date in the file name such as <code>plan_2026-01-12.csv</code>.</p>
          <ul>
            <li>Periods: ISO days, months (<code>2026-03</code>, <code>Mar-26</code>, <code>JAN 2026</code>, <code>202603</code>), ISO weeks (<code>2026-W05</code>, <code>W05 2026</code>, <code>CW05 2026</code>, <code>KW 05/2026</code>) and <code>20260105</code>. Week 53 is accepted only in years that have one.</li>
            <li>Numbers: <code>1,234.5</code>, <code>1.234,5</code>, <code>(120)</code>, and a decimal-comma switch for semicolon files.</li>
            <li>Actuals: an actuals column, or a measure / key figure column whose value says actual, sales, shipments or history. "Sales forecast" counts as a forecast.</li>
            <li>Several forecast key figures in one file (for example statistical, consensus and final, as in an SAP IBP planning view) are not summed. The consensus or final one is kept and the rest are listed in the import report.</li>
            <li>Parent totals: a row with a blank item, or an item called <code>TOTAL</code> or <code>ALL</code>, is the stated total of its family / region / customer path.</li>
          </ul>

          <h2>Definitions</h2>
          <ul>
            <li><b>Revision</b>: forecast at snapshot k minus forecast at snapshot k−1 for the same period, counted only while that period has not ended.</li>
            <li><b>Revision WAPE</b>: sum of |revision| over the sum of the earlier forecast.</li>
            <li><b>COV</b>: for each target period, the standard deviation of its versions over their mean, volume weighted.</li>
            <li><b>Frozen-window churn</b>: revision WAPE restricted to periods starting within the frozen window (30 days by default) of the snapshot.</li>
            <li><b>Flip-flop</b>: a revision above the tolerance (2%, at least 0.5 units) followed by one in the opposite direction. Units undone is the smaller of the two moves.</li>
            <li><b>Noise or signal</b>: the latest revision is compared with the item's earlier revisions, z = (latest − centre) / σ. σ is 1.4826 × the median absolute revision, shrunk toward the portfolio with 4 pseudo-observations. A signal needs |z| ≥ 2.5 and a move of at least 2%, or three same-direction steps that are as unusual together and add up to at least 3%.</li>
            <li><b>Accuracy by lag</b>: WAPE = Σ|forecast − actual| / Σ actual, measured at item level and summed. Lag 0 is the bucket the snapshot falls in.</li>
            <li><b>Value add against naive</b>: naive WAPE minus forecast WAPE, where the naive forecast repeats the last actual completed before the snapshot. Positive means the forecast beats naive.</li>
          </ul>

          <h2 id="real-data">The real sample: U.S. fuel demand</h2>
          <p>The "U.S. fuel demand (real)" sample is published forecast history, not invented. It holds U.S. petroleum product consumption in thousand barrels per day from twelve monthly releases of the U.S. Energy Information Administration's Short-Term Energy Outlook, November 2025 to October 2026 (Table 4a, sheet <code>4atab</code> of each <code>mmmYY_base.xlsx</code>).</p>
          <ul>
            <li>Source: <a href={STEO_SOURCE}>{STEO_SOURCE}</a>, downloaded 15 November 2026. EIA data is in the public domain.</li>
            <li>Each release is a snapshot dated by its release date. The seven product lines are items, and "U.S. total petroleum products consumption" is the stated parent total.</li>
            <li>Each release is kept from its release month for up to 15 months. Actuals are the history months (Nov 2025 to Sep 2026) of the October 2026 release, so the most recent ones are still EIA estimates.</li>
            <li>EIA rounds published values, so the total and the sum of products differ by up to 0.2 thousand barrels per day. The sum check treats that as rounding, not a mismatch.</li>
          </ul>
          <p>The three other samples are synthetic. Every name and number in them is invented and their defects are planted.</p>
        </div>
      </main>
      <Footer />
    </div>
  )
}
