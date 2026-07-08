import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // Lets renderer code import shared modules as `src/common/...` (matches
        // tsconfig paths). Needed once we import runtime values, not just types.
        src: resolve('src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
