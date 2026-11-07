import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { AUDIT_LABEL, disaggFlow, type AuditType } from './engine/audit.ts'
import { buildDataset, type Dataset } from './engine/cube.ts'
import type { CleanRow, ImportReport } from './engine/csv.ts'
import { toCsv, findingsCsv, itemsCsv } from './engine/export.ts'
import { DEFAULTS, type Options } from './engine/metrics.ts'
import { analyze, fmtPct, fmtQty, pathOf, type Analysis, type Finding } from './engine/rank.ts'
import { accuracyLine, BandChip, fmtDay, LagChart, NervMeter, Sankey, Sparkline, Treemap, VerdictChip, Waterfall, WaterfallLegend } from './charts.tsx'
import { Drawer } from './Drawer.tsx'
import { Dropzone, MappingStep, readFiles, type FileIn, type Imported } from './Import.tsx'
import { PrintPack } from './PrintPack.tsx'
import { sampleCsv, SAMPLES } from './samples.ts'
import { decodeState, encodeState } from './share.ts'
import { Brand, download, Footer, Lock, ThemeToggle } from './ui.tsx'

const TABS = [['waterfall', 'Waterfall'], ['hierarchy', 'Hierarchy'], ['split', 'Split audit'], ['items', 'Items'], ['accuracy', 'Accuracy'], ['report', 'Import report']] as const
type Tab = (typeof TABS)[number][0]
type Source = { kind: 'sample'; id: string } | { kind: 'upload'; name: string; rows: CleanRow[]; report: ImportReport } | null
interface Saved { sample: string | null; frozenDays: number; z: number; share: number; tab: Tab; sel?: string }

const KEY = 'ftc.settings', DATA_KEY = 'ftc.upload'

function loadSaved(): Partial<Saved> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}
function initialSource(saved: Partial<Saved>): Source {
  const q = new URLSearchParams(location.search).get('sample')
  if (q && SAMPLES.some((s) => s.id === q)) return { kind: 'sample', id: q }
  try {
    const up = JSON.parse(localStorage.getItem(DATA_KEY) ?? 'null')
    if (up?.rows) return { kind: 'upload', name: up.name, rows: up.rows, report: up.report }
  } catch { /* corrupt saved data is simply ignored */ }
  return saved.sample ? { kind: 'sample', id: saved.sample } : null
}

