import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    vue(),
    ui({
      colorMode: true,
      autoImport: { imports: ['vue', 'vue-router', 'pinia'], dts: 'src/auto-imports.d.ts' },
      components: { dts: 'src/components.d.ts' },
      // 显式打包运行时字符串中的图标；源码扫描无法可靠识别表格列、菜单等动态配置。
      icon: {
        clientBundle: {
          scan: true,
          icons: [
            'lucide:activity', 'lucide:blocks', 'lucide:box', 'lucide:check', 'lucide:chevron-down',
            'lucide:chevron-right', 'lucide:cloud', 'lucide:coins', 'lucide:copy', 'lucide:cpu',
            'lucide:database', 'lucide:database-zap', 'lucide:dollar-sign', 'lucide:eye', 'lucide:folder-open',
            'lucide:gauge', 'lucide:grip-vertical', 'lucide:hash', 'lucide:key-round', 'lucide:layout-dashboard',
            'lucide:list-tree', 'lucide:log-out', 'lucide:menu', 'lucide:message-square-text', 'lucide:move',
            'lucide:package-open', 'lucide:pencil', 'lucide:plug-zap', 'lucide:plus', 'lucide:radar',
            'lucide:refresh-cw', 'lucide:rotate-ccw', 'lucide:route', 'lucide:scroll-text', 'lucide:search',
            'lucide:settings', 'lucide:timer', 'lucide:trash-2', 'lucide:triangle-alert', 'lucide:waypoints',
            'lucide:wrench', 'lucide:zap',
            // UColorModeSelect 通过 appConfig.ui.icons 动态引用，扫描无法识别
            'lucide:monitor', 'lucide:moon', 'lucide:sun',
          ],
        },
      },
    }),
  ],
  server: {
    proxy: {
      '/v1': 'http://localhost:8788',
      '/api': 'http://localhost:8788',
      // '/mcp' 是 MCP 协议端点；浏览器对其的文档导航（Accept: text/html）交回 SPA，
      // 其余 MCP 协议请求照旧代理到后端。前端管理路由在 /mcps 前缀下，不经此代理。
      '/mcp': {
        target: 'http://localhost:8788',
        bypass(req) {
          if (req.method === 'GET' && req.headers.accept?.includes('text/html')) return '/index.html'
        },
      },
      '/sse': 'http://localhost:8788',
      '/messages': 'http://localhost:8788',
    },
  },
  build: {
    outDir: 'dist',
  },
})
