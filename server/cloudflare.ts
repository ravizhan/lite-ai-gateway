import { serve } from 'h3/cloudflare'
import { createApp } from './app.ts'

// Workers 入口：h3/cloudflare 的 serve 返回 srvx cloudflare handler（含 fetch(request, env, ctx) 形态）。
// D1/ASSETS/ADMIN_TOKEN 经 event.runtime.cloudflare.env 访问（类型见 worker-configuration.d.ts 全局声明）。
const app = await createApp('workers')

export default serve(app)
