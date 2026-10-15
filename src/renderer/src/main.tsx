import '@fontsource-variable/schibsted-grotesk'
import './assets/base.css'
import './assets/tailwind.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startFocusLog } from './lib/focusLog'

startFocusLog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
