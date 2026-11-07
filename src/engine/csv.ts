// Tolerant CSV import: sniff the delimiter, guess a column mapping, then turn long or wide files into clean rows
// with an explicit report of everything that was rejected and why.

export interface ParsedCsv { headers: string[]; rows: string[][]; delimiter: string; firstDataLine: number; lineOf: number[] }

export function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8)
  let best = ','
  let bestScore = 0
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.map((l) => splitRecords(l, d)[0]?.length ?? 1)
    const min = Math.min(...counts)
    if (min < 2) continue
    const agree = counts.filter((c) => c === counts[0]).length / counts.length
    const score = counts[0] * agree
    if (score > bestScore) { bestScore = score; best = d }
  }
  return best
}

// Handles quotes, doubled quotes, embedded newlines and CRLF. Returns records plus the line each one started on.
function splitRecords(text: string, delim: string): string[][] & { lines?: number[] } {
  const out: string[][] & { lines?: number[] } = []
  const lines: number[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        cell += c
      }
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = '' }
    else if (c === delim) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      out.push(row); lines.push(rowLine)
      row = []; line++; rowLine = line
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); lines.push(rowLine) }
  out.lines = lines
  return out
}

export function parseCsv(raw: string): ParsedCsv {
  const text = raw.replace(/^﻿/, '')
  let delimiter = sniffDelimiter(text)
  // Excel's "sep=;" preamble.
  const sep = text.match(/^sep=(.)\r?\n/i)
  const body = sep ? text.slice(sep[0].length) : text
  if (sep) delimiter = sep[1]
  const recs = splitRecords(body, delimiter)
  const lineShift = sep ? 1 : 0
  const allLines = recs.lines ?? []
  let start = 0
  while (start < recs.length && recs[start].every((c) => c.trim() === '')) start++
  const headers = (recs[start] ?? []).map((h, i) => h.trim() || `Column ${i + 1}`)
  const rows: string[][] = []
  const lineOf: number[] = []
  for (let i = start + 1; i < recs.length; i++) {
    if (recs[i].every((c) => c.trim() === '')) continue
    rows.push(recs[i].map((c) => c.trim()))
    lineOf.push(allLines[i] + lineShift)
  }
  return { headers, rows, delimiter, firstDataLine: (allLines[start] ?? 1) + lineShift + 1, lineOf }
}

