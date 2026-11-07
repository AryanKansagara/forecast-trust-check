import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, emptyReport, guessMapping, parseCsv, parseDate, parseNumber, type CleanRow } from './csv.ts'
import { buildDataset, inWindow, lagOf, nodeCube, sliceSnapshots } from './cube.ts'
import { computeAccuracy, computeMetrics, DEFAULTS, testRevision } from './metrics.ts'
import { disaggFlow, runAudit } from './audit.ts'
import { analyze } from './rank.ts'
import { squarify } from './layout.ts'
import { csvCell, findingsCsv } from './export.ts'
import { sampleCsv, SAMPLES } from '../samples.ts'

const row = (snapshot: string | null, item: string, period: string, qty: number | null, extra: Partial<CleanRow> = {}): CleanRow =>
  ({ snapshot, item, family: '', region: '', customer: '', period, qty, actual: null, ...extra })
const POOL = { horizon: 0.01, frozen: 0.01 }
const leafIdx = (ds: ReturnType<typeof buildDataset>, label: string) => ds.nodes.findIndex((n) => n.label === label && n.leaf > -1)

test('csv: quotes, embedded newlines, semicolons, BOM and blank lines', () => {
  const c = parseCsv('﻿item;note;qty\r\n"A;1";"two\nlines";5\r\n\r\nB;"say ""hi""";6\r\n')
  assert.equal(c.delimiter, ';')
  assert.deepEqual(c.headers, ['item', 'note', 'qty'])
  assert.deepEqual(c.rows[0], ['A;1', 'two\nlines', '5'])
  assert.equal(c.rows[1][1], 'say "hi"')
  assert.equal(c.lineOf[1], 5) // reports the real line, counting the embedded newline and the blank line
})

test('numbers: thousands, decimal commas, accounting negatives, junk', () => {
  assert.equal(parseNumber('1,234.5'), 1234.5)
  assert.equal(parseNumber('1.234,5'), 1234.5)
  assert.equal(parseNumber('1,234'), 1234)
  assert.equal(parseNumber('12,5'), 12.5)
  assert.equal(parseNumber('1 234'), 1234)
  assert.equal(parseNumber('(120)'), -120)
  assert.equal(parseNumber('N/A'), null)
  assert.equal(parseNumber('1.2.3'), null)
  assert.equal(parseNumber('1.000'), 1)
  assert.equal(parseNumber('1.000', 'comma'), 1000)
  assert.equal(parseNumber('1.234,5', 'comma'), 1234.5)
  assert.equal(parseNumber('oops', 'comma'), null)
})

test('dates: ISO, month and week buckets, day-first, impossible dates', () => {
  assert.equal(parseDate('2026-03-15'), '2026-03-15')
  assert.equal(parseDate('2026-03'), '2026-03-01')
  assert.equal(parseDate('Mar-26'), '2026-03-01')
  assert.equal(parseDate('2026-W01'), '2025-12-29')
  assert.equal(parseDate('15/03/2026'), '2026-03-15')
  assert.equal(parseDate('03/04/2026', 'dmy'), '2026-04-03')
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(parseDate('soon'), null)
})

test('import: long format reports every bad row with its line and reason', () => {
  const csv = parseCsv(['snapshot,item,period,qty', '2026-01-05,A,2026-02,100', 'garbage,A,2026-03,100', '2026-01-05,A,whenever,100', '2026-01-05,A,2026-04,lots', '2026-01-05,A,2026-05,-5', '2026-01-05,,2026-06,5'].join('\n'))
  const report = emptyReport()
  const rows = buildRows(csv, guessMapping(csv), 'f.csv', report)
  assert.equal(rows.length, 1)
  assert.equal(report.total, 6)
  assert.equal(report.bad.length, 5)
  assert.equal(report.reasons['Unreadable snapshot date'], 1)
  assert.equal(report.reasons['Unreadable period'], 1)
  assert.equal(report.reasons['Quantity is not a number'], 1)
  assert.equal(report.reasons['Negative quantity'], 1)
  assert.equal(report.bad[0].line, 3)
})

