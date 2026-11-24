import { chooseFiles, csvFile, download, expect, importCsv, openTab, parseCsv, runCheck, splitTable, stat, test } from './helpers.ts'
import { EXPECTED_DECIMAL_COMMA, EXPECTED_MISMATCH, EXPECTED_SPLIT, MONTHS, SNAP, SNAP_WEEKLY, V1, V2, WEEKS, decimalCommaCsv, longCsv, statedFor, wideCsv } from './fixtures.ts'

const { v1, v2 } = EXPECTED_SPLIT
const layout = (page: import('@playwright/test').Page) => page.locator('.map-fields .seg').first().locator('button.on')

// The waterfall's rotated column labels are the periods the importer worked out, so a date read wrongly shows up here.
const MONTH_LABELS = ['Mar 26', 'Apr 26', 'May 26']
const WEEK_LABELS = ['2 Mar', '9 Mar', '16 Mar']   // ISO weeks 10, 11 and 12 of 2026 start on these Mondays

async function expectHandWorkedSplit(page: import('@playwright/test').Page, periods = MONTH_LABELS) {
  await openTab(page, /Waterfall/)
  await expect(page.locator('.view-panel svg.waterfall text.axis[transform]')).toHaveText(periods)
  await openTab(page, /Split audit/)
  const t = await splitTable(page)
  expect(t.V1).toEqual([v1.before, v1.after, v1.change, v1.shareBefore, v1.shareAfter, v1.points])
  expect(t.V2).toEqual([v2.before, v2.after, v2.change, v2.shareBefore, v2.shareAfter, v2.points])
  await expect(page.locator('.flow-line')).toHaveText(EXPECTED_SPLIT.flowLine)
}

