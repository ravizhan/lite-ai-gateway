import { onBeforeUnmount, onMounted, ref } from 'vue'

const SERIES_COLOR_VARS = [
  { light: '--color-blue-600', dark: '--color-blue-400' },
  { light: '--color-emerald-600', dark: '--color-emerald-400' },
  { light: '--color-amber-600', dark: '--color-amber-400' },
  { light: '--color-rose-600', dark: '--color-rose-400' },
  { light: '--color-cyan-600', dark: '--color-cyan-400' },
  { light: '--color-violet-600', dark: '--color-violet-400' },
  { light: '--color-orange-600', dark: '--color-orange-400' },
  { light: '--color-teal-600', dark: '--color-teal-400' },
  { light: '--color-fuchsia-600', dark: '--color-fuchsia-400' },
  { light: '--color-lime-600', dark: '--color-lime-400' },
]

const COLOR_VARIABLES = [
  '--ui-text-highlighted', '--ui-text', '--ui-text-dimmed', '--ui-text-muted',
  '--ui-border-muted', '--ui-border', '--ui-bg-elevated', '--ui-bg', '--ui-primary',
  ...SERIES_COLOR_VARS.flatMap((colors) => [colors.light, colors.dark]),
]

let colorContext: CanvasRenderingContext2D | null = null

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseCssColor(value: string): Rgba | null {
  if (!colorContext) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    colorContext = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!colorContext) return null
  colorContext.clearRect(0, 0, 1, 1)
  colorContext.fillStyle = value
  colorContext.fillRect(0, 0, 1, 1)
  const pixel = colorContext.getImageData(0, 0, 1, 1).data
  return {
    r: pixel[0]!,
    g: pixel[1]!,
    b: pixel[2]!,
    a: Math.round((pixel[3]! / 255) * 1000) / 1000,
  }
}

function readCssColors(): Record<string, string> {
  const values: Record<string, string> = {}
  const styles = getComputedStyle(document.documentElement)
  for (const name of COLOR_VARIABLES) values[name] = styles.getPropertyValue(name).trim()
  return values
}

function readCssColor(values: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = values[name]
    if (value) {
      const parsed = parseCssColor(value)
      if (parsed) return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${parsed.a})`
    }
  }
  return ''
}

interface ChartTheme {
  palette: string[]
  text: string
  textDimmed: string
  border: string
  surface: string
}

export function readChartTheme(): ChartTheme {
  const values = readCssColors()
  const dark = document.documentElement.classList.contains('dark')
  const text = readCssColor(values, '--ui-text-highlighted', '--ui-text')
  const textDimmed = readCssColor(values, '--ui-text-dimmed', '--ui-text-muted') || text
  const border = readCssColor(values, '--ui-border-muted', '--ui-border') || textDimmed
  const surface = readCssColor(values, '--ui-bg-elevated', '--ui-bg') || border
  const fallback = readCssColor(values, '--ui-primary') || textDimmed
  const palette = SERIES_COLOR_VARS.map((colors) => {
    return readCssColor(values, dark ? colors.dark : colors.light) || fallback
  })

  return { palette, text, textDimmed, border, surface }
}

/** 将颜色调整为给定透明度；颜色无效时原样返回 */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseCssColor(color)
  if (!parsed) return color
  const a = Math.round(parsed.a * alpha * 1000) / 1000
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${a})`
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** 转义 echarts tooltip 里的 HTML 文本 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!)
}

/** 图表主题版本：根节点 light/dark class 变化时自增，供 option computed 依赖重建 */
export function useChartTheme() {
  const themeVersion = ref(0)
  let observer: MutationObserver | null = null

  onMounted(() => {
    observer = new MutationObserver(() => {
      themeVersion.value += 1
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return { themeVersion }
}
