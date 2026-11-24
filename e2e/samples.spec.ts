import { readFileSync } from 'node:fs'
import { chooseFiles, csvFile, expect, importCsv, openApp, openSample, openTab, runCheck, test } from './helpers.ts'

const rankRows = (page: import('@playwright/test').Page) => page.locator('.rank-row')

test.describe('samples', () => {
  test('the clean control stays quiet', async ({ page }) => {
    await openSample(page, 'control')
    await expect(page.getByRole('heading', { name: 'Nothing to chase' })).toBeVisible()
    await expect(rankRows(page)).toHaveCount(0)
    const kpi = (label: string) => page.locator('.kpi').filter({ hasText: label })
    await expect(kpi('Distorted by the split')).toContainText('0')
    await expect(kpi('Distorted by the split')).toContainText('0.0% of horizon volume')
    await expect(kpi('Item nervousness')).toContainText('0 nervous')
    await openTab(page, /Split audit/)
    await expect(page.getByText('The split checks out: totals reconcile, shares hold and the mix matches history.')).toBeVisible()
    await expect(page.locator('.type-card.hit')).toHaveCount(0)
    await expect(page.getByText('Synthetic sample.')).toBeVisible()
  })

  test('the bad-split sample ranks the split first', async ({ page }) => {
    await openSample(page, 'cpg')
    await expect(rankRows(page).first()).toContainText('BEV-LEMON-330')
    await expect(rankRows(page).first()).toContainText('Share jump, flat parent')
    await expect(rankRows(page).nth(1)).toContainText('BEV-COLA-330')
    await expect(rankRows(page).nth(1)).toContainText('Share jump, flat parent')
    // The reason states exact shares and quantity for the first finding.
    await expect(rankRows(page).first().locator('.rank-reason')).toHaveText(
      "BEV-LEMON-330's share of Beverages / North America went up from 20% to 36% while the Beverages / North America total stayed flat, moving 73,426 units with no demand change above it.")
    await expect(page.locator('.kpi').filter({ hasText: 'Distorted by the split' })).not.toContainText('0.0%')
    // Every defect the sample plants is found by its own check.
    await openTab(page, /Split audit/)
    for (const t of ['Sum mismatch', 'Share jump, flat parent', 'Inactive item got volume', 'Split differs from actual mix']) {
      await expect(page.locator('.type-card.hit').filter({ hasText: t }), t).toHaveCount(1)
    }
  })

  test('the electronics sample is nervous in the near term, not in the split', async ({ page }) => {
    await openSample(page, 'electronics')
    await expect(rankRows(page).first().locator('.rank-meta .tag')).toHaveText(/Flip-flopping|Near-term churn|Real change/)
    await expect(page.locator('.kpi').filter({ hasText: 'Item nervousness' })).not.toContainText('0 nervous')
    await expect(page.locator('.kpi').filter({ hasText: 'Distorted by the split' })).toContainText('0')
  })

  test('the real EIA sample opens and says where its data comes from', async ({ page }) => {
    await openSample(page, 'eia-fuels')
    await expect(page.getByText('Public EIA data')).toBeVisible()
    await expect(page.getByText('Synthetic sample.')).toHaveCount(0)
    await openTab(page, /Import report/)
    await expect(page.getByText(/12 snapshots from .* 7 items/)).toBeVisible()
  })

  test('each sample opens from the start page and Change data returns there', async ({ page }) => {
    await openApp(page)
    const cards = page.locator('.sample-card')
    await expect(cards).toHaveCount(4)
    for (const name of ['Consumer goods', 'Electronics', 'Clean control', 'U.S. fuel demand (real)']) {
      await cards.filter({ hasText: name }).getByRole('button', { name: 'Open' }).click()
      await expect(page.locator('.data-pill b')).toHaveText(name)
      await expect(page.locator('.workspace')).toBeVisible()
      await page.getByRole('button', { name: 'Change data' }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' })).toBeVisible()
    }
  })

  test('keys move through the findings and switch views', async ({ page }) => {
    await openSample(page, 'cpg')
    const selected = page.locator('.rank-row[aria-selected="true"]')
    await expect(selected).toContainText('BEV-LEMON-330')
    await page.keyboard.press('j')
    await expect(selected).toContainText('BEV-COLA-330')
    await page.keyboard.press('k')
    await expect(selected).toContainText('BEV-LEMON-330')
    await page.keyboard.press('4')
    await expect(page.getByRole('tab', { name: /Items/ })).toHaveAttribute('aria-selected', 'true')
  })

  test('Open detail shows the item drawer and Escape closes it', async ({ page }) => {
    await openSample(page, 'cpg')
    const dialog = page.getByRole('dialog', { name: 'Detail for BEV-LEMON-330' })
    await expect(dialog).toBeHidden()
    await page.locator('.rank-row').first().getByRole('button', { name: 'Open detail' }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.locator('.rank-row').nth(1).dblclick()
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-COLA-330' })).toBeVisible()
  })

  // Counts how many times the detail drawer closes, so "opened and closed again in the same keystroke" cannot slip by.
  const countCloses = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const w = window as unknown as { __closes: number }
    w.__closes = 0
    document.querySelector('dialog.drawer')!.addEventListener('close', () => { w.__closes++ })
  })
  const closes = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __closes: number }).__closes)

  test('Enter opens the detail for the selected finding and leaves it open', async ({ page }) => {
    await openSample(page, 'cpg')
    await countCloses(page)
    await page.locator('.rank-row').first().click()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-LEMON-330' })).toBeVisible()
    expect(await closes(page)).toBe(0)
    await expect(page.locator('.drawer-close')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => closes(page)).toBe(1)
  })

  test('Enter opens the second finding after clicking it, as the README promises', async ({ page }) => {
    await openSample(page, 'cpg')
    await countCloses(page)
    await page.locator('.rank-row').nth(1).click()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-COLA-330' })).toBeVisible()
    expect(await closes(page)).toBe(0)
  })

  test('Enter opens the detail after moving with j, and j and k then step through it', async ({ page }) => {
    await openSample(page, 'cpg')
    await countCloses(page)
    await page.keyboard.press('j')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-COLA-330' })).toBeVisible()
    await page.keyboard.press('k')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-LEMON-330' })).toBeVisible()
    expect(await closes(page)).toBe(0)
  })

  test('holding Enter does not close the detail it just opened', async ({ page }) => {
    await openSample(page, 'cpg')
    await countCloses(page)
    await page.locator('.rank-row').first().click()
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')   // a key that is already down repeats
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-LEMON-330' })).toBeVisible()
    expect(await closes(page)).toBe(0)
  })

  test('Enter still works on buttons: Open detail opens, Close closes', async ({ page }) => {
    await openSample(page, 'cpg')
    await countCloses(page)
    await page.locator('.rank-row').first().getByRole('button', { name: 'Open detail' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-LEMON-330' })).toBeVisible()
    expect(await closes(page)).toBe(0)
    await page.keyboard.press('Enter')   // focus is on Close
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => closes(page)).toBe(1)
    // Enter on the findings list opens it again afterwards, once, and it stays.
    await page.locator('.rank-row').first().click()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Detail for BEV-LEMON-330' })).toBeVisible()
    await expect.poll(() => closes(page)).toBe(1)
  })

  test('a sample CSV imports back to the same answers', async ({ page }) => {
    await openApp(page)
    const get = async (name: string) => {
      const [d] = await Promise.all([page.waitForEvent('download'), page.locator('.sample-card').filter({ hasText: name }).getByRole('button', { name: 'Get the CSV' }).click()])
      return { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') }
    }
    const control = await get('Clean control')
    expect(control.name).toBe('control-synthetic.csv')
    const bad = await get('Consumer goods')
    expect(bad.name).toBe('cpg-synthetic.csv')

    await importCsv(page, csvFile(control.name, control.text))
    await runCheck(page)
    await expect(page.getByRole('heading', { name: 'Nothing to chase' })).toBeVisible()

    await page.getByRole('button', { name: 'Forget this data' }).click()
    await chooseFiles(page, csvFile(bad.name, bad.text))
    await runCheck(page)
    await expect(rankRows(page).first()).toContainText('BEV-LEMON-330')
    await expect(rankRows(page).first().locator('.rank-reason')).toContainText('went up from 20% to 36%')
    await expect(rankRows(page).first().locator('.rank-reason')).toContainText('moving 73,426 units')
  })
})
