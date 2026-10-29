import type { H3 } from 'h3'
import { readBody } from 'h3'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import { gatewaySettingsSchema, loadGatewaySettings, saveGatewaySettings } from '../settings.ts'
import { parseBody } from './common.ts'

/** Register the complete gateway settings read/write API. */
export function registerSettings(app: H3): void {
  app.get('/api/admin/settings', async (event) => {
    requireAdmin(event)
    return loadGatewaySettings(getDb(event))
  })

  app.put('/api/admin/settings', async (event) => {
    requireAdmin(event)
    const settings = parseBody(gatewaySettingsSchema, await readBody(event))
    return saveGatewaySettings(getDb(event), settings)
  })
}
