import { readFileSync } from 'node:fs'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

/**
 * Every test runs signed out. Requests to another origin are aborted and recorded, and the test fails if one got out,
 * or if the page throws an uncaught error or logs a console error. The app promises it sends nothing.
 */
export interface Guard { external: string[]; errors: string[]; ignoreConsole: RegExp[] }

export const test = base.extend<{ guard: Guard }>({
  guard: [async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin
    const guard: Guard = { external: [], errors: [], ignoreConsole: [] }
    // A request only reaches these handlers if the browser let it leave the page. Requests the page's own
    // Content Security Policy refuses never get this far, which is the behaviour the app relies on.
    await page.route((url) => /^https?:$/.test(url.protocol) && url.origin !== origin, (route) => {
      guard.external.push(`${route.request().method()} ${route.request().url()}`)
      return route.abort('blockedbyclient')
    })
    page.on('pageerror', (e) => guard.errors.push(`uncaught: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !guard.ignoreConsole.some((re) => re.test(m.text()))) guard.errors.push(`console: ${m.text()}`) })
    await use(guard)
    expect(guard.external, 'requests that left the page').toEqual([])
    expect(guard.errors, 'page errors').toEqual([])
  }, { auto: true }],
})
export { expect }

export const csvFile = (name: string, text: string | Buffer) => ({ name, mimeType: 'text/csv', buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) })

export async function openApp(page: Page, path = '/app') {
  await page.goto(path)
  await expect(page.getByRole('heading', { level: 1, name: 'Bring two or more forecast snapshots' }).or(page.locator('.workspace'))).toBeVisible()
}

export async function openSample(page: Page, id: 'cpg' | 'electronics' | 'control' | 'eia-fuels') {
  await page.goto(`/app?sample=${id}`)
  await expect(page.locator('.workspace')).toBeVisible()
}

/** Drops a file on the start page and waits for the mapping step or an error. */
export async function chooseFiles(page: Page, ...files: ReturnType<typeof csvFile>[]) {
  await page.locator('input[type=file]').setInputFiles(files)
}

export async function importCsv(page: Page, ...files: ReturnType<typeof csvFile>[]) {
  await openApp(page)
  await chooseFiles(page, ...files)
  await expect(page.getByRole('heading', { name: 'Check the column mapping' })).toBeVisible()
}

export async function runCheck(page: Page) {
  await page.getByRole('button', { name: 'Run the trust check' }).click()
  await expect(page.locator('.workspace')).toBeVisible()
}

export const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name })
export async function openTab(page: Page, name: string | RegExp) {
  await tab(page, name).click()
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true')
}

/** The number shown in the import summary under a label such as "rows read". */
export const stat = (page: Page, label: string): Locator => page.locator('.import-stats > div').filter({ hasText: label }).locator('b')

/** The split table as {child: [before, after, change, shareBefore, shareAfter, points]}. */
export async function splitTable(page: Page): Promise<Record<string, string[]>> {
  const rows = await page.locator('table.data').filter({ has: page.locator('caption', { hasText: 'Exact quantities behind the flow' }) }).locator('tbody tr').allInnerTexts()
  return Object.fromEntries(rows.map((r) => { const [child, ...rest] = r.split('\t'); return [child, rest.map((c) => c.trim())] }))
}

export async function download(page: Page, button: string | RegExp): Promise<{ name: string; text: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()])
  const path = await d.path()
  return { name: d.suggestedFilename(), text: readFileSync(path, 'utf8') }
}

/** Minimal CSV reader for the app's own exports (quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false } else cell += c }
    else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}
