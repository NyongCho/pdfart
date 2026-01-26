import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // pdfjs-dist가 Vite의 사전 번들링 과정에서 꼬이지 않도록 설정
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext', // 최신 브라우저 문법 지원
  },
})