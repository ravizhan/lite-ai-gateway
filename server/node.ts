import { readFile, stat } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import { serveStatic } from 'h3'
import { serve } from 'h3/node'
import { createApp } from './app.ts'
import { setNodeDb } from './db/index.ts'
import { createNodeDb } from './db/node.ts'
import { ensureSchema } from './db/bootstrap.ts'
import { installNodeMcpBindings } from './mcp/bindings-node.ts'

// 加载 .env（Node 20.6+；文件不存在则忽略）
try {
  process.loadEnvFile()
} catch {
  // .env 可选
}

// Executable archives keep dist/ beside the binary; source and JS bundles use ../dist/.
const distDir = join(dirname(fileURLToPath(import.meta.url)), isSea() ? 'dist' : '../dist')
const dbPath = process.env.DATABASE_PATH ?? './data/gateway.db'
const port = Number(process.env.PORT ?? 8788)

// Node 端注入 node:sqlite 并建表（仅空库；非空库跳过正常启动）
const db = createNodeDb(dbPath)
setNodeDb(db)
if (await ensureSchema(db)) {
  console.log(`[db] initialized schema in ${dbPath}`)
}

// Node 端注入 MCP 传输层（stdio/SSE 上游 + Node SSE 端点），必须在 createApp 前完成：
// registerMcp 在 createApp 内同步调用 getNodeMcpBindings()。
installNodeMcpBindings()

const app = await createApp('node')

// 静态资源：自写 node:fs 后端的 serveStatic，挂在 catch-all 路由（rou3 最低优先级，API 路由先匹配），
// SPA fallback 到 /index.html。不能用 app.use('/**') 中间件——全局中间件先于路由执行会拦截 API。
app.all('/**', (event) =>
  serveStatic(event, {
    indexNames: ['/index.html'],
    fallthrough: false,
    getMeta: async (id) => {
      const s = await stat(join(distDir, normalize(id))).catch(() => null)
      if (s?.isFile()) return { size: s.size, mtime: s.mtime }
      // SPA fallback：无扩展名的前端路由路径按 /index.html 提供 meta
      if (!id.includes('.')) {
        const idx = await stat(join(distDir, 'index.html')).catch(() => null)
        if (idx?.isFile()) return { size: idx.size, mtime: idx.mtime }
      }
      return undefined
    },
    getContents: async (id) => {
      // SPA fallback：非文件路径回退 /index.html
      const file = await readFile(join(distDir, normalize(id))).catch(() => null)
      if (file) return file
      return readFile(join(distDir, 'index.html')).catch(() => null)
    },
  }),
)

serve(app, { port })
console.log(`lite-ai-gateway listening on http://localhost:${port}`)
