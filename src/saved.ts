// What the page keeps in localStorage is only a hint. It can be stale (an older version of the app wrote it), edited by
// hand or damaged, and it parses as JSON of any shape, so it is checked here before anything trusts it. Anything that
// does not have the expected shape is ignored, exactly like text that is not JSON at all.
import type { BadRow, CleanRow, ImportReport } from './engine/csv.ts'

export interface SavedSettings { sample?: string; frozenDays?: number; z?: number; share?: number; tab?: string }
export interface SavedUpload { name: string; rows: CleanRow[]; report: ImportReport }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown): v is string => typeof v === 'string'
const nullable = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)
const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = (v: unknown): v is string => text(v) && DAY.test(v)

function parse(raw: string | null): unknown {
  try { return JSON.parse(raw ?? 'null') } catch { return null }
}

/** The saved settings. Each field is kept only if it has the right type, so one bad field does not discard the rest. */
export function parseSettings(raw: string | null, tabIds: readonly string[]): SavedSettings {
  const v = parse(raw)
  if (!isObject(v)) return {}
  const out: SavedSettings = {}
  if (text(v.sample)) out.sample = v.sample
  if (finite(v.frozenDays)) out.frozenDays = v.frozenDays
  if (finite(v.z)) out.z = v.z
  if (finite(v.share)) out.share = v.share
  if (text(v.tab) && tabIds.includes(v.tab)) out.tab = v.tab
  return out
}

const ROW_FIELDS: [keyof CleanRow, (v: unknown) => boolean][] = [
  ['snapshot', nullable(day)], ['item', text], ['family', text], ['region', text], ['customer', text], ['period', day], ['qty', nullable(finite)], ['actual', nullable(finite)],
]
const isRow = (r: unknown): r is CleanRow => isObject(r) && ROW_FIELDS.every(([k, ok]) => ok(r[k]))
const isBad = (b: unknown): b is BadRow => isObject(b) && text(b.file) && finite(b.line) && text(b.reason) && text(b.raw)
const isReport = (r: unknown): r is ImportReport =>
  isObject(r) && ['total', 'kept', 'duplicates', 'parentRows', 'actualsRows'].every((k) => finite(r[k]))
  && Array.isArray(r.bad) && r.bad.every(isBad)
  && isObject(r.reasons) && Object.values(r.reasons).every(finite)
  && (r.skipped === undefined || (Array.isArray(r.skipped) && r.skipped.every(text)))

/** A kept upload, or null when the saved value is missing or is not an upload this version can read. */
export function parseUpload(raw: string | null): SavedUpload | null {
  const v = parse(raw)
  if (!isObject(v) || !text(v.name) || !Array.isArray(v.rows) || !v.rows.every(isRow) || !isReport(v.report)) return null
  return { name: v.name, rows: v.rows, report: v.report }
}
