import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, emptyReport, guessMapping, parseCsv } from './engine/csv.ts'
import { parseSettings, parseUpload } from './saved.ts'
import { sampleCsv, SAMPLES } from './samples.ts'

const TABS = ['waterfall', 'hierarchy', 'split', 'items', 'accuracy', 'report']
const settings = (v: unknown) => parseSettings(typeof v === 'string' ? v : JSON.stringify(v), TABS)

test('saved settings: a good value round-trips unchanged', () => {
  const good = { sample: 'cpg', frozenDays: 60, z: 3, share: 0.1, tab: 'items' }
  assert.deepEqual(settings({ ...good, extra: 1 }), good)
  assert.deepEqual(settings({ sample: null, frozenDays: 30, z: 2.5, share: 0.05, tab: 'waterfall' }), { frozenDays: 30, z: 2.5, share: 0.05, tab: 'waterfall' })
})

test('saved settings: anything that is not an object, or not JSON, is ignored', () => {
  for (const raw of [null, '', '{not json', 'null', '5', '"text"', 'true', '[]', '[1,2]', '{}']) assert.deepEqual(parseSettings(raw, TABS), {}, String(raw))
})

test('saved settings: a field of the wrong type is dropped and the others are kept', () => {
  assert.deepEqual(settings({ sample: 7, frozenDays: '30', z: null, share: [1], tab: 'nope' }), {})
  assert.deepEqual(settings({ sample: { id: 'cpg' }, frozenDays: 14, tab: 3 }), { frozenDays: 14 })
  assert.deepEqual(settings('{"frozenDays":1e999}'), {})   // Infinity is not a setting
  assert.deepEqual(settings({ frozenDays: 0 }), { frozenDays: 0 })   // unusual numbers are still numbers: the page already copes with them
  assert.deepEqual(settings({ z: 999 }), { z: 999 })
})

const sampleUpload = (id: string) => {
  const csv = parseCsv(sampleCsv(SAMPLES.find((s) => s.id === id)!.rows()))
  const report = emptyReport()
  const rows = buildRows(csv, guessMapping(csv), `${id}.csv`, report)
  return { name: `${id}.csv`, rows, report: { ...report, bad: report.bad.slice(0, 200) } }
}

test('saved upload: what the page itself saves is read back, for every sample', () => {
  for (const s of SAMPLES) {
    const saved = sampleUpload(s.id)
    assert.ok(saved.rows.length > 0)
    assert.deepEqual(parseUpload(JSON.stringify(saved)), saved, s.id)
  }
})

test('saved upload: a report with rejected rows and a list of skipped files round-trips', () => {
  const csv = parseCsv('snapshot_date,item,period,qty\n2026-01-05,A,2026-03,1\n2026-01-05,A,nope,2\n2026-02-02,A,2026-03,3\n')
  const base = emptyReport()
  const rows = buildRows(csv, guessMapping(csv), 'f.csv', base)
  assert.equal(base.bad.length, 1)
  const saved = { name: 'f.csv', rows, report: { ...base, skipped: ['empty.csv has no data rows.'] } }
  assert.deepEqual(parseUpload(JSON.stringify(saved)), saved)
})

test('saved upload: values of the wrong shape are ignored instead of trusted', () => {
  const good = sampleUpload('control')
  const bad: unknown[] = [
    null, 5, 'x', [], {}, { rows: 5 }, { rows: {} }, { rows: 'abc', name: 'x' }, { rows: [] },
    { name: 'x', rows: [] },                                                  // no report
    { name: 'x', rows: [], report: {} },
    { ...good, name: 3 },
    { ...good, name: undefined },
    { ...good, rows: [1, 2, 3] },
    { ...good, rows: [null] },
    { ...good, rows: [...good.rows.slice(0, 3), { ...good.rows[0], qty: 'ten' }] },
    { ...good, rows: [{ ...good.rows[0], period: 'someday' }] },
    { ...good, rows: [{ ...good.rows[0], snapshot: undefined }] },
    { ...good, rows: [{ ...good.rows[0], item: 5 }] },
    { ...good, report: null },
    { ...good, report: 5 },
    { ...good, report: { ...good.report, bad: 'none' } },
    { ...good, report: { ...good.report, bad: [{ file: 'f' }] } },
    { ...good, report: { ...good.report, reasons: [] } },
    { ...good, report: { ...good.report, reasons: { a: 'b' } } },
    { ...good, report: { ...good.report, kept: '5' } },
    { ...good, report: { ...good.report, skipped: 'empty.csv' } },
    { ...good, report: { ...good.report, skipped: [1] } },
  ]
  bad.forEach((v, i) => assert.equal(parseUpload(JSON.stringify(v)), null, `case ${i}: ${JSON.stringify(v).slice(0, 80)}`))
  for (const raw of [null, '', '{not json', 'null', 'undefined']) assert.equal(parseUpload(raw), null)
})