test('import: wide format detected, snapshot taken from the filename, actuals via a measure column', () => {
  const csv = parseCsv('item,measure,2026-01,2026-02,2026-03\nA,Forecast,10,20,\nA,Actual,9,,\nB,Forecast,x,5,6\n')
  const map = guessMapping(csv, 'plan_2026-01-05.csv')
  assert.equal(map.format, 'wide')
  assert.equal(map.fixedSnapshot, '2026-01-05')
  const report = emptyReport()
  const rows = buildRows(csv, map, 'plan_2026-01-05.csv', report)
  assert.equal(rows.filter((r) => r.qty !== null).length, 4)
  assert.deepEqual(rows.filter((r) => r.actual !== null).map((r) => [r.item, r.period, r.actual]), [['A', '2026-01-01', 9]])
  assert.equal(report.reasons['Some period cells unreadable (rest of row kept)'], 1)
})

test('import: a TOTAL row is a stated parent, and a gap in its path is rejected', () => {
  const csv = parseCsv('snapshot,family,region,item,period,qty\n2026-01-05,F,R,TOTAL,2026-02,10\n2026-01-05,,R,,2026-02,10\n')
  const report = emptyReport()
  const rows = buildRows(csv, guessMapping(csv), 'f.csv', report)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].item, '')
  assert.equal(report.reasons['Parent total has a gap in its hierarchy path'], 1)
})

test('sample CSV round-trips through the importer to the same cube', () => {
  const rows = SAMPLES[0].rows()
  const csv = parseCsv(sampleCsv(rows))
  const report = emptyReport()
  const back = buildRows(csv, guessMapping(csv), 's.csv', report)
  assert.equal(report.bad.length, 0)
  assert.deepEqual([...nodeCube(buildDataset(back), 0).q], [...nodeCube(buildDataset(rows), 0).q])
})

test('windows and lags follow the bucket calendar', () => {
  const ds = buildDataset([row('2026-03-15', 'A', '2026-03-01', 1), row('2026-03-15', 'A', '2026-04-01', 1), row('2026-03-15', 'A', '2026-05-01', 1), row('2026-03-15', 'A', '2026-06-01', 1)])
  assert.equal(inWindow(ds, 0, 0, 30), true) // the half-finished month still counts
  assert.equal(inWindow(ds, 0, 1, 30), true)
  assert.equal(inWindow(ds, 0, 2, 30), false)
  assert.equal(lagOf(ds, 0, 2), 2)
})

test('metrics: revision WAPE, flip-flops and undone units on a hand-worked item', () => {
  const series = [100, 120, 100, 120]
  const snaps = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']
  const ds = buildDataset(snaps.map((s, i) => row(s, 'A', '2026-02-02', series[i])))
  const m = computeMetrics(ds, leafIdx(ds, 'A'), DEFAULTS, POOL)
  assert.ok(Math.abs(m.revWape - 60 / 320) < 1e-9)
  assert.equal(m.flipCount, 2)
  assert.equal(m.flipUnits, 40)
  assert.equal(m.flipRate, 1)
  assert.ok(m.cov > 0.08 && m.cov < 0.11)
  assert.equal(m.undoneShare, 1)
})

test('metrics: small moves under the tolerance are not flips, and a steady climb has none', () => {
  const snaps = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']
  const wiggle = buildDataset(snaps.map((s, i) => row(s, 'A', '2026-02-02', [1000, 1005, 1000, 1005][i])))
  assert.equal(computeMetrics(wiggle, leafIdx(wiggle, 'A'), DEFAULTS, POOL).flipCount, 0)
  const climb = buildDataset(snaps.map((s, i) => row(s, 'A', '2026-02-02', [100, 110, 120, 130][i])))
  const m = computeMetrics(climb, leafIdx(climb, 'A'), DEFAULTS, POOL)
  assert.equal(m.flipCount, 0)
  assert.ok(m.driftPct > 0.08)
  assert.equal(m.sameSignShare, 1)
})

test('frozen-window churn only counts periods inside the window', () => {
  const rows = ['2026-01-05', '2026-01-12'].flatMap((s, i) => [row(s, 'A', '2026-01-19', i ? 150 : 100), row(s, 'A', '2026-06-01', i ? 900 : 100)])
  const ds = buildDataset(rows)
  const m = computeMetrics(ds, leafIdx(ds, 'A'), { ...DEFAULTS, frozenDays: 30 }, POOL)
  assert.equal(m.frozenUnitsLatest, 50)
  assert.equal(m.frozenChurnLatest, 0.5)
})