// Numbers: 1,234.5  1.234,5  1 234  (120)  12%  are all real things in planning exports.
// A lone "1.000" cannot be read without knowing the file's locale, so that choice is explicit and shown in the mapping step.
export type Decimal = 'dot' | 'comma'
export function parseNumber(s: string, decimal: Decimal = 'dot'): number | null {
  let t = s.trim().replace(/[\s ']/g, '')
  if (t === '') return null
  let neg = false
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1) }
  t = t.replace(/^[$€£]/, '')
  if (decimal === 'comma') {
    if (!/^[-+]?(\d{1,3}(\.\d{3})+|\d+)(,\d*)?$/.test(t)) return null
    const n = Number(t.replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(n) ? (neg ? -n : n) : null
  }
  const lastComma = t.lastIndexOf(',')
  const lastDot = t.lastIndexOf('.')
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.')
    else t = t.replace(/,/g, '')
  } else if (lastComma > -1) {
    // A single comma followed by exactly 3 digits is a thousands mark; otherwise it is a decimal comma.
    if (/^-?\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '')
    else if ((t.match(/,/g) ?? []).length === 1) t = t.replace(',', '.')
    else return null
  } else if ((t.match(/\./g) ?? []).length > 1) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
    else return null
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
const iso = (y: number, m: number, d: number): string | null => {
  const t = Date.UTC(y, m - 1, d)
  const dt = new Date(t)
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}
const fullYear = (y: number) => (y < 100 ? 2000 + y : y)

export type DateOrder = 'mdy' | 'dmy'

// ISO week 1 contains Jan 4th. Weeks normalise to their Monday.
function isoWeek(y: number, w: number): string | null {
  if (w < 1 || w > 53) return null
  const jan4 = new Date(Date.UTC(y, 0, 4))
  const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5
  return new Date(monday + (w - 1) * 7 * 864e5).toISOString().slice(0, 10)
}

// Everything normalises to an ISO day: a month bucket becomes its first day, a week bucket its Monday.
export function parseDate(raw: string, order: DateOrder = 'mdy'): string | null {
  const s = raw.trim()
  if (!s) return null
  let m: RegExpMatchArray | null
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/))) return iso(+m[1], +m[2], +m[3])
  if ((m = s.match(/^(\d{4})-?W(\d{1,2})$/i))) return isoWeek(+m[1], +m[2])
  if ((m = s.match(/^W(\d{1,2})[-\s/]+(\d{2,4})$/i))) return isoWeek(fullYear(+m[2]), +m[1])
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})$/))) return iso(+m[1], +m[2], 1)
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ].*)?$/))) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3])
    if (a > 12) return iso(y, b, a)
    if (b > 12) return iso(y, a, b)
    return order === 'dmy' ? iso(y, b, a) : iso(y, a, b)
  }
  if ((m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2,4})$/))) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]
    return mo ? iso(fullYear(+m[3]), mo, +m[1]) : null
  }
  if ((m = s.match(/^([A-Za-z]{3,9})[-\s/.']+(\d{1,2}),?[-\s/]+(\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]
    return mo ? iso(+m[3], mo, +m[2]) : null
  }
  if ((m = s.match(/^([A-Za-z]{3,9})[-\s/.']+(\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]
    return mo ? iso(fullYear(+m[2]), mo, 1) : null
  }
  return null
}

export interface Mapping {
  format: 'long' | 'wide'
  snapshot: number // -1 = taken from fixedSnapshot
  item: number
  family: number
  region: number
  customer: number
  period: number // long only
  qty: number // long only
  actual: number // long only, -1 = none
  measure: number // optional column saying forecast vs actual, -1 = none
  periodCols: number[] // wide only
  fixedSnapshot: string
  dateOrder: DateOrder
  decimal: Decimal
}

const pick = (headers: string[], res: RegExp[], skip: Set<number> = new Set()): number => {
  const norm = headers.map((h) => h.toLowerCase().trim())
  for (const r of res) {
    const i = norm.findIndex((h, idx) => !skip.has(idx) && r.test(h))
    if (i > -1) return i
  }
  return -1
}

const FILE_DATE = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/
export function dateFromFileName(name: string): string {
  const m = name.match(FILE_DATE)
  return m ? iso(+m[1], +m[2], +m[3]) ?? '' : ''
}

// If any date in a column has a first component above 12, the file is day-first.
function sniffDateOrder(values: string[]): DateOrder {
  for (const v of values) {
    const m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/)
    if (m && +m[1] > 12) return 'dmy'
    if (m && +m[2] > 12) return 'mdy'
  }
  return 'mdy'
}

export function guessMapping(csv: ParsedCsv, fileName = ''): Mapping {
  const { headers, rows } = csv
  const sample = rows.slice(0, 200)
  const snapshot = pick(headers, [/^snapshot/, /snapshot/, /^version/, /as[ _-]?of/, /^cycle/, /run[ _-]?date/, /^plan[ _-]?date/, /publish/])
  const measure = pick(headers, [/^measure/, /^key ?figure/, /^data ?type/, /^type$/, /^metric/])
  const taken = new Set([snapshot, measure])
  const period = pick(headers, [/^period/, /^bucket/, /^(target|forecast|demand)[ _-]?(date|month|week|period)/, /^week/, /^month/, /^date$/, /^time/], taken)
  const periodLikeCols = headers.map((h, i) => (i !== snapshot && parseDate(h) ? i : -1)).filter((i) => i > -1)
  const wide = periodLikeCols.length >= 3
  taken.add(period)
  const actual = pick(headers, [/^actual/, /actual/, /^sales$/, /^shipments?$/, /^history/], taken)
  taken.add(actual)
  const qty = pick(headers, [/^(forecast|fcst)([ _-]?(qty|quantity|units?|volume))?$/, /^(qty|quantity|units?|volume|demand)$/, /forecast|fcst|qty|quantity|units|volume|value|demand/], taken)
  taken.add(qty)
  const family = pick(headers, [/^(product[ _-]?)?family/, /^category/, /^brand/, /^product[ _-]?(group|line)/, /^segment/, /^division/], taken)
  taken.add(family)
  const region = pick(headers, [/^region/, /^geo/, /^market/, /^country/, /^site/, /^location/, /^plant/, /^dc$/], taken)
  taken.add(region)
  const customer = pick(headers, [/^customer/, /^account/, /^channel/, /^sold[ _-]?to/], taken)
  taken.add(customer)
  const item = pick(headers, [/^(item|sku|part|product|material)[ _-]?(id|code|no|number|name)?$/, /item|sku|part|material|product/], taken)
  const dateSample: string[] = []
  for (const r of sample) { if (snapshot > -1) dateSample.push(r[snapshot] ?? ''); if (period > -1) dateSample.push(r[period] ?? '') }
  return {
    format: wide ? 'wide' : 'long',
    snapshot, item, family, region, customer, period, qty, actual, measure,
    periodCols: periodLikeCols,
    fixedSnapshot: dateFromFileName(fileName),
    dateOrder: sniffDateOrder(dateSample),
    decimal: csv.delimiter === ';' ? 'comma' : 'dot', // semicolon files come from decimal-comma locales
  }
}

export interface CleanRow {
  snapshot: string | null // null = actuals-only row
  item: string // '' = a stated parent total
  family: string
  region: string
  customer: string
  period: string
  qty: number | null
  actual: number | null
}
export interface BadRow { file: string; line: number; reason: string; raw: string }
export interface ImportReport { total: number; kept: number; bad: BadRow[]; reasons: Record<string, number>; duplicates: number; parentRows: number; actualsRows: number }

export function emptyReport(): ImportReport { return { total: 0, kept: 0, bad: [], reasons: {}, duplicates: 0, parentRows: 0, actualsRows: 0 } }

const TOTAL_ITEM = /^(total|all|grand total|\*)$/i

export function buildRows(csv: ParsedCsv, map: Mapping, file: string, report: ImportReport): CleanRow[] {
  const out: CleanRow[] = []
  const bad = (i: number, reason: string) => {
    report.reasons[reason] = (report.reasons[reason] ?? 0) + 1
    if (report.bad.length < 5000) report.bad.push({ file, line: csv.lineOf[i], reason, raw: csv.rows[i].join(' | ').slice(0, 200) })
  }
  const col = (r: string[], i: number) => (i > -1 ? (r[i] ?? '').trim() : '')
  const fixed = parseDate(map.fixedSnapshot, map.dateOrder)
  const periodHeaders = map.format === 'wide'
    ? map.periodCols.map((c) => ({ c, day: parseDate(csv.headers[c], map.dateOrder) }))
    : []
  csv.rows.forEach((r, i) => {
    report.total++
    if (r.length !== csv.headers.length && r.length < 2) return bad(i, 'Row has too few columns')
    const measure = col(r, map.measure).toLowerCase()
    const isActualMeasure = /actual|sales|shipment|history/.test(measure)
    const snapRaw = col(r, map.snapshot)
    let snapshot: string | null = map.snapshot > -1 ? parseDate(snapRaw, map.dateOrder) : fixed
    const rawItem = col(r, map.item)
    const item = TOTAL_ITEM.test(rawItem) ? '' : rawItem
    const family = col(r, map.family), region = col(r, map.region), customer = col(r, map.customer)
    if (item === '' && rawItem === '' && !family && !region && !customer) return bad(i, 'No item and no hierarchy value')
    if (item === '') {
      // A stated total is only meaningful for a path with no gaps: family, then region, then customer.
      const used = [map.family, map.region, map.customer].filter((c) => c > -1)
      let gap = false, ended = false
      for (const c of used) { if (!col(r, c)) ended = true; else if (ended) gap = true }
      if (gap) return bad(i, 'Parent total has a gap in its hierarchy path')
    }
    if (map.format === 'long') {
      const period = parseDate(col(r, map.period), map.dateOrder)
      if (!period) return bad(i, 'Unreadable period')
      const qtyRaw = col(r, map.qty), actRaw = col(r, map.actual)
      const qtyV = qtyRaw === '' ? null : parseNumber(qtyRaw, map.decimal)
      const actV = actRaw === '' ? null : parseNumber(actRaw, map.decimal)
      if (qtyRaw !== '' && qtyV === null) return bad(i, 'Quantity is not a number')
      if (actRaw !== '' && actV === null) return bad(i, 'Actual is not a number')
      if ((qtyV ?? 0) < 0 || (actV ?? 0) < 0) return bad(i, 'Negative quantity')
      const qty = isActualMeasure ? null : qtyV
      const actual = isActualMeasure ? qtyV ?? actV : actV
      if (qty === null && actual === null) return bad(i, 'No quantity on the row')
      if (qty !== null && !snapshot) return bad(i, snapRaw || map.snapshot > -1 ? 'Unreadable snapshot date' : 'No snapshot date')
      if (qty === null) { report.actualsRows++; snapshot = null }
      if (item === '') report.parentRows++
      report.kept++
      out.push({ snapshot, item, family, region, customer, period, qty, actual })
      return
    }
    if (!snapshot && !isActualMeasure) return bad(i, snapRaw || map.snapshot > -1 ? 'Unreadable snapshot date' : 'No snapshot date')
    let cells = 0, badCells = 0
    for (const { c, day } of periodHeaders) {
      if (!day) continue
      const v = col(r, c)
      if (v === '') continue
      const n = parseNumber(v, map.decimal)
      if (n === null || n < 0) { badCells++; continue }
      cells++
      out.push(isActualMeasure
        ? { snapshot: null, item, family, region, customer, period: day, qty: null, actual: n }
        : { snapshot, item, family, region, customer, period: day, qty: n, actual: null })
    }
    if (!cells) return bad(i, badCells ? 'No readable quantity in any period column' : 'Row has no quantities')
    if (badCells) { const reason = 'Some period cells unreadable (rest of row kept)'; report.reasons[reason] = (report.reasons[reason] ?? 0) + 1; if (report.bad.length < 5000) report.bad.push({ file, line: csv.lineOf[i], reason, raw: csv.rows[i].join(' | ').slice(0, 200) }) }
    if (item === '') report.parentRows++
    if (isActualMeasure) report.actualsRows++
    report.kept++
  })
  return out
}