export default function Tool() {
  const saved = useMemo(loadSaved, [])
  const [source, setSource] = useState<Source>(() => initialSource(saved))
  const [frozenDays, setFrozen] = useState(saved.frozenDays ?? DEFAULTS.frozenDays)
  const [z, setZ] = useState(saved.z ?? DEFAULTS.zThreshold)
  const [share, setShare] = useState(saved.share ?? DEFAULTS.shareJumpPP)
  const [tab, setTab] = useState<Tab>(saved.tab ?? 'waterfall')
  const [sel, setSel] = useState<string | null>(null)
  const [mapping, setMapping] = useState<FileIn[] | null>(null)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  // A shared link restores the view and, for samples, the dataset. It never holds uploaded data.
  useEffect(() => {
    const m = location.hash.match(/^#v=(.+)$/)
    if (!m) return
    decodeState(m[1]).then((raw) => {
      const v = raw as Partial<Saved>
      if (v.frozenDays) setFrozen(v.frozenDays)
      if (v.z) setZ(v.z)
      if (v.share) setShare(v.share)
      if (v.tab) setTab(v.tab)
      if (v.sel) setSel(v.sel)
      if (v.sample && SAMPLES.some((s) => s.id === v.sample)) setSource({ kind: 'sample', id: v.sample })
    }).catch(() => setNotice('That shared link could not be read, so default settings are in use.'))
  }, [])

  const sampleId = source?.kind === 'sample' ? source.id : null
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify({ sample: sampleId, frozenDays, z, share, tab } satisfies Saved))
  }, [sampleId, frozenDays, z, share, tab])

  const rows = useMemo(() => (source?.kind === 'sample' ? SAMPLES.find((s) => s.id === source.id)!.rows() : source?.kind === 'upload' ? source.rows : null), [source])
  const ds = useMemo(() => (rows ? buildDataset(rows) : null), [rows])
  // Analysis runs on the main thread, deferred so typing stays smooth. Move to a worker if real files exceed ~50k leaf-periods.
  const opts = useDeferredValue<Options>(useMemo(() => ({ ...DEFAULTS, frozenDays: Math.max(1, frozenDays || 1), zThreshold: z, shareJumpPP: share }), [frozenDays, z, share]))
  const an = useMemo(() => (ds && ds.S >= 2 ? analyze(ds, opts) : null), [ds, opts])

  const onFiles = async (files: File[]) => {
    if (!files.length) return
    const { loaded, error } = await readFiles(files)
    setErr(error)
    if (loaded.length) setMapping(loaded)
  }
  const onImported = (r: Imported) => {
    setMapping(null); setSel(null); setErr(''); setTab('waterfall')
    buildDataset(r.rows, r.report) // fills in the duplicate count for the import report
    setSource({ kind: 'upload', name: r.name, rows: r.rows, report: r.report })
    history.replaceState({}, '', '/app')
    localStorage.removeItem(DATA_KEY)
    if (r.keep) {
      try { localStorage.setItem(DATA_KEY, JSON.stringify({ name: r.name, rows: r.rows, report: { ...r.report, bad: r.report.bad.slice(0, 200) } })) }
      catch { setNotice('This file is too large for browser storage, so it will not be kept after you close the tab.') }
    }
  }
  const forget = () => {
    localStorage.removeItem(DATA_KEY)
    setSource(null); setSel(null); setMapping(null)
    history.replaceState({}, '', '/app')
  }
  const openSample = (id: string) => { setSource({ kind: 'sample', id }); setSel(null); setMapping(null); history.replaceState({}, '', `/app?sample=${id}`) }

  const name = source?.kind === 'sample' ? `${SAMPLES.find((s) => s.id === source.id)!.name}` : source?.kind === 'upload' ? source.name : ''
  const synthetic = source?.kind === 'sample'

  return (
    <div className="tool">
      <div className="screen-only">
        <header className="topbar">
          <Brand />
          {source && !mapping && (
            <div className="data-pill">
              <b>{name}</b>
              {synthetic && <span className="tag-synth">Synthetic sample</span>}
            </div>
          )}
          <div className="topbar-right">
            {source && <button type="button" className="btn ghost" onClick={forget}>{synthetic ? 'Change data' : 'Forget this data'}</button>}
            <ThemeToggle />
          </div>
        </header>
        <div className="privacy-strip" role="note"><Lock /> <b>Your data stays in this browser.</b> <span>No uploads, no analytics. The page's security policy blocks outbound requests.</span></div>
        {notice && <p className="notice" role="status">{notice} <button type="button" className="link" onClick={() => setNotice('')}>Dismiss</button></p>}
        {mapping
          ? <main className="wrap-wide"><MappingStep files={mapping} onChange={setMapping} onDone={onImported} onCancel={() => setMapping(null)} /></main>
          : !source
            ? <Start onFiles={onFiles} err={err} onSample={openSample} />
            : ds && an
              ? <Workspace key={name} ds={ds} an={an} name={name} synthetic={!!synthetic} source={source} tab={tab} setTab={setTab} sel={sel} setSel={setSel} frozenDays={frozenDays} setFrozen={setFrozen} z={z} setZ={setZ} share={share} setShare={setShare} sampleId={sampleId} />
              : <main className="wrap-wide"><p className="form-error" role="alert">This dataset has fewer than 2 snapshots, so there is nothing to compare.</p></main>}
        <Footer />
      </div>
      {ds && an && !mapping && <PrintPack ds={ds} an={an} name={name} synthetic={!!synthetic} />}
    </div>
  )
}

function Start({ onFiles, err, onSample }: { onFiles: (f: File[]) => void; err: string; onSample: (id: string) => void }) {
  return (
    <main className="wrap-wide start">
      <div className="start-head">
        <p className="eyebrow">Step 1 of 2</p>
        <h1>Bring two or more forecast snapshots</h1>
        <p>Export them from any planning tool. Needs a snapshot date, an item, a period and a quantity. Family, region, customer and actuals each unlock more checks.</p>
      </div>
      <Dropzone onFiles={onFiles} error={err} />
      <div className="start-samples">
        <h2>Or open a synthetic sample</h2>
        <div className="sample-grid">
          {SAMPLES.map((s) => (
            <div key={s.id} className="sample-card">
              <span className="tag-synth">Synthetic</span>
              <h3>{s.name}</h3>
              <p>{s.blurb}</p>
              <p className="sample-plants">{s.plants}</p>
              <div className="sample-actions">
                <button type="button" className="btn primary small" onClick={() => onSample(s.id)}>Open</button>
                <button type="button" className="btn ghost small" onClick={() => download(`${s.id}-synthetic.csv`, sampleCsv(s.rows()))}>Get the CSV</button>
              </div>
            </div>
          ))}
        </div>
        <p className="muted small">The CSVs let you try the import and mapping step without using real data.</p>
      </div>
    </main>
  )
}

