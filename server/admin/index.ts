import type { H3 } from 'h3'
import { registerInfo } from './info.ts'
import { registerKeys } from './keys.ts'
import { registerLogs } from './logs.ts'
import { registerMcp } from './mcp.ts'
import { registerModels } from './models.ts'
import { registerPrices } from './prices.ts'
import { registerProviders } from './providers.ts'
import { registerRoutes } from './routes.ts'
import { registerStats } from './stats.ts'
import { registerSettings } from './settings.ts'

/** 注册全部 /api/admin/** 管理路由（app.ts 调用；认证在各 handler 内 requireAdmin） */
export function registerAdmin(app: H3): void {
  registerProviders(app)
  registerModels(app)
  registerPrices(app)
  registerRoutes(app)
  registerKeys(app)
  registerLogs(app)
  registerStats(app)
  registerInfo(app)
  registerMcp(app)
  registerSettings(app)
}
