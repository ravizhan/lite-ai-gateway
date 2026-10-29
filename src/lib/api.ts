/** 轻量 fetch 封装：自动带 Bearer、同源 baseURL、401 清 token 跳登录、错误 toast */
import { useAuthStore } from '../stores/auth'

/** 接口请求失败；调用方统一按 Error.message 展示 */
class ApiError extends Error {}

export async function api<T = unknown>(path: string, options: {
  method?: string
  body?: unknown
  query?: Record<string, string | number | undefined | null>
} = {}): Promise<T> {
  const auth = useAuthStore()
  const url = new URL(path, window.location.origin)
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const headers: Record<string, string> = {}
  if (auth.token) headers.authorization = `Bearer ${auth.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (res.status === 401) {
    auth.logout()
    // 避免在登录页重复跳转
    if (window.location.pathname !== '/login') window.location.href = '/login'
    throw new ApiError('unauthorized')
  }
  const text = await res.text()
  let data: unknown
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  if (!res.ok) {
    const msg = (data as { error?: { message?: string }; message?: string })?.error?.message
      ?? (data as { message?: string })?.message
      ?? `HTTP ${res.status}`
    throw new ApiError(msg)
  }
  return data as T
}
