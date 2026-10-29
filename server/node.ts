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

/**
 * 解析请求路径到磁盘文件：命中实际文件优先；无扩展名的前端路由路径回退 /index.html。
 * getMeta 与 getContents 共用同一判定，避免两者对 fallback 的理解不一致。
 */
async function resolveAsset(id: string): Promise<{ path: string; size: number; mtime: Date } | null> {
  const direct = join(distDir, normalize(id))
  const directStat = await stat(direct).catch(() => null)
  if (directStat?.isFile()) return { path: direct, size: directStat.size, mtime: directStat.mtime }
  if (id.includes('.')) return null
  const indexPath = join(distDir, 'index.html')
  const indexStat = await stat(indexPath).catch(() => null)
  if (!indexStat?.isFile()) return null
  return { path: indexPath, size: indexStat.size, mtime: indexStat.mtime }
}

// 静态资源：自写 node:fs 后端的 serveStatic，挂在 catch-all 路由（rou3 最低优先级，API 路由先匹配），
// SPA fallback 到 /index.html。不能用 app.use('/**') 中间件——全局中间件先于路由执行会拦截 API。
app.all('/**', (event) =>
  serveStatic(event, {
    indexNames: ['/index.html'],
    fallthrough: false,
    getMeta: async (id) => {
      const asset = await resolveAsset(id)
      return asset ? { size: asset.size, mtime: asset.mtime } : undefined
    },
    getContents: async (id) => {
      const asset = await resolveAsset(id)
      return asset ? readFile(asset.path).catch(() => null) : null
    },
  }),
)

serve(app, { port })
console.log(`lite-ai-gateway listening on http://localhost:${port}`)