test('noise test: an ordinary revision is noise, an outlier is signal, a thin history says so', () => {
  const calm = [0.01, -0.012, 0.008, -0.009, 0.011, -0.01]
  assert.equal(testRevision([...calm, 0.012], 0.01, DEFAULTS, 'horizon').verdict, 'noise')
  assert.equal(testRevision([...calm, 0.2], 0.01, DEFAULTS, 'horizon').verdict, 'signal')
  assert.equal(testRevision([0.01, 0.2], 0.01, DEFAULTS, 'horizon').verdict, 'thin')
  // Statistically odd but immaterial is still not worth a meeting.
  assert.equal(testRevision([0, 0, 0, 0, 0, 0.015], 0, DEFAULTS, 'horizon').verdict, 'noise')
  // A slow slide in one direction is a signal even though no single step stands out.
  const slide = testRevision([0.01, -0.01, 0.01, -0.01, -0.024, -0.024, -0.024], 0.008, DEFAULTS, 'horizon')
  assert.equal(slide.verdict, 'signal')
  assert.equal(slide.sustained, true)
})

test('noise test: a flip-flopper is not an outlier at odd or even history lengths', () => {
  const alt = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? 0.2 : -0.2) * (1 + i * 0.01))
  for (let n = 5; n <= 12; n++) assert.equal(testRevision(alt(n), 0.005, DEFAULTS, 'frozen').verdict, 'noise', `length ${n}`)
})

test('replay: thrashing electronics items read as noise at every snapshot count, never as real change', () => {
  const ds = buildDataset(SAMPLES[1].rows())
  for (let k = 7; k <= ds.S; k++) {
    const an = analyze(sliceSnapshots(ds, k))
    assert.equal(an.nodes[leafIdx(ds, 'NB-14-PRO')].noise.verdict, 'noise', `snapshot ${k}`)
  }
})

test('accuracy by lag and whether revisions helped', () => {
  const snaps = ['2026-01-05', '2026-01-12', '2026-01-19']
  const helps = buildDataset([...snaps.map((s, i) => row(s, 'A', '2026-01-26', [100, 80, 60][i])), row(null, 'A', '2026-01-26', null, { actual: 60 }), row('2026-01-19', 'A', '2026-02-02', 60)])
  const a = computeAccuracy(helps, leafIdx(helps, 'A'))
  assert.equal(a.verdict, 'helped')
  assert.equal(a.helpUnits, 40)
  assert.equal(a.byLag.find((l) => l.lag === 3)?.wape, 40 / 60)
  assert.equal(a.byLag.find((l) => l.lag === 2)?.wape, 20 / 60)
  assert.equal(a.byLag.find((l) => l.lag === 1)?.wape, 0)
  const hurts = buildDataset([...snaps.map((s, i) => row(s, 'A', '2026-01-26', [60, 80, 100][i])), row(null, 'A', '2026-01-26', null, { actual: 60 })])
  assert.equal(computeAccuracy(hurts, leafIdx(hurts, 'A')).verdict, 'hurt')
})

test('audit: sum mismatch vs lot-size rounding, with the exact quantity', () => {
  const p = (r: string, qty: number) => row('2026-01-05', '', '2026-02-02', qty, { family: r })
  const it = (r: string, i: string, qty: number) => row('2026-01-05', i, '2026-02-02', qty, { family: r })
  const ds = buildDataset([p('Off', 1000), it('Off', 'A', 500.5), it('Off', 'B', 400.5), p('Lots', 100), it('Lots', 'C', 48), it('Lots', 'D', 24)])
  const a = runAudit(ds)
  const mismatch = a.findings.find((f) => f.type === 'sum_mismatch')!
  assert.equal(ds.nodes[mismatch.parent].label, 'Off')
  assert.equal(mismatch.qtyLatest, 99)
  const round = a.findings.find((f) => f.type === 'rounding_loss')!
  assert.equal(ds.nodes[round.parent].label, 'Lots')
  assert.equal(round.qtyLatest, 28)
  assert.equal(round.lot, 24)
})