test.describe('import', () => {
  test('a long file with ISO dates gives the hand-worked totals', async ({ page }) => {
    await importCsv(page, csvFile('long.csv', longCsv()))
    await expect(layout(page)).toHaveText('Long: one row per period')
    await expect(stat(page, 'rows read')).toHaveText('18')
    await expect(stat(page, 'rows with problems')).toHaveText('0')
    await expect(stat(page, 'snapshots')).toHaveText('3')
    await expect(stat(page, 'items')).toHaveText('2')
    await runCheck(page)
    await expectHandWorkedSplit(page)
    await openTab(page, /Items/)
    // Item volume is the latest snapshot's horizon: V1 131+141+151 and V2 189+199+209.
    const volumes = Object.fromEntries((await page.locator('table.items tbody tr').allInnerTexts()).map((r) => { const c = r.split('\t'); return [c[0].split('\n')[0], c[2].trim()] }))
    expect(volumes).toEqual({ V1: '423', V2: '597' })
  })

  test('a wide file with ISO week columns gives the same totals', async ({ page }) => {
    await importCsv(page, csvFile('wide.csv', wideCsv()))
    await expect(layout(page)).toHaveText('Wide: one column per period')
    await expect(page.getByText('3 period columns detected from the headers.')).toBeVisible()
    await expect(stat(page, 'rows read')).toHaveText('6')
    await expect(stat(page, 'snapshots')).toHaveText('3')
    await runCheck(page)
    await expectHandWorkedSplit(page, WEEK_LABELS)
  })

  for (const [label, headers] of [['CW10 2026', ['CW10 2026', 'CW11 2026', 'CW12 2026']], ['KW 10/2026', ['KW 10/2026', 'KW 11/2026', 'KW 12/2026']]] as const) {
    test(`week headers written ${label} are read as ISO weeks`, async ({ page }) => {
      await importCsv(page, csvFile('wide.csv', wideCsv().replace(WEEKS.join(','), headers.join(','))))
      await expect(page.getByText('3 period columns detected from the headers.')).toBeVisible()
      await runCheck(page)
      await expectHandWorkedSplit(page, WEEK_LABELS)
    })
  }

  test('a semicolon file with decimal commas is read as decimal commas', async ({ page }) => {
    await importCsv(page, csvFile('decimal.csv', decimalCommaCsv()))
    await expect(page.getByLabel(/Numbers like 1.000/)).toHaveValue('comma')
    await expect(stat(page, 'rows with problems')).toHaveText('0')
    await runCheck(page)
    await openTab(page, /Split audit/)
    const t = await splitTable(page)
    const d = EXPECTED_DECIMAL_COMMA
    expect(t.V1.slice(0, 3)).toEqual([d.v1.before, d.v1.after, d.v1.change])
    expect(t.V2.slice(0, 3)).toEqual([d.v2.before, d.v2.after, d.v2.change])
  })

  test('choosing dot decimals for the same file changes the numbers, as the label says', async ({ page }) => {
    await importCsv(page, csvFile('decimal.csv', decimalCommaCsv()))
    await page.getByLabel(/Numbers like 1.000/).selectOption('dot')
    await runCheck(page)
    await openTab(page, /Split audit/)
    // 2.000 is now two, not two thousand: V2 snapshot 2 is 2 + 2.1 + 2.2 = 6.3.
    expect((await splitTable(page)).V2[0]).toBe('6.3')
  })

  for (const [label, encode] of [
    ['pipe separated', (t: string) => Buffer.from(t.replaceAll(',', '|'))],
    ['tab separated with CRLF line ends', (t: string) => Buffer.from(t.replaceAll(',', '\t').replaceAll('\n', '\r\n'))],
    ['UTF-16 with a byte order mark', (t: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')])],
    ['with a UTF-8 byte order mark and a blank first line', (t: string) => Buffer.from('\ufeff\n' + t)],
  ] as const) {
    test(`the same data ${label} gives the same totals`, async ({ page }) => {
      await importCsv(page, csvFile('export.csv', encode(longCsv())))
      await expect(stat(page, 'rows read')).toHaveText('18')
      await expect(stat(page, 'rows with problems')).toHaveText('0')
      await runCheck(page)
      await expectHandWorkedSplit(page)
    })
  }

  test('one file per snapshot, with the date taken from each file name', async ({ page }) => {
    const perSnap = SNAP.map((snap, s) => csvFile(`forecast_${snap}.csv`, ['family,item,period,forecast_qty', ...MONTHS.flatMap((m, p) => [`Valves,V1,${m},${V1[s][p]}`, `Valves,V2,${m},${V2[s][p]}`])].join('\n')))
    await importCsv(page, ...perSnap)
    await expect(page.getByRole('tablist', { name: 'Files' }).getByRole('tab')).toHaveCount(3)
    await expect(stat(page, 'snapshots')).toHaveText('3')
    await expect(stat(page, 'rows read')).toHaveText('18')
    await runCheck(page)
    await expectHandWorkedSplit(page)
  })

  test('a day-first date column is detected and ambiguous dates follow the chosen order', async ({ page }) => {
    // 13/01/2026 can only be day first, so the whole column is read day first and 05/02/2026 is 5 February.
    const text = ['snapshot,item,period,qty', '13/01/2026,A,2026-03,10', '05/02/2026,A,2026-03,12', '20/02/2026,A,2026-03,15'].join('\n')
    await importCsv(page, csvFile('dmy.csv', text))
    await expect(page.getByLabel(/Ambiguous dates/)).toHaveValue('dmy')
    await expect(stat(page, 'snapshots')).toHaveText('3')
    await runCheck(page)
    await openTab(page, /Import report/)
    await expect(page.getByText(/3 snapshots from 13 Jan 26 to 20 Feb 26/)).toBeVisible()
  })

  test.describe('parent totals', () => {
    test('totals that do not sum are reported with the exact quantity', async ({ page }) => {
      await importCsv(page, csvFile('stated.csv', longCsv({ stated: statedFor() })))
      await expect(stat(page, 'rows read')).toHaveText('27')
      await runCheck(page)
      const finding = page.locator('.rank-row').filter({ hasText: 'Sum mismatch' })
      await expect(finding).toHaveCount(1)
      await expect(finding.locator('.rank-units')).toHaveText(`${EXPECTED_MISMATCH.units} units`)
      await expect(finding.locator('.rank-reason')).toHaveText(
        `Valves's stated total is ${EXPECTED_MISMATCH.direction} than its items add up to by ${EXPECTED_MISMATCH.units} units across ${EXPECTED_MISMATCH.periods}, so whoever plans from the items sees a different number from whoever reads the total.`)
      await openTab(page, /Split audit/)
      await expect(page.locator('.type-card.hit')).toHaveCount(1)
      await expect(page.locator('.type-card.hit')).toContainText('20')
      await expect(page.locator('.type-card.hit')).toContainText('Sum mismatch')
      await expect(page.locator('.type-card.hit')).toContainText('1 finding')
      await expect(page.getByText('so the sum and rounding checks did not run')).toHaveCount(0)
      await openTab(page, /Import report/)
      await expect(page.getByText('Stated parent totals: 1.')).toBeVisible()
      await expect(page.locator('.import-stats > div').filter({ hasText: 'stated parent rows' }).locator('b')).toHaveText('9')
    })

    test('the exact quantity also reaches the findings export', async ({ page }) => {
      await importCsv(page, csvFile('stated.csv', longCsv({ stated: statedFor() })))
      await runCheck(page)
      const { text } = await download(page, 'Findings CSV')
      const rows = parseCsv(text)
      const col = Object.fromEntries(rows[0].map((h, i) => [h, i]))
      const mismatch = rows.slice(1).filter((r) => r[col.finding] === 'Sum mismatch')
      expect(mismatch).toHaveLength(1)
      expect(mismatch[0][col.item_or_node]).toBe('Valves')
      expect(mismatch[0][col.units]).toBe('20')
      expect(mismatch[0][col.periods_affected]).toBe('2')
    })

    test('totals that match, written as TOTAL or a blank item, raise nothing', async ({ page }) => {
      const exact = SNAP.map((_, s) => MONTHS.map((__, p) => V1[s][p] + V2[s][p]))
      await importCsv(page, csvFile('stated.csv', longCsv({ stated: exact }).replaceAll(',Valves,,', ',Valves,TOTAL,')))
      await expect(stat(page, 'rows read')).toHaveText('27')
      await runCheck(page)
      await expect(page.locator('.rank-row').filter({ hasText: /Sum mismatch|Rounding loss/ })).toHaveCount(0)
      await openTab(page, /Split audit/)
      await expect(page.locator('.type-card.hit').filter({ hasText: /Sum mismatch|Rounding loss/ })).toHaveCount(0)
      await expect(page.getByText('so the sum and rounding checks did not run')).toHaveCount(0)
    })

    test('without any totals the app says the sum checks did not run', async ({ page }) => {
      await importCsv(page, csvFile('long.csv', longCsv()))
      await runCheck(page)
      await openTab(page, /Split audit/)
      await expect(page.getByText(/This file has no stated parent totals, so the sum and rounding checks did not run/)).toBeVisible()
    })
  })

  test('rows that cannot be read are listed with their line and reason, and can be downloaded', async ({ page }) => {
    const lines = longCsv().trimEnd().split('\n')
    lines[3] = lines[3].replace('2026-04', 'sometime')   // line 4
    lines[5] = lines[5].replace(/,\d+$/, ',lots')        // line 6
    await importCsv(page, csvFile('messy.csv', lines.join('\n') + '\n'))
    await expect(stat(page, 'rows read')).toHaveText('16')
    await expect(stat(page, 'rows with problems')).toHaveText('2')
    await runCheck(page)
    await openTab(page, /Import report/)
    await expect(page.locator('.reason-list li')).toContainText(['Unreadable period', 'Quantity is not a number'])
    const rows = page.locator('table.data tbody tr')
    await expect(rows.filter({ hasText: 'Unreadable period' })).toContainText('messy.csv')
    await expect(rows.filter({ hasText: 'Unreadable period' }).locator('td').nth(1)).toHaveText('4')
    await expect(rows.filter({ hasText: 'Quantity is not a number' }).locator('td').nth(1)).toHaveText('6')
    const { name, text } = await download(page, 'Download problem rows')
    expect(name).toBe('rejected-rows.csv')
    const parsed = parseCsv(text)
    expect(parsed[0]).toEqual(['file', 'line', 'reason', 'row'])
    expect(parsed.slice(1).map((r) => [r[1], r[2]]).sort()).toEqual([['4', 'Unreadable period'], ['6', 'Quantity is not a number']])
  })
})
