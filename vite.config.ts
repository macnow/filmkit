import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  server: {
    port: 5174,
  },
  build: {
    target: 'esnext',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
