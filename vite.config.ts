import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 利用者の PC の http://localhost:5178/ で動かす（SURVIA・ランチャーと同じ固定の場所。別の port には逃げない）。
// base は相対にして、GitHub Pages（/photo-log-land/）でもそのまま動くようにする。
export default defineConfig({
  base: './',
  server: { host: 'localhost', port: 5178, strictPort: true },
  preview: { host: 'localhost', port: 5178, strictPort: true },
  plugins: [react(), tailwindcss()],
  // onnxruntime-web は WASM を同梱して使うため事前バンドルしない
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
