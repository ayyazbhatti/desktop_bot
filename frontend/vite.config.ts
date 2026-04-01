import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.API_PORT || env.VITE_API_PORT || '3001'
  const panelKey = (env.PANEL_API_KEY || env.VITE_PANEL_API_KEY || '').trim()
  const proxyHeaders = panelKey ? { 'X-Panel-Api-Key': panelKey } : undefined
  const proxyOpts = {
    target: `http://localhost:${apiPort}`,
    changeOrigin: true,
    ...(proxyHeaders ? { headers: proxyHeaders } : {}),
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': proxyOpts,
        '/ws': { ...proxyOpts, ws: true },
      },
    },
  }
})
