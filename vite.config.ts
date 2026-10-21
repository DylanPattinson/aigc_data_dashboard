import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 本地开发与本地预览配置。
 * 不设置 `base`，使用 Vite 默认的 '/'：开发服务器与 `npm run preview` 均以根路径提供服务，
 * 本项目为单页应用、无前端路由，不存在刷新 404 问题。
 * 数据文件通过 `import.meta.env.BASE_URL` 拼接后 fetch，本地开发与预览均可正常加载。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
  },
});
