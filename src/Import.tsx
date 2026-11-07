// Upload and column mapping. Nothing here leaves the page: files are decoded in memory and handed to the engine.
import { useMemo, useRef, useState } from 'react'
import { buildRows, emptyReport, guessMapping, parseCsv, parseDate, type CleanRow, type ImportReport, type Mapping, type ParsedCsv } from './engine/csv.ts'
import { Lock } from './ui.tsx'

interface FileIn { name: string; csv: ParsedCsv; map: Mapping }
export interface Imported { name: string; rows: CleanRow[]; report: ImportReport; keep: boolean }

// Excel's "Unicode text" is UTF-16 and older exports are Windows-1252, so plain utf-8 decoding is not enough.
async function decode(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf)
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return new TextDecoder('windows-1252').decode(buf) }
}

const FIELDS: { key: keyof Mapping; label: string; req?: boolean; longOnly?: boolean; hint?: string }[] = [
  { key: 'snapshot', label: 'Snapshot date', hint: 'When this version was published' },
  { key: 'item', label: 'Item', req: true },
  { key: 'family', label: 'Family' },
  { key: 'region', label: 'Region' },
  { key: 'customer', label: 'Customer' },
  { key: 'period', label: 'Period', req: true, longOnly: true, hint: 'The month or week being forecast' },
  { key: 'qty', label: 'Forecast quantity', req: true, longOnly: true },
  { key: 'actual', label: 'Actuals', longOnly: true },
  { key: 'measure', label: 'Measure', hint: 'Column saying forecast or actual' },
]

