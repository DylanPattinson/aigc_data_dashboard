import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 本地开发 + GitHub Pages 双场景配置。
 *
 * - 本地 `npm run dev` / `npm run preview` / `npm run build`：默认 `base = '/'`，根路径提供。
 * - GitHub Pages 部署：在环境变量 `GITHUB_PAGES=true` 时 `base` 切换到 `/<repo>/`，
 *   项目仓库路径 `/aigc_data_dashboard/` 下也能正常加载主资源与 `public/data/*.json`。
 *
 * 路由说明：本项目用普通锚点跳转（#sec-eval / #sec-supply …），不依赖前端路由，
 * 因此 GH Pages 不需要 404 fallback 也能在不同路径下刷新同一 index.html。
 */
const isGhPages = process.env.GITHUB_PAGES === 'true';

export default defineConfig({
  plugins: [react()],
  base: isGhPages ? '/aigc_data_dashboard/' : '/',
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
