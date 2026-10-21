/**
 * 时间展示统一入口。后端时间串有两种形态，都表示 UTC：
 * - SQLite `datetime('now')` 列：`YYYY-MM-DD HH:MM:SS`（无时区标记）
 * - 统计分桶：ISO-8601 `YYYY-MM-DDTHH:MM:00Z`（自带 Z）
 * 展示前统一按 UTC 解析再转浏览器本地时区；非法输入原样返回，避免表格/图表出现 NaN 或 Invalid Date。
 */
export type LocalTsStyle =
  | 'datetime' // YYYY-MM-DD HH:MM:SS
  | 'datetime-short' // MM-DD HH:MM:SS
  | 'date' // YYYY-MM-DD
  | 'month-day' // MM-DD
  | 'hour-minute' // HH:MM

/** UTC 时间串 → Date：缺时区标记时补 `Z`，避免 `Date.parse` 把无标记串当本地时间 */
export function parseUtcTs(ts: string): Date | null {
  const iso = ts.replace(' ', 'T')
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)
  const date = new Date(hasOffset ? iso : `${iso}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatLocalTs(ts: string, style: LocalTsStyle = 'datetime'): string {
  const date = parseUtcTs(ts)
  if (!date) return ts
  const [y, mo, d, h, mi, s] = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((n) => String(n).padStart(2, '0'))
  switch (style) {
    case 'datetime-short':
      return `${mo}-${d} ${h}:${mi}:${s}`
    case 'date':
      return `${y}-${mo}-${d}`
    case 'month-day':
      return `${mo}-${d}`
    case 'hour-minute':
      return `${h}:${mi}`
    default:
      return `${y}-${mo}-${d} ${h}:${mi}:${s}`
  }
}
