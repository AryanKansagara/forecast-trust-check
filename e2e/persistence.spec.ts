import { csvFile, expect, importCsv, openApp, openSample, openTab, runCheck, splitTable, test } from './helpers.ts'
import { longCsv } from './fixtures.ts'

const frozen = (page: import('@playwright/test').Page) => page.getByLabel('Frozen window in days')
const days = (page: import('@playwright/test').Page, d: number) => page.locator('.controls .seg button').filter({ hasText: new RegExp(`^${d}d$`) })
const workspace = (page: import('@playwright/test').Page) => page.locator('.workspace')

test.describe('what survives a reload', () => {
  test('the chosen sample, view and settings come back', async ({ page }) => {
    await openApp(page)
    await page.locator('.sample-card').filter({ hasText: 'Consumer goods' }).getByRole('button', { name: 'Open' }).click()
    await expect(workspace(page)).toBeVisible()
    await days(page, 60).click()
    await page.getByLabel('Signal at').selectOption('3')
    await page.getByLabel('Share jump at').selectOption('0.1')
    await openTab(page, /Items/)
    await expect(frozen(page)).toHaveValue('60')

    // Open /app again with no query: nothing in the address says which sample this was.
    await page.goto('/app')
    await expect(workspace(page)).toBeVisible()
    await expect(page.locator('.data-pill b')).toHaveText('Consumer goods')
    await expect(frozen(page)).toHaveValue('60')
    await expect(page.getByLabel('Signal at')).toHaveValue('3')
    await expect(page.getByLabel('Share jump at')).toHaveValue('0.1')
    await expect(page.getByRole('tab', { name: /Items/ })).toHaveAttribute('aria-selected', 'true')
    await page.reload()
    await expect(page.getByRole('tab', { name: /Items/ })).toHaveAttribute('aria-selected', 'true')
    await expect(days(page, 60)).toHaveClass(/on/)
  })

  test('settings are stored in this browser only', async ({ page }) => {
    await openSample(page, 'control')
    await days(page, 90).click()
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ftc.settings') ?? '{}').frozenDays)).toBe(90)
    const keys = await page.evaluate(() => Object.keys(localStorage).sort())
    expect(keys).toEqual(['ftc.settings'])
    expect(await page.evaluate(() => document.cookie)).toBe('')
  })

  test('an upload is forgotten on reload unless the box to keep it was ticked', async ({ page }) => {
    await importCsv(page, csvFile('long.csv', longCsv()))
    await expect(page.getByLabel(/Keep this data on this device/)).not.toBeChecked()
    await runCheck(page)
    await expect(page.locator('.data-pill b')).toHaveText('long.csv')
    expect(await page.evaluate(() => localStorage.getItem('ftc.upload'))).toBeNull()
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' })).toBeVisible()
    await expect(page.locator('.data-pill')).toHaveCount(0)
  })

  test('a kept upload survives a reload, keeps its numbers, and Forget this data removes it', async ({ page }) => {
    await importCsv(page, csvFile('long.csv', longCsv()))
    await page.getByLabel(/Keep this data on this device/).check()
    await runCheck(page)
    await openTab(page, /Split audit/)
    const before = await splitTable(page)
    expect(before.V1.slice(0, 3)).toEqual(['330', '423', '+93'])

    await page.reload()
    await expect(page.locator('.data-pill b')).toHaveText('long.csv')
    await openTab(page, /Split audit/)
    expect(await splitTable(page)).toEqual(before)
    await openTab(page, /Import report/)
    await expect(page.getByText('Every row was read cleanly.')).toBeVisible()

    await page.getByRole('button', { name: 'Forget this data' }).click()
    expect(await page.evaluate(() => localStorage.getItem('ftc.upload'))).toBeNull()
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' })).toBeVisible()
  })

  test('opening a sample replaces a kept upload', async ({ page }) => {
    await importCsv(page, csvFile('long.csv', longCsv()))
    await page.getByLabel(/Keep this data on this device/).check()
    await runCheck(page)
    await page.goto('/app?sample=control')
    await expect(page.locator('.data-pill b')).toHaveText('Clean control')
  })

  test('saved data that is not even JSON is ignored instead of breaking the page', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('ftc.settings', '{not json'); localStorage.setItem('ftc.upload', '{also not json') })
    await openApp(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' })).toBeVisible()
  })

  const startHeading = (page: import('@playwright/test').Page) => page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' })

  test('a saved sample id that no longer exists is ignored', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ftc.settings', '{"sample":"nope"}'))
    await page.goto('/app')
    await expect(startHeading(page)).toBeVisible()
    await page.reload()
    await expect(startHeading(page)).toBeVisible()
  })

  // Every one of these parses as JSON but is not what the page wrote. Each used to blank the page on every reload.
  const WRONG_SHAPE: [string, string, string][] = [
    ['settings that are null', 'ftc.settings', 'null'],
    ['settings that are a number', 'ftc.settings', '5'],
    ['settings that are a list', 'ftc.settings', '[1,2]'],
    ['an unknown saved sample', 'ftc.settings', '{"sample":"nope"}'],
    ['a saved sample that is not text', 'ftc.settings', '{"sample":{"id":"cpg"}}'],
    ['settings of the wrong types', 'ftc.settings', '{"frozenDays":"soon","z":null,"share":[],"tab":"nope"}'],
    ['an upload whose rows are a number', 'ftc.upload', '{"rows":5}'],
    ['an upload that is null', 'ftc.upload', 'null'],
    ['an upload with rows that are not rows', 'ftc.upload', '{"name":"x","rows":[1,2,3],"report":{}}'],
    ['an upload with no report', 'ftc.upload', '{"name":"x","rows":[]}'],
    ['an upload with a report that is not one', 'ftc.upload', '{"name":"x","rows":[{"snapshot":"2026-01-05","item":"A","family":"","region":"","customer":"","period":"2026-03-01","qty":1,"actual":null}],"report":5}'],
  ]
  for (const [label, key, value] of WRONG_SHAPE) {
    test(`${label}: the start page opens, also after a reload`, async ({ page }) => {
      await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1') } }, [key, value])
      await page.goto('/app')
      await expect(startHeading(page)).toBeVisible()
      await page.reload()
      await expect(startHeading(page)).toBeVisible()
      await page.locator('.sample-card').filter({ hasText: 'Clean control' }).getByRole('button', { name: 'Open' }).click()
      await expect(workspace(page)).toBeVisible()
    })
  }

  test('one bad saved setting does not throw away the others', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('ftc.settings', '{"sample":"control","frozenDays":14,"z":"high","tab":"items"}'))
    await page.goto('/app')
    await expect(page.locator('.data-pill b')).toHaveText('Clean control')
    await expect(frozen(page)).toHaveValue('14')
    await expect(page.getByRole('tab', { name: /Items/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Signal at')).toHaveValue('2.5')
  })

  test('a settings link restores the view and sample, and holds no uploaded data', async ({ page }) => {
    await openSample(page, 'cpg')
    await days(page, 14).click()
    await openTab(page, /Split audit/)
    await page.getByRole('button', { name: 'Copy settings link' }).click()
    await expect(page).toHaveURL(/\/app#v=.+/)
    const link = page.url()
    await page.context().clearCookies()
    const fresh = await page.context().newPage()
    await fresh.goto(link)
    await expect(fresh.locator('.data-pill b')).toHaveText('Consumer goods')
    await expect(fresh.getByLabel('Frozen window in days')).toHaveValue('14')
    await expect(fresh.getByRole('tab', { name: /Split audit/ })).toHaveAttribute('aria-selected', 'true')
    await fresh.close()
  })

  test('a settings link made from an upload carries no rows, and a broken link is explained', async ({ page }) => {
    await importCsv(page, csvFile('long.csv', longCsv()))
    await runCheck(page)
    await page.getByRole('button', { name: 'Copy settings link' }).click()
    await expect(page).toHaveURL(/#v=/)
    const hash = new URL(page.url()).hash
    expect(hash.length).toBeLessThan(400)
    await page.goto('about:blank')   // a same-document hash change would not run the page's start-up again
    await page.goto('/app#v=%%%not-a-link')
    await expect(page.getByRole('status').filter({ hasText: 'That shared link could not be read, so default settings are in use.' })).toBeVisible()
  })
})
