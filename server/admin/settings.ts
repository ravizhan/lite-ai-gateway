import type { H3 } from 'h3'
import { HTTPError, readBody } from 'h3'
import { requireAdmin } from '../auth.ts'
import { getDb } from '../db/index.ts'
import {
  gatewaySettingsSchema,
  loadGatewaySettings,
  saveGatewaySettings,
} from '../settings.ts'
import type { GatewaySettings } from '../../shared/api.ts'

/** Register the complete gateway settings read/write API. */
export function registerSettings(app: H3): void {
  app.get('/api/admin/settings', async (event) => {
    requireAdmin(event)
    try {
      return await loadGatewaySettings(getDb(event))
    } catch {
      throw new HTTPError({ status: 500, message: 'failed to read settings' })
    }
  })

  app.put('/api/admin/settings', async (event) => {
    requireAdmin(event)
    const parsed = gatewaySettingsSchema.safeParse(await readBody(event))
    if (!parsed.success) {
      throw new HTTPError({ status: 400, message: 'invalid body', data: parsed.error.issues })
    }
    try {
      return await saveGatewaySettings(getDb(event), parsed.data as GatewaySettings)
    } catch {
      throw new HTTPError({ status: 500, message: 'failed to save settings' })
    }
  })
}
