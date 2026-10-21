import type { H3Event } from 'h3'
import type { Db } from './types.ts'
import { createD1Db } from './d1.ts'

// Node 端进程级单例；Workers 端会话按请求创建。
let nodeDb: Db | null = null

// H3 middleware/handler 共享同一个 event；按 event 缓存，避免跨请求复用会话
// 或引入 bookmark 传递协议。
const d1DbByRequest = new WeakMap<H3Event, Db>()

/** 由 server/node.ts 启动时注入 Node 端 db（node:sqlite 不进入 Workers bundle） */
export function setNodeDb(db: Db): void {
  nodeDb = db
}

/** 运行时差异唯一点：Workers 用 D1，Node 用注入的 node:sqlite */
export function getDb(event?: H3Event): Db {
  const cf = event?.runtime?.cloudflare
  if (cf && event) {
    const cached = d1DbByRequest.get(event)
    if (cached) return cached

    const binding = cf.env.DB as D1Database
    // API key 中间件是受保护请求的首个数据库查询。首查锚定 primary，保证
    // key 撤销新鲜度及跨请求写后读；后续查询复用此 session 的顺序一致 bookmark。
    const db = createD1Db(binding, binding.withSession('first-primary'))
    d1DbByRequest.set(event, db)
    return db
  }
  if (!nodeDb) throw new Error('Node db not initialized — call setNodeDb() first')
  return nodeDb
}
