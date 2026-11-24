import { chooseFiles, csvFile, expect, importCsv, openApp, openTab, runCheck, stat, test } from './helpers.ts'
import { longCsv, wideCsv } from './fixtures.ts'

// After any of these the app must say what is wrong and must not offer a score. A score would be a stable-looking
// answer built from nothing, so the workspace (its KPIs and ranked list) must never appear.
const noScore = async (page: import('@playwright/test').Page) => {
  await expect(page.locator('.workspace, .kpis, .rank-list, .empty-good')).toHaveCount(0)
  await expect(page.getByText('Nothing to chase')).toHaveCount(0)
}
const startPage = (page: import('@playwright/test').Page) => page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' })
const run = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Run the trust check' })

test.describe('files that are wrong, empty or cut short', () => {
  test('an Excel workbook is refused with the way forward', async ({ page }) => {
    await openApp(page)
    await chooseFiles(page, csvFile('plan.xlsx', Buffer.from('PK\u0003\u0004 not really a workbook')))
    await expect(page.getByRole('alert')).toHaveText('plan.xlsx is an Excel workbook. Use Save As > CSV in Excel, then drop the CSV here.')
    await expect(startPage(page)).toBeVisible()
    await noScore(page)
  })

  for (const [label, content] of [
    ['an empty file', ''],
    ['a file with only a header', 'snapshot_date,family,item,period,forecast_qty\n'],
    ['a file of blank lines', '\n\n\n'],
    ['a file cut off inside its header', 'snapshot_date,fam'],
    ['binary bytes', Buffer.from([0, 1, 2, 3, 255, 254, 9, 8, 7])],
  ] as const) {
    test(`${label} says it has no data rows`, async ({ page }) => {
      await openApp(page)
      await chooseFiles(page, csvFile('export.csv', content))
      await expect(page.getByRole('alert')).toHaveText('export.csv has no data rows.')
      await expect(startPage(page)).toBeVisible()
      await noScore(page)
    })
  }

  test('a good file dropped with an unreadable one still imports', async ({ page }) => {
    await openApp(page)
    await chooseFiles(page, csvFile('empty.csv', ''), csvFile('good.csv', longCsv()))
    await expect(page.getByRole('heading', { name: 'Check the column mapping' })).toBeVisible()
    await expect(stat(page, 'rows read')).toHaveText('18')
  })

  // KNOWN BUG, issue #4: the skipped file is never mentioned. test.fail() turns red once the app says so.
  test('a file skipped next to a good one is named somewhere', async ({ page }) => {
    test.fail(true, 'Issue #4: unreadable files dropped with readable ones are skipped silently')
    await openApp(page)
    await chooseFiles(page, csvFile('empty.csv', ''), csvFile('good.csv', longCsv()))
    await expect(page.getByRole('heading', { name: 'Check the column mapping' })).toBeVisible()
    await expect(page.getByText('empty.csv', { exact: false }).first()).toBeVisible({ timeout: 1500 })
  })

  test('a CSV about something else cannot be run', async ({ page }) => {
    await importCsv(page, csvFile('people.csv', 'name,email,city\nAnn,a@example.org,Oslo\nBob,b@example.org,Rome\n'))
    await expect(stat(page, 'rows read')).toHaveText('0')
    await expect(stat(page, 'rows with problems')).toHaveText('2')
    await expect(page.locator('.reason-list')).toContainText('No item and no hierarchy value')
    await expect(page.getByRole('alert')).toHaveText('No usable rows with this mapping yet.')
    await expect(run(page)).toBeDisabled()
    await noScore(page)
  })

  test('a file whose quantities are all text cannot be run', async ({ page }) => {
    await importCsv(page, csvFile('text.csv', longCsv().replace(/,(\d+)\n/g, ',n/a\n')))
    await expect(stat(page, 'rows read')).toHaveText('0')
    await expect(stat(page, 'rows with problems')).toHaveText('18')
    await expect(page.locator('.reason-list')).toContainText('18 Quantity is not a number')
    await expect(run(page)).toBeDisabled()
    await noScore(page)
  })

  test('a file with one snapshot cannot be run, because there is nothing to compare', async ({ page }) => {
    const oneSnapshot = longCsv().split('\n').filter((l, i) => i === 0 || l.startsWith('2026-01-05')).join('\n')
    await importCsv(page, csvFile('one.csv', oneSnapshot))
    await expect(stat(page, 'snapshots')).toHaveText('1')
    await expect(page.getByRole('alert')).toHaveText('Found 1 snapshot. Comparing needs at least 2, so add another file or map the snapshot column.')
    await expect(run(page)).toBeDisabled()
    await noScore(page)
  })

  test('a file cut off after its first snapshot cannot be run and reports the cut row', async ({ page }) => {
    const firstSnapshotThenCut = longCsv().split('\n').slice(0, 7).join('\n') + '\n2026-02-02,Valves,V1,2026'
    await importCsv(page, csvFile('cut.csv', firstSnapshotThenCut))
    await expect(stat(page, 'rows with problems')).toHaveText('1')
    await expect(page.locator('.reason-list')).toContainText('Unreadable period')
    await expect(page.getByRole('alert')).toContainText('Found 1 snapshot')
    await expect(run(page)).toBeDisabled()
    await noScore(page)
  })

  test('a long file cut mid-row reports the cut row instead of reading it as zero', async ({ page }) => {
    const text = longCsv().trimEnd()
    await importCsv(page, csvFile('cut.csv', text.slice(0, text.lastIndexOf(',2026-05'))))   // last row ends after the item
    await expect(stat(page, 'rows read')).toHaveText('17')
    await expect(stat(page, 'rows with problems')).toHaveText('1')
  })

  test('a wide file cut off mid-row reports the short row and keeps what it holds', async ({ page }) => {
    const text = wideCsv().trimEnd()
    await importCsv(page, csvFile('wide.csv', text.slice(0, text.lastIndexOf(',199'))))   // last row stops after V2's first quantity
    await expect(stat(page, 'rows read')).toHaveText('6')
    await expect(stat(page, 'rows with problems')).toHaveText('1')
    await expect(page.locator('.reason-list')).toContainText('Row has fewer columns than the header')
    await runCheck(page)
    await openTab(page, /Import report/)
    await expect(stat(page, 'rows with problems')).toHaveText('1')
    await expect(page.getByText('Every row was read cleanly.')).toHaveCount(0)
    await expect(page.getByRole('cell', { name: 'Row has fewer columns than the header (missing periods left blank, file may be cut off)' })).toBeVisible()
    await expect(page.getByRole('cell', { name: '2026-03-02 | Valves | V2 | 189' })).toBeVisible()
  })

  test('a wide file with complete rows and blank cells inside them is not reported', async ({ page }) => {
    await importCsv(page, csvFile('wide.csv', wideCsv().replace('V1,100,100,100', 'V1,100,,100').replace('V2,189,199,209', 'V2,189,199,')))
    await expect(stat(page, 'rows read')).toHaveText('6')
    await expect(stat(page, 'rows with problems')).toHaveText('0')
  })

  test('a file cut off inside a quoted field reports the swallowed row', async ({ page }) => {
    const text = longCsv().trimEnd()
    await importCsv(page, csvFile('quote.csv', text.slice(0, text.lastIndexOf('\n')) + '\n2026-03-02,"Valves,V2'))
    await expect(stat(page, 'rows with problems')).toHaveText('1')
  })

  test('snapshot dates nobody can read are reported, not guessed', async ({ page }) => {
    await importCsv(page, csvFile('dates.csv', longCsv().replaceAll('2026-02-02', 'someday')))
    await expect(stat(page, 'rows read')).toHaveText('12')
    await expect(stat(page, 'rows with problems')).toHaveText('6')
    await expect(page.locator('.reason-list')).toContainText('6 Unreadable snapshot date')
  })

  test('negative quantities are rejected rather than analysed', async ({ page }) => {
    await importCsv(page, csvFile('neg.csv', longCsv().replace(',100\n', ',-100\n')))
    await expect(stat(page, 'rows with problems')).toHaveText('1')
    await expect(page.locator('.reason-list')).toContainText('Negative quantity')
  })

  test('a wide file with unreadable period cells reports them', async ({ page }) => {
    await importCsv(page, csvFile('wide.csv', wideCsv().replace('V1,100,100,100', 'V1,100,n/a,100')))
    await expect(page.locator('.reason-list')).toContainText('Some period cells unreadable (rest of row kept)')
  })
})
