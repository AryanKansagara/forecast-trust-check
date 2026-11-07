import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Only in the built site: the browser itself refuses any outbound request, so "your data stays here" is enforced, not promised.
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'"

export default defineConfig({
  plugins: [react(), {
    name: 'lockdown-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  }],
})