export function Dropzone({ onFiles, error }: { onFiles: (f: File[]) => void; error?: string }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div>
      <button
        type="button"
        className={`dropzone${over ? ' over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]) }}
      >
        <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <b>Drop forecast CSV files here, or choose files</b>
        <span>One file with many snapshots, or one file per snapshot. Long or wide. Comma, semicolon, tab or pipe.</span>
        <span className="drop-lock"><Lock size={12} /> Read locally. Nothing is uploaded.</span>
      </button>
      <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv" multiple hidden onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}

export async function readFiles(files: File[]): Promise<{ loaded: FileIn[]; error: string }> {
  const loaded: FileIn[] = []
  const errors: string[] = []
  for (const f of files) {
    if (/\.xlsx?$|\.xlsb$|\.xlsm$/i.test(f.name)) { errors.push(`${f.name} is an Excel workbook. Use Save As > CSV in Excel, then drop the CSV here.`); continue }
    const csv = parseCsv(await decode(f))
    if (!csv.rows.length) { errors.push(`${f.name} has no data rows.`); continue }
    loaded.push({ name: f.name, csv, map: guessMapping(csv, f.name) })
  }
  return { loaded, error: errors.join(' ') }
}

export function MappingStep({ files, onChange, onDone, onCancel }: { files: FileIn[]; onChange: (f: FileIn[]) => void; onDone: (r: Imported) => void; onCancel: () => void }) {
  const [active, setActive] = useState(0)
  const [keep, setKeep] = useState(false)
  const f = files[Math.min(active, files.length - 1)]
  const { rows, report } = useMemo(() => {
    const report = emptyReport()
    const rows = files.flatMap((x) => buildRows(x.csv, x.map, x.name, report))
    return { rows, report }
  }, [files])
  const snaps = useMemo(() => new Set(rows.flatMap((r) => (r.snapshot ? [r.snapshot] : []))).size, [rows])
  const items = useMemo(() => new Set(rows.flatMap((r) => (r.item ? [r.item] : []))).size, [rows])
  const set = (patch: Partial<Mapping>) => onChange(files.map((x) => (x === f ? { ...x, map: { ...x.map, ...patch } } : x)))
  // Files with identical headers almost always share a mapping, so apply a change to all of them.
  const setAll = (patch: Partial<Mapping>) => {
    const sig = f.csv.headers.join('|')
    onChange(files.map((x) => (x.csv.headers.join('|') === sig ? { ...x, map: { ...x.map, ...patch } } : x)))
  }
  const used = new Map<number, string>()
  for (const fd of FIELDS) { const c = f.map[fd.key] as number; if (c > -1 && (fd.longOnly ? f.map.format === 'long' : true)) used.set(c, fd.label) }
  if (f.map.format === 'wide') for (const c of f.map.periodCols) used.set(c, 'Period')
  const missing = rows.length === 0 ? 'No usable rows with this mapping yet.' : snaps < 2 ? `Found ${snaps} snapshot${snaps === 1 ? '' : 's'}. Comparing needs at least 2, so add another file or map the snapshot column.` : items === 0 ? 'No items found.' : ''
  const needsFixed = f.map.snapshot === -1
  return (
    <section className="mapping" aria-label="Column mapping">
      <div className="mapping-head">
        <div>
          <p className="eyebrow">Step 2 of 2</p>
          <h2>Check the column mapping</h2>
          <p className="muted">Best guesses are filled in. Rows with a blank item, or an item called TOTAL or ALL, are read as stated parent totals, which turns on the sum and rounding checks.</p>
        </div>
        <button type="button" className="btn ghost" onClick={onCancel}>Back</button>
      </div>
      {files.length > 1 && (
        <div className="seg" role="tablist" aria-label="Files">
          {files.map((x, i) => <button type="button" role="tab" aria-selected={x === f} key={x.name + i} className={x === f ? 'on' : ''} onClick={() => setActive(i)}>{x.name}</button>)}
        </div>
      )}
      <div className="mapping-grid">
        <div className="panel map-fields">
          <label className="field">
            <span>Layout</span>
            <div className="seg">
              <button type="button" className={f.map.format === 'long' ? 'on' : ''} onClick={() => setAll({ format: 'long' })}>Long: one row per period</button>
              <button type="button" className={f.map.format === 'wide' ? 'on' : ''} onClick={() => setAll({ format: 'wide' })}>Wide: one column per period</button>
            </div>
          </label>
          {FIELDS.filter((x) => !(x.longOnly && f.map.format === 'wide')).map((fd) => (
            <label className="field" key={fd.key}>
              <span>{fd.label}{fd.req ? ' *' : ''}{fd.hint && <small>{fd.hint}</small>}</span>
              <select value={f.map[fd.key] as number} onChange={(e) => setAll({ [fd.key]: +e.target.value })}>
                <option value={-1}>Not in this file</option>
                {f.csv.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </select>
            </label>
          ))}
          {needsFixed && (
            <label className="field">
              <span>Snapshot date for {f.name} *<small>No snapshot column, so this whole file is one version</small></span>
              <input type="date" value={parseDate(f.map.fixedSnapshot) ?? ''} onChange={(e) => set({ fixedSnapshot: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span>Ambiguous dates like 03/04/2026</span>
            <select value={f.map.dateOrder} onChange={(e) => setAll({ dateOrder: e.target.value as Mapping['dateOrder'] })}>
              <option value="mdy">Month first (Mar 4)</option>
              <option value="dmy">Day first (3 Apr)</option>
            </select>
          </label>
          <label className="field">
            <span>Numbers like 1.000<small>Semicolon files usually mean decimal commas</small></span>
            <select value={f.map.decimal} onChange={(e) => setAll({ decimal: e.target.value as Mapping['decimal'] })}>
              <option value="dot">1.000 is one (1,000.5)</option>
              <option value="comma">1.000 is a thousand (1.000,5)</option>
            </select>
          </label>
          {f.map.format === 'wide' && <p className="muted small">{f.map.periodCols.length} period columns detected from the headers.</p>}
        </div>
        <div className="map-right">
          <div className="panel preview">
            <span className="mono-label">{f.name}: first rows, {f.csv.rows.length.toLocaleString('en-US')} in total</span>
            <div className="table-scroll">
              <table className="data">
                <thead><tr>{f.csv.headers.map((h, i) => <th key={i} className={used.has(i) ? 'mapped' : ''}>{h}{used.has(i) && <small>{used.get(i)}</small>}</th>)}</tr></thead>
                <tbody>{f.csv.rows.slice(0, 6).map((r, i) => <tr key={i}>{f.csv.headers.map((_, c) => <td key={c} className={used.has(c) ? 'mapped' : ''}>{r[c] ?? ''}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </div>
          <div className="panel import-sum">
            <div className="import-stats">
              <div><b>{report.kept.toLocaleString('en-US')}</b><span>rows read</span></div>
              <div className={report.bad.length ? 'warn' : ''}><b>{report.bad.length.toLocaleString('en-US')}</b><span>rows with problems</span></div>
              <div><b>{snaps}</b><span>snapshots</span></div>
              <div><b>{items}</b><span>items</span></div>
            </div>
            {Object.keys(report.reasons).length > 0 && (
              <ul className="reason-list">{Object.entries(report.reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => <li key={r}><b>{n.toLocaleString('en-US')}</b> {r}</li>)}</ul>
            )}
            {missing && <p className="form-error" role="alert">{missing}</p>}
            <label className="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep this data on this device between visits (off by default)</label>
            <button type="button" className="btn primary" disabled={!!missing} onClick={() => onDone({ name: files.length === 1 ? files[0].name : `${files.length} files`, rows, report, keep })}>Run the trust check</button>
          </div>
        </div>
      </div>
    </section>
  )
}
export type { FileIn }
