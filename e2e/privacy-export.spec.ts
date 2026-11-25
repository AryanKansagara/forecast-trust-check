import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { csvFile, download, expect, importCsv, openApp, openSample, parseCsv, runCheck, test } from './helpers.ts'
import { longCsv, statedFor } from './fixtures.ts'

test.describe('exports', () => {
  test('findings and items exports download and match what is on screen', async ({ page }) => {
    await openSample(page, 'cpg')
    const shown = await page.locator('.rank-row').count()
    const findings = await download(page, 'Findings CSV')
    expect(findings.name).toBe('forecast-findings.csv')
    const f = parseCsv(findings.text)
    expect(f[0]).toEqual(['rank', 'severity', 'type', 'finding', 'item_or_node', 'path', 'units', 'impact_score', 'noise_test', 'periods_affected', 'snapshots_hit', 'reason', 'also_flagged'])
    const data = f.slice(1).filter((r) => r.length > 1)
    expect(data).toHaveLength(shown)
    expect(data[0].slice(0, 5)).toEqual(['1', 'high', 'disaggregation', 'Share jump, flat parent', 'BEV-LEMON-330'])
    expect(Number(data[0][6])).toBeCloseTo(73426, -1)
    expect(data.map((r) => r[0])).toEqual(data.map((_, i) => String(i + 1)))

    const items = await download(page, 'Items CSV')
    expect(items.name).toBe('forecast-items.csv')
    const i = parseCsv(items.text)
    expect(i[0].slice(0, 5)).toEqual(['item', 'path', 'horizon_volume', 'nervousness', 'band'])
    expect(i.slice(1).filter((r) => r.length > 1)).toHaveLength(22)
    expect(i.slice(1).some((r) => r[0] === 'BEV-LEMON-330' && r[1] === 'Beverages / North America')).toBe(true)
  })

  test('exports of an upload carry the hand-worked quantities and defuse spreadsheet formulas', async ({ page }) => {
    const text = longCsv({ stated: statedFor() }).replaceAll('V2', '=HYPERLINK("http://example.invalid")')
    await importCsv(page, csvFile('stated.csv', text))
    await runCheck(page)
    const items = parseCsv((await download(page, 'Items CSV')).text)
    const col = Object.fromEntries(items[0].map((h, n) => [h, n]))
    const byItem = Object.fromEntries(items.slice(1).filter((r) => r.length > 1).map((r) => [r[col.item], r]))
    expect(byItem.V1[col.horizon_volume]).toBe('423')
    expect(byItem.V1[col.path]).toBe('Valves')
    // A leading = would run as a formula in Excel, so the export prefixes an apostrophe.
    const formula = Object.keys(byItem).find((k) => k.includes('HYPERLINK'))!
    expect(formula.startsWith("'=")).toBe(true)
    expect(byItem[formula][col.horizon_volume]).toBe('597')
    const findings = parseCsv((await download(page, 'Findings CSV')).text)
    expect(findings.slice(1).every((r) => r.every((c) => !/^[=+@]/.test(c)))).toBe(true)
  })

  test('the problem rows download is a CSV of the rejected rows', async ({ page }) => {
    await importCsv(page, csvFile('bad.csv', longCsv().replace(',100\n', ',lots\n')))
    await runCheck(page)
    await page.getByRole('tab', { name: /Import report/ }).click()
    const { name, text } = await download(page, 'Download problem rows')
    expect(name).toBe('rejected-rows.csv')
    expect(parseCsv(text)[1].slice(0, 3)).toEqual(['bad.csv', '2', 'Quantity is not a number'])
  })

  test('the review pack is built from the same findings and the print button calls print', async ({ page }) => {
    await openSample(page, 'cpg')
    await page.evaluate(() => { (window as unknown as { __printed: number }).__printed = 0; window.print = () => { (window as unknown as { __printed: number }).__printed++ } })
    await page.getByRole('button', { name: 'Print review pack' }).click()
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1)
    await expect(page.locator('.print-pack')).toBeHidden()
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('.print-pack')).toBeVisible()
    await expect(page.locator('.screen-only')).toBeHidden()
    await expect(page.locator('.print-pack h1')).toHaveText('Forecast trust review')
    await expect(page.locator('.print-pack')).toContainText('BEV-LEMON-330')
  })
})

test.describe('nothing leaves the page', () => {
  test('the built page carries a CSP that forbids connections and form posts', async ({ page }) => {
    await openApp(page)
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("default-src 'none'")
  })

  test('the browser itself refuses outbound requests, so a real listener on another port hears nothing', async ({ page, guard }) => {
    guard.ignoreConsole.push(/Content Security Policy|Refused to connect|violates/i)
    const hits: string[] = []
    const listener = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.setHeader('access-control-allow-origin', '*'); res.end('ok') })
    listener.on('upgrade', (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy() })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    try {
      const target = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
      await openApp(page)
      const result = await page.evaluate(async (url) => {
        const violations: string[] = []
        document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective))
        const outcomes: Record<string, string> = {}
        outcomes.fetch = await fetch(`${url}/fetch`, { method: 'POST', body: 'x' }).then(() => 'sent', () => 'refused')
        outcomes.xhr = await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', `${url}/xhr`); x.onerror = () => res('refused'); x.onload = () => res('sent'); x.send() })
        outcomes.socket = await new Promise((res) => { const w = new WebSocket(`${url.replace('http', 'ws')}/ws`); w.onerror = () => res('refused'); w.onopen = () => res('sent') })
        navigator.sendBeacon(`${url}/beacon`, 'x')
        new Image().src = `${url}/pixel.png`
        await new Promise((r) => setTimeout(r, 500))
        return { outcomes, violations }
      }, target)
      expect(result.outcomes).toEqual({ fetch: 'refused', xhr: 'refused', socket: 'refused' })
      expect(result.violations.length).toBeGreaterThanOrEqual(3)
      expect(hits).toEqual([])
      expect(guard.external).toEqual([])
    } finally { listener.close() }
  })

  test('a full session of imports, views and exports makes no request to another origin', async ({ page, guard }) => {
    await openSample(page, 'cpg')
    for (const t of [/Hierarchy/, /Split audit/, /Items/, /Accuracy/, /Import report/, /Waterfall/]) await page.getByRole('tab', { name: t }).click()
    await download(page, 'Findings CSV')
    await page.getByRole('button', { name: 'Change data' }).click()
    await page.locator('input[type=file]').setInputFiles(csvFile('long.csv', longCsv()))
    await runCheck(page)
    await page.getByRole('button', { name: 'Copy settings link' }).click()
    await page.goto('/docs')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // Every request the page made, including fonts and scripts, came from its own origin.
    expect(guard.external).toEqual([])
  })
})
