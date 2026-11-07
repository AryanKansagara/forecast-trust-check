import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/lato/300.css'
import '@fontsource/lato/400.css'
import '@fontsource/lato/700.css'
import '@fontsource/lato/900.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import Landing from './Landing.tsx'
import { usePath } from './ui.tsx'

const Tool = lazy(() => import('./Tool.tsx'))

function App() {
  const path = usePath()
  if (path === '/app' || path.startsWith('/app/')) return <Suspense fallback={<div className="loading" role="status">Opening the workspace…</div>}><Tool /></Suspense>
  return <Landing />
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
