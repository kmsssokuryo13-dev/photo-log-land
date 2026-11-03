import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/photo-log-land/',
  plugins: [react(), tailwindcss()],
  // onnxruntime-web は WASM を同梱して使うため事前バンドルしない
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