test('audit: one stray actual is not a sales history', () => {
  const snap = (s: string) => [row(s, 'A', '2026-06-01', 500, { family: 'F' }), row(s, 'B', '2026-06-01', 500, { family: 'F' })]
  const a = runAudit(buildDataset([...snap('2026-01-05'), ...snap('2026-01-12'), row(null, 'A', '2026-01-01', null, { family: 'F', actual: 900 })]))
  assert.equal(a.findings.filter((f) => f.type === 'mix_divergence' || f.type === 'new_item').length, 0)
})

test('import: a semicolon file defaults to decimal commas, so 1.000 is a thousand', () => {
  const csv = parseCsv('snapshot;item;period;qty\n2026-01-05;A;2026-02;1.000\n')
  const rows = buildRows(csv, guessMapping(csv), 'f.csv', emptyReport())
  assert.equal(rows[0].qty, 1000)
})

test('duplicates are summed and counted in the report', () => {
  const report = emptyReport()
  const ds = buildDataset([row('2026-01-05', 'A', '2026-02-02', 5), row('2026-01-05', 'A', '2026-02-02', 7)], report)
  assert.equal(report.duplicates, 1)
  assert.equal(nodeCube(ds, 0).q[0], 12)
})

test('audit: a share jump needs a flat parent; a genuine parent move is not distortion', () => {
  const snap = (s: string, a: number, b: number) => [row(s, 'A', '2026-06-01', a, { family: 'F' }), row(s, 'B', '2026-06-01', b, { family: 'F' })]
  const flat = runAudit(buildDataset([...snap('2026-01-05', 500, 500), ...snap('2026-01-12', 700, 300)]))
  const jumps = flat.findings.filter((f) => f.type === 'share_jump')
  assert.equal(jumps.length, 2)
  assert.equal(jumps[0].qtyLatest, 200)
  const grown = runAudit(buildDataset([...snap('2026-01-05', 500, 500), ...snap('2026-01-12', 900, 500)]))
  assert.equal(grown.findings.filter((f) => f.type === 'share_jump').length, 0)
})

test('sankey flow conserves volume on both sides', () => {
  const snap = (s: string, a: number, b: number, c: number) => [row(s, 'A', '2026-06-01', a, { family: 'F' }), row(s, 'B', '2026-06-01', b, { family: 'F' }), row(s, 'C', '2026-06-01', c, { family: 'F' })]
  const ds = buildDataset([...snap('2026-01-05', 500, 300, 200), ...snap('2026-01-12', 300, 500, 300)])
  const f = disaggFlow(ds, ds.nodes.findIndex((n) => n.label === 'F'), 0, 1)
  assert.equal(f.totalA, 1000)
  assert.equal(f.totalB, 1100)
  assert.equal(f.added, 100)
  const leaving = f.links.filter((l) => l.from !== -1).reduce((t, l) => t + l.qty, 0)
  const arriving = f.links.filter((l) => l.to !== -1).reduce((t, l) => t + l.qty, 0)
  assert.ok(Math.abs(leaving - 1000) < 1e-9)
  assert.ok(Math.abs(arriving - 1100) < 1e-9)
})

test('sankey ignores periods only one snapshot knows about, so a rolling horizon is not parent growth', () => {
  const ds = buildDataset([row('2026-01-05', 'A', '2026-06-01', 100, { family: 'F' }), row('2026-01-05', 'B', '2026-06-01', 100, { family: 'F' }), row('2026-01-12', 'A', '2026-06-01', 100, { family: 'F' }), row('2026-01-12', 'B', '2026-06-01', 100, { family: 'F' }), row('2026-01-12', 'A', '2026-07-01', 500, { family: 'F' })])
  const f = disaggFlow(ds, ds.nodes.findIndex((n) => n.label === 'F'), 0, 1)
  assert.equal(f.totalB, 200)
  assert.equal(f.added, 0)
})