interface WS {
  ds: Dataset; an: Analysis; name: string; synthetic: boolean; source: NonNullable<Source>; tab: Tab; setTab: (t: Tab) => void; sel: string | null; setSel: (s: string | null) => void
  frozenDays: number; setFrozen: (n: number) => void; z: number; setZ: (n: number) => void; share: number; setShare: (n: number) => void; sampleId: string | null
}

function Workspace(w: WS) {
  const { ds, an, tab, setTab, sel, setSel } = w
  const [drawer, setDrawer] = useState<number | null>(null)
  const [help, setHelp] = useState(false)
  const [drill, setDrill] = useState(0)
  const [copied, setCopied] = useState('')
  const list = an.findings
  const idx = Math.max(0, list.findIndex((f) => f.id === sel))
  const current: Finding | null = list[idx] ?? null
  const focusNode = current ? current.node : 0
  const listRef = useRef<HTMLOListElement>(null)

  const step = useCallback((d: number) => {
    if (!list.length) return
    const next = list[Math.min(list.length - 1, Math.max(0, idx + d))]
    setSel(next.id)
    setDrawer((o) => (o === null ? null : next.node))
  }, [list, idx, setSel])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1) }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
      else if (e.key === 'Enter' && t.tagName !== 'BUTTON' && t.tagName !== 'A' && current) setDrawer(current.node)
      else if (e.key === '?') setHelp((h) => !h)
      else if (/^[1-6]$/.test(e.key)) setTab(TABS[+e.key - 1][0])
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [step, current, setTab])

  useEffect(() => {
    // Scroll the list only; scrollIntoView would also move the page and hide the header on small screens.
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !row) return
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
  }, [idx])

  const share = async () => {
    const hash = await encodeState({ sample: w.sampleId, frozenDays: w.frozenDays, z: w.z, share: w.share, tab, sel: sel ?? undefined } satisfies Partial<Saved>)
    const url = `${location.origin}/app#v=${hash}`
    history.replaceState({}, '', url)
    // Clipboard can be refused; the link is in the address bar either way.
    const wrote = await navigator.clipboard?.writeText(url).then(() => true, () => false)
    setCopied(wrote ? 'Link copied' : 'Link is in the address bar')
    setTimeout(() => setCopied(''), 2500)
  }
  const s = an.summary
  const moved = Math.max(1, s.noiseUnits + s.signalUnits + s.splitUnits + s.thinUnits)

  return (
    <main className="wrap-wide workspace">
      {w.synthetic && <p className="synth-banner"><b>Synthetic sample.</b> Every name and number here is invented, and the defects were planted on purpose.</p>}
      <section className="kpis" aria-label="Summary">
        <div className="kpi kpi-wide">
          <span className="kpi-label">Moved in the latest snapshot</span>
          <b>{fmtQty(s.latestUnits)} <small>units, {fmtPct(s.latestPct)} of horizon</small></b>
          <div className="stack" aria-hidden="true">
            {s.noiseUnits > 0 && <i className="seg-noise" style={{ flex: s.noiseUnits / moved }} />}
            {s.signalUnits > 0 && <i className="seg-signal" style={{ flex: s.signalUnits / moved }} />}
            {s.splitUnits > 0 && <i className="seg-split" style={{ flex: s.splitUnits / moved }} />}
            {s.thinUnits > 0 && <i className="seg-thin" style={{ flex: s.thinUnits / moved }} />}
          </div>
          <div className="stack-legend">
            <span><i className="seg-noise" />Usual noise <b>{fmtPct(s.noiseUnits / moved, 0)}</b></span>
            <span><i className="seg-signal" />Outside normal <b>{fmtPct(s.signalUnits / moved, 0)}</b></span>
            <span><i className="seg-split" />From the split <b>{fmtPct(s.splitUnits / moved, 0)}</b></span>
            {s.thinUnits > 0 && <span><i className="seg-thin" />Short history <b>{fmtPct(s.thinUnits / moved, 0)}</b></span>}
          </div>
        </div>
        <div className="kpi"><span className="kpi-label">Next {an.opts.frozenDays} days churn</span><b>{fmtPct(s.frozenPct)}</b><small>{fmtQty(s.frozenUnits)} units revised</small></div>
        <div className="kpi"><span className="kpi-label">Distorted by the split</span><b>{fmtQty(s.distorted)}</b><small>{fmtPct(s.distortedPct)} of horizon volume</small></div>
        <div className="kpi"><span className="kpi-label">Item nervousness</span><b>{s.bands.nervous} <small>nervous</small></b><small>{s.bands.watch} watch, {s.bands.calm} calm</small></div>
        <div className="kpi"><span className="kpi-label">Did revisions help?</span>{s.accuracy ? <><b>{s.accuracy.verdict === 'helped' ? 'Yes' : s.accuracy.verdict === 'hurt' ? 'No, worse' : s.accuracy.verdict === 'neutral' ? 'Not really' : 'Unknown'}</b><small>{Number.isFinite(s.accuracy.fvaOfRevisions) ? `${(Math.abs(s.accuracy.fvaOfRevisions) * 100).toFixed(1)} points of error ${s.accuracy.fvaOfRevisions >= 0 ? 'removed' : 'added'}` : 'No completed periods'}</small></> : <><b>Unknown</b><small>No actuals in this file</small></>}</div>
      </section>

      <section className="controls" aria-label="Settings">
        <label className="ctl"><span>Frozen window</span>
          <span className="seg">{[14, 30, 60, 90].map((d) => <button type="button" key={d} className={w.frozenDays === d ? 'on' : ''} onClick={() => w.setFrozen(d)}>{d}d</button>)}</span>
          <input type="number" min={1} max={730} value={w.frozenDays} aria-label="Frozen window in days" onChange={(e: ChangeEvent<HTMLInputElement>) => w.setFrozen(+e.target.value)} />
        </label>
        <label className="ctl"><span>Signal at</span>
          <select value={w.z} onChange={(e) => w.setZ(+e.target.value)}>{[2, 2.5, 3, 4].map((v) => <option key={v} value={v}>{v}σ</option>)}</select>
        </label>
        <label className="ctl"><span>Share jump at</span>
          <select value={w.share} onChange={(e) => w.setShare(+e.target.value)}>{[0.02, 0.03, 0.05, 0.08, 0.1].map((v) => <option key={v} value={v}>{v * 100} points</option>)}</select>
        </label>
        <div className="ctl-actions">
          <button type="button" className="btn ghost small" onClick={() => download('forecast-findings.csv', findingsCsv(ds, an))}>Findings CSV</button>
          <button type="button" className="btn ghost small" onClick={() => download('forecast-items.csv', itemsCsv(ds, an))}>Items CSV</button>
          <button type="button" className="btn ghost small" onClick={() => print()}>Print review pack</button>
          <button type="button" className="btn ghost small" onClick={share} title="The link holds settings and the view. It never contains your data.">{copied || 'Copy settings link'}</button>
        </div>
      </section>

      <div className="split">
        <aside className="rank-col" aria-label="What to look at first">
          <div className="rank-head">
            <h2>What to look at first</h2>
            <button type="button" className="kbd-btn" onClick={() => setHelp((h) => !h)} aria-expanded={help}><kbd>?</kbd> keys</button>
          </div>
          {help && <p className="kbd-help"><kbd>j</kbd>/<kbd>k</kbd> or arrows move · <kbd>Enter</kbd> opens detail · <kbd>Esc</kbd> closes · <kbd>1</kbd>-<kbd>6</kbd> switch views</p>}
          {list.length === 0 ? (
            <div className="empty-good">
              <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.500 4.500 4.500L19 7.500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <h3>Nothing to chase</h3>
              <p>Revisions are inside their normal range, the near term is holding and the split reconciles. You can spend this review on the plan.</p>
            </div>
          ) : (
            <ol className="rank-list" role="listbox" aria-label="Ranked findings" ref={listRef} tabIndex={0}>
              {list.map((f, i) => (
                <li key={f.id} role="option" aria-selected={i === idx} className={`rank-row${i === idx ? ' on' : ''}`} onClick={() => setSel(f.id)} onDoubleClick={() => setDrawer(f.node)}>
                  <span className="rank-n">{i + 1}</span>
                  <div className="rank-main">
                    <div className="rank-top"><b>{f.title}</b><span className={`sev sev-${f.severity}`}><i aria-hidden="true" />{f.severity}</span></div>
                    <div className="rank-meta"><span className={f.kind === 'disaggregation' ? 'tag tag-split' : f.verdict === 'signal' ? 'tag tag-signal' : 'tag tag-noise'}>{f.tag}</span><span className="rank-units">{fmtQty(f.units)} units</span>{f.also.length > 0 && <span className="rank-also">+{f.also.length} more</span>}</div>
                    <p className="rank-reason">{f.reason}</p>
                    {i === idx && <button type="button" className="link" onClick={(e) => { e.stopPropagation(); setDrawer(f.node) }}>Open detail</button>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </aside>
        <section className="view-col">
          <div className="tabs" role="tablist" aria-label="Views">
            {TABS.map(([id, label], i) => <button type="button" key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}<kbd>{i + 1}</kbd></button>)}
          </div>
          <div className="panel view-panel" role="tabpanel">
            {tab === 'waterfall' && <WaterfallView ds={ds} an={an} node={focusNode} onOpen={() => setDrawer(focusNode)} />}
            {tab === 'hierarchy' && <><h3 className="view-title">Where the nervousness sits</h3><p className="view-sub">Click a block to drill down. Colour is volume-weighted item nervousness, so a calm-looking total cannot hide nervous items.</p><Treemap ds={ds} nodes={an.nodes} root={drill} onDrill={setDrill} onItem={setDrawer} selected={focusNode} /></>}
            {tab === 'split' && <SplitView ds={ds} an={an} focus={current} onSelect={(id, node) => { setSel(id); setDrawer(node) }} />}
            {tab === 'items' && <ItemsView ds={ds} an={an} onOpen={setDrawer} />}
            {tab === 'accuracy' && <AccuracyView ds={ds} an={an} onOpen={setDrawer} />}
            {tab === 'report' && <ReportView source={w.source} ds={ds} />}
          </div>
        </section>
      </div>
      <Drawer ds={ds} an={an} node={drawer} finding={drawer !== null ? list.find((f) => f.node === drawer) ?? null : null} onClose={() => setDrawer(null)} onStep={step} />
    </main>
  )
}

function WaterfallView({ ds, an, node, onOpen }: { ds: Dataset; an: Analysis; node: number; onOpen: () => void }) {
  const [mode, setMode] = useState<'revision' | 'quantity'>('revision')
  const n = ds.nodes[node]
  const m = an.nodes[node]
  return (
    <>
      <div className="view-head">
        <div>
          <h3 className="view-title">{n.label} <BandChip value={m.leafNervousness} /> <VerdictChip verdict={n.leaf > -1 ? m.noise.verdict : null} /></h3>
          <p className="view-sub">{pathOf(ds, node) ? `${pathOf(ds, node)}. ` : ''}Each row is a snapshot, each column a target period. Newer versions run down the page.</p>
        </div>
        <div className="view-actions">
          <div className="seg" role="group" aria-label="Cell colour">
            <button type="button" className={mode === 'revision' ? 'on' : ''} onClick={() => setMode('revision')}>Revision</button>
            <button type="button" className={mode === 'quantity' ? 'on' : ''} onClick={() => setMode('quantity')}>Quantity</button>
          </div>
          <button type="button" className="btn ghost small" onClick={onOpen}>Open detail</button>
        </div>
      </div>
      <Waterfall ds={ds} node={node} frozenDays={an.opts.frozenDays} mode={mode} />
      <WaterfallLegend mode={mode} frozenDays={an.opts.frozenDays} />
    </>
  )
}

function SplitView({ ds, an, focus, onSelect }: { ds: Dataset; an: Analysis; focus: Finding | null; onSelect: (id: string, node: number) => void }) {
  const parents = useMemo(() => ds.nodes.filter((n) => n.leaf === -1 && n.children.length >= 2 && (n.idx !== 0 || ds.levels.length === 0)), [ds])
  const auto = focus?.audit && parents.some((p) => p.idx === focus.audit!.parent) ? focus.audit.parent : an.audit.findings.find((f) => parents.some((p) => p.idx === f.parent))?.parent ?? parents[0]?.idx ?? 0
  const [picked, setPicked] = useState<number | null>(null)
  useEffect(() => setPicked(null), [focus?.id])
  const parent = picked ?? auto
  const [a, setA] = useState(ds.S - 2)
  const [b, setB] = useState(ds.S - 1)
  const [near, setNear] = useState(false)
  const flow = useMemo(() => disaggFlow(ds, parent, a, b, near ? an.opts.frozenDays : null), [ds, parent, a, b, near, an.opts.frozenDays])
  const rows = an.findings.filter((f) => f.audit || f.also.some((x) => x.tag in LABELS))
  const types = Object.keys(AUDIT_LABEL) as AuditType[]
  return (
    <>
      <h3 className="view-title">Parent to children, between two snapshots</h3>
      <div className="split-controls">
        <label className="ctl"><span>Parent</span><select value={parent} onChange={(e) => setPicked(+e.target.value)}>{parents.map((p) => <option key={p.idx} value={p.idx}>{pathOf(ds, p.idx) ? `${pathOf(ds, p.idx)} / ` : ''}{p.label}</option>)}</select></label>
        <label className="ctl"><span>From</span><select value={a} onChange={(e) => setA(+e.target.value)}>{ds.snapshots.map((s, i) => <option key={s} value={i} disabled={i >= b}>{fmtDay(s)}</option>)}</select></label>
        <label className="ctl"><span>To</span><select value={b} onChange={(e) => setB(+e.target.value)}>{ds.snapshots.map((s, i) => <option key={s} value={i} disabled={i <= a}>{fmtDay(s)}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={near} onChange={(e) => setNear(e.target.checked)} /> Next {an.opts.frozenDays} days only</label>
      </div>
      {flow.totalA + flow.totalB > 0
        ? <Sankey ds={ds} flow={flow} labelA={fmtDay(ds.snapshots[a])} labelB={fmtDay(ds.snapshots[b])} />
        : <p className="muted">No shared volume for this parent between these snapshots.</p>}
      <p className="flow-line"><b>{fmtQty(flow.moved)}</b> units changed hands between children, while the parent {flow.added > 0 ? `grew ${fmtQty(flow.added)}` : flow.removed > 0 ? `shrank ${fmtQty(flow.removed)}` : 'did not change'}.</p>
      <div className="table-scroll">
        <table className="data">
          <caption className="sr-only">Exact quantities behind the flow</caption>
          <thead><tr><th>Child</th><th className="num">{fmtDay(ds.snapshots[a])}</th><th className="num">{fmtDay(ds.snapshots[b])}</th><th className="num">Change</th><th className="num">Share before</th><th className="num">Share after</th><th className="num">Points</th></tr></thead>
          <tbody>{flow.children.map((c) => <tr key={c.node}><td>{ds.nodes[c.node].label}</td><td className="num">{fmtQty(c.a)}</td><td className="num">{fmtQty(c.b)}</td><td className="num">{c.b - c.a >= 0 ? '+' : ''}{fmtQty(c.b - c.a)}</td><td className="num">{fmtPct(c.shareA)}</td><td className="num">{fmtPct(c.shareB)}</td><td className="num">{((c.shareB - c.shareA) * 100).toFixed(1)}</td></tr>)}</tbody>
        </table>
      </div>
      <h3 className="view-title spaced">Audit results, latest snapshot</h3>
      {an.audit.statedParents === 0 && <p className="notice-inline">This file has no stated parent totals, so the sum and rounding checks did not run. To turn them on, include rows with a blank item, or an item called TOTAL, holding the parent's number.</p>}
      <div className="type-grid">
        {types.map((t) => <div key={t} className={`type-card${an.audit.byType[t].count ? ' hit' : ''}`}><b>{fmtQty(an.audit.byType[t].qty)}</b><span>{AUDIT_LABEL[t]}</span><small>{an.audit.byType[t].count} finding{an.audit.byType[t].count === 1 ? '' : 's'}</small></div>)}
      </div>
      <p className="muted small">One child can trip several checks over the same units, so the headline counts each child's largest finding once: {fmtQty(an.summary.distorted)} units.</p>
      {rows.length > 0
        ? <div className="table-scroll"><table className="data">
            <thead><tr><th>Finding</th><th>Item or parent</th><th className="num">Units</th><th className="num">Periods</th><th className="num">Snapshots</th></tr></thead>
            <tbody>{an.audit.findings.filter((f) => f.qtyLatest > 0).map((f) => {
              const node = f.child > -1 ? f.child : f.parent
              const row = an.findings.find((x) => x.node === node)
              return <tr key={`${f.type}${f.parent}:${f.child}`}><td>{AUDIT_LABEL[f.type]}</td><td>{row ? <button type="button" className="link" onClick={() => onSelect(row.id, node)}>{ds.nodes[node].label}</button> : ds.nodes[node].label}<small className="block muted">{pathOf(ds, node)}</small></td><td className="num">{fmtQty(f.qtyLatest)}</td><td className="num">{f.periods.length}</td><td className="num">{f.snapshotsHit}</td></tr>
            })}</tbody>
          </table></div>
        : <p className="empty-inline">The split checks out: totals reconcile, shares hold and the mix matches history.</p>}
    </>
  )
}
const LABELS = Object.fromEntries(Object.values(AUDIT_LABEL).map((v) => [v, 1]))

type SortKey = 'label' | 'volume' | 'nervousness' | 'frozen' | 'flips' | 'drift'
const ITEM_CAP = 300

function ItemsView({ ds, an, onOpen }: { ds: Dataset; an: Analysis; onOpen: (n: number) => void }) {
  const [sort, setSort] = useState<SortKey>('nervousness')
  const [q, setQ] = useState('')
  const val = (n: number): number | string => {
    const m = an.nodes[n]
    return sort === 'label' ? ds.nodes[n].label : sort === 'volume' ? m.volume : sort === 'nervousness' ? m.nervousness : sort === 'frozen' ? m.frozenChurnLatest : sort === 'flips' ? m.flipCount : m.driftPct
  }
  const rows = ds.leafNode
    .filter((n) => !q || `${ds.nodes[n].label} ${pathOf(ds, n)}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => { const x = val(a), y = val(b); return typeof x === 'string' ? x.localeCompare(y as string) : (y as number) - x })
  const H = ({ k, children, num }: { k: SortKey; children: string; num?: boolean }) => (
    <th className={num ? 'num' : ''} aria-sort={sort === k ? (k === 'label' ? 'ascending' : 'descending') : undefined}><button type="button" className="th-btn" onClick={() => setSort(k)}>{children}{sort === k ? ' ↓' : ''}</button></th>
  )
  return (
    <>
      <div className="view-head"><h3 className="view-title">All items</h3><input type="search" placeholder="Filter items" aria-label="Filter items" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="table-scroll">
        <table className="data items">
          <thead><tr><H k="label">Item</H><th>Horizon by snapshot</th><H k="volume" num>Volume</H><H k="nervousness">Nervousness</H><H k="frozen" num>Window churn</H><H k="flips" num>Flips</H><H k="drift" num>Drift</H><th>Noise test</th></tr></thead>
          <tbody>
            {rows.slice(0, ITEM_CAP).map((n) => {
              const m = an.nodes[n]
              return <tr key={n}>
                <td><button type="button" className="link" onClick={() => onOpen(n)}>{ds.nodes[n].label}</button><small className="block muted">{pathOf(ds, n)}</small></td>
                <td><Sparkline values={m.horizonTrend} /></td>
                <td className="num">{fmtQty(m.volume)}</td>
                <td><NervMeter value={m.nervousness} /></td>
                <td className="num">{fmtPct(m.frozenChurnLatest)}</td>
                <td className="num">{m.flipCount}</td>
                <td className="num">{m.driftPct >= 0 ? '+' : ''}{(m.driftPct * 100).toFixed(1)}%</td>
                <td><VerdictChip verdict={m.noise.verdict} /></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
      {rows.length > ITEM_CAP && <p className="muted small">Showing the first {ITEM_CAP} of {rows.length.toLocaleString('en-US')}. Filter to narrow, or export Items CSV for all of them.</p>}
    </>
  )
}

function AccuracyView({ ds, an, onOpen }: { ds: Dataset; an: Analysis; onOpen: (n: number) => void }) {
  const a = an.summary.accuracy
  if (!a) return <div className="empty-inline"><h3>No actuals in this file</h3><p>Stability checks do not need actuals. To see error by lag and whether revisions helped, map an actuals column, or add rows with a blank snapshot and an actual quantity.</p></div>
  return (
    <>
      <h3 className="view-title">Accuracy waterfall: error by lag</h3>
      <p className="accuracy-line">{accuracyLine(a)}</p>
      <div className="acc-stats">
        <div><b>{fmtQty(a.helpUnits)}</b><span>units of error removed by revisions</span></div>
        <div><b>{fmtQty(a.hurtUnits)}</b><span>units of error added by revisions</span></div>
        <div><b>{Number.isFinite(a.fvaVsNaive) ? `${a.fvaVsNaive >= 0 ? '+' : '-'}${(Math.abs(a.fvaVsNaive) * 100).toFixed(1)}` : 'n/a'}</b><span>points of forecast value add against naive</span></div>
      </div>
      <LagChart rows={a.byLag} title="Portfolio forecast error by lag" />
      <p className="muted small">Measured at item level and summed, so offsetting item errors cannot cancel. Naive repeats the last actual known at each snapshot.</p>
      <TopRevisers ds={ds} an={an} onOpen={onOpen} />
    </>
  )
}

function TopRevisers({ ds, an, onOpen }: { ds: Dataset; an: Analysis; onOpen: (n: number) => void }) {
  const rows = an.findings.filter((f) => f.kind === 'stability').slice(0, 8)
  if (!rows.length) return null
  return (
    <>
      <h3 className="view-title spaced">The busiest revisers</h3>
      <ul className="reviser-list">{rows.map((f) => <li key={f.id}><button type="button" className="link" onClick={() => onOpen(f.node)}>{f.title}</button> <span className="muted">{f.reason}</span></li>)}</ul>
    </>
  )
}

function ReportView({ source, ds }: { source: NonNullable<Source>; ds: Dataset }) {
  const facts = `${ds.S} snapshots from ${fmtDay(ds.snapshots[0])} to ${fmtDay(ds.snapshots[ds.S - 1])}, ${ds.L} items, ${ds.P} periods, bucket size about ${ds.gapDays} days. Hierarchy: ${ds.levels.join(' > ') || 'none'}. Stated parent totals: ${ds.stated.size}. Actuals: ${ds.hasActuals ? 'yes' : 'no'}.`
  if (source.kind === 'sample') return <><h3 className="view-title">Import report</h3><p>{facts}</p><p className="muted">This is a built-in synthetic sample, so nothing was rejected. Use Get the CSV on the start page to try the importer.</p></>
  const r = source.report
  return (
    <>
      <div className="view-head">
        <h3 className="view-title">Import report</h3>
        {r.bad.length > 0 && <button type="button" className="btn ghost small" onClick={() => download('rejected-rows.csv', toCsv([['file', 'line', 'reason', 'row'], ...r.bad.map((b) => [b.file, b.line, b.reason, b.raw])]))}>Download problem rows</button>}
      </div>
      <p>{facts}</p>
      <div className="import-stats">
        <div><b>{r.total.toLocaleString('en-US')}</b><span>rows in the files</span></div>
        <div><b>{r.kept.toLocaleString('en-US')}</b><span>rows used</span></div>
        <div className={r.bad.length ? 'warn' : ''}><b>{r.bad.length.toLocaleString('en-US')}</b><span>rows with problems</span></div>
        <div><b>{r.parentRows.toLocaleString('en-US')}</b><span>stated parent rows</span></div>
      </div>
      {r.duplicates > 0 && <p className="notice-inline">{r.duplicates.toLocaleString('en-US')} rows repeated the same snapshot, item and period and were added together. That usually means the file has a dimension that is not mapped.</p>}
      {r.bad.length === 0
        ? <p className="empty-inline">Every row was read cleanly.</p>
        : <>
            <ul className="reason-list">{Object.entries(r.reasons).sort((x, y) => y[1] - x[1]).map(([k, n]) => <li key={k}><b>{n.toLocaleString('en-US')}</b> {k}</li>)}</ul>
            <div className="table-scroll"><table className="data"><thead><tr><th>File</th><th className="num">Line</th><th>Problem</th><th>Row</th></tr></thead><tbody>{r.bad.slice(0, 100).map((b, i) => <tr key={i}><td>{b.file}</td><td className="num">{b.line}</td><td>{b.reason}</td><td className="mono-cell">{b.raw}</td></tr>)}</tbody></table></div>
            {r.bad.length > 100 && <p className="muted small">Showing the first 100. The download has all of them.</p>}
          </>}
    </>
  )
}
