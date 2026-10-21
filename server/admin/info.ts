import type { H3 } from 'h3'
import { requireAdmin } from '../auth.ts'
import { VERSION } from '../lib/version.ts'
import type { AdminInfo } from '../../shared/api.ts'

export function registerInfo(app: H3): void {
  // 运行时信息：Header 徽标与设置页用
  app.get('/api/admin/info', (event) => {
    requireAdmin(event)
    const cf = event.runtime?.cloudflare
    const info: AdminInfo = {
      runtime: cf ? 'cloudflare' : 'node',
      version: VERSION,
      db: cf ? 'd1' : 'sqlite',
    }
    return info
  })
}