test('sample: consumer goods trips every planted disaggregation defect', () => {
  const ds = buildDataset(SAMPLES[0].rows())
  const an = analyze(ds)
  const has = (type: string, label: string) => an.audit.findings.some((f) => f.type === type && f.qtyLatest > 0 && ds.nodes[f.child > -1 ? f.child : f.parent].label === label)
  assert.ok(has('share_jump', 'BEV-LEMON-330'))
  assert.ok(has('sum_mismatch', 'Europe'))
  assert.ok(has('rounding_loss', 'North America'))
  assert.equal(an.audit.findings.find((f) => f.type === 'rounding_loss')?.lot, 24)
  // A sibling that only lost volume to the jump is not a demand signal, even though its own move is unusual.
  const zero = an.findings.find((f) => f.title === 'BEV-ZERO-500')!
  assert.equal(zero.tag, 'Reallocated, flat parent')
  assert.ok(!zero.reason.includes('real change'))
  assert.ok(has('new_item', 'SNK-SEASALT-NEW'))
  assert.ok(has('inactive_item', 'BEV-RETRO-1L-DELISTED'))
  assert.ok(has('intermittent_smear', 'HC-GIFT-PACK'))
  assert.ok(has('mix_divergence', 'SNK-CRISP-200G'))
  assert.equal(an.findings[0].kind, 'disaggregation')
  assert.equal(an.findings.filter((f) => f.kind === 'disaggregation' && f.severity === 'high').length >= 3, true)
})

test('sample: electronics flags the thrashing items near-term, the real step as signal, and revisions that earned their keep', () => {
  const ds = buildDataset(SAMPLES[1].rows())
  const an = analyze(ds)
  const m = (label: string) => an.nodes[leafIdx(ds, label)]
  assert.ok(m('NB-14-PRO').nervousness >= 45)
  assert.ok(m('NB-14-PRO').flipCount > 10)
  assert.ok(m('AC-CABLE-C').nervousness < 20)
  assert.equal(m('PH-X1-128').noise.verdict, 'signal')
  assert.equal(m('NB-14-PRO').noise.verdict, 'noise')
  assert.equal(computeAccuracy(ds, leafIdx(ds, 'NB-14-PRO')).verdict, 'hurt')
  assert.equal(computeAccuracy(ds, leafIdx(ds, 'AC-DOCK-G2')).verdict, 'helped')
  assert.equal(an.findings.find((f) => f.title === 'PH-X1-128')?.tag, 'Real change')
  const firstFive = an.findings.slice(0, 5).map((f) => f.title)
  assert.ok(firstFive.includes('NB-14-PRO') || firstFive.includes('PH-X1-128'), firstFive.join())
})

test('sample: the clean control stays quiet', () => {
  const ds = buildDataset(SAMPLES[2].rows())
  const an = analyze(ds)
  assert.equal(an.summary.bands.nervous, 0)
  assert.equal(an.findings.filter((f) => f.severity === 'high').length, 0, an.findings.map((f) => f.title + ':' + f.tag).join())
  assert.equal(an.audit.findings.filter((f) => f.qtyLatest > 0).length, 0, an.audit.findings.map((f) => f.type).join())
})

test('replay: slicing to earlier snapshots hides the future, including actuals not yet known', () => {
  const ds = buildDataset(SAMPLES[1].rows())
  const cut = sliceSnapshots(ds, 6)
  assert.equal(cut.S, 6)
  assert.deepEqual([...cut.q.subarray(0, cut.P)], [...ds.q.subarray(0, ds.P)].map((v) => v))
  for (let p = 0; p < cut.P; p++) if (cut.perEnd[p] > cut.snapDay[5]) assert.ok(Number.isNaN(cut.a[p]))
  assert.equal(analyze(cut).nodes.length, ds.nodes.length)
})

test('treemap: areas are proportional and stay inside the box', () => {
  const rects = squarify([6, 6, 4, 3, 2, 2, 1, 0], 600, 400)
  assert.equal(rects.length, 7)
  for (const r of rects) { assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6) }
  assert.ok(Math.abs(rects.reduce((t, r) => t + r.w * r.h, 0) - 240000) < 1e-6)
  assert.ok(Math.abs(rects.find((r) => r.i === 0)!.w * rects.find((r) => r.i === 0)!.h - 60000) < 1e-6)
})

test('export: labels cannot execute as spreadsheet formulas, and commas stay quoted', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('-5 cases'), `'-5 cases`)
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell(-5), '-5')
  const ds = buildDataset(SAMPLES[0].rows())
  const csv = findingsCsv(ds, analyze(ds))
  assert.ok(csv.startsWith('rank,severity,type'))
  assert.ok(csv.split('\r\n').length > 5)
})
