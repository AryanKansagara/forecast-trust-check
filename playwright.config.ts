import { defineConfig, devices } from '@playwright/test'

// The suite runs against the production build served by `vite preview`, because only the built page carries the
// Content Security Policy. Run `npm run build` first. E2E_PORT picks the port, E2E_DIST an alternative build folder.
const port = Number(process.env.E2E_PORT ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`E2E_PORT must be a port number, got "${process.env.E2E_PORT}"`)
const outDir = process.env.E2E_DIST ? ` --outDir "${process.env.E2E_DIST}"` : ''

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort${outDir}`,
    url: `http://127.0.0.1:${port}/`,
    // Never silently test whatever else happens to be listening on the port.
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
