<script setup lang="ts">
import { AxisPointerComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { connect, use } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { observeChartTheme, readChartTheme } from '@/lib/chartTheme'
import { formatLocalTs, parseUtcTs, type LocalTsStyle } from '@/lib/time'

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, AxisPointerComponent, LegendComponent])

const props = defineProps<{
  /** x 轴时间戳（与 values 行对齐） */
  labels: string[]
  /** 每模型一条线；values 与 labels 对齐 */
  series: { name: string; color: string; values: (number | null)[] }[]
  /** 固定 group 名时多实例联动（同一时间戳的轴指针/提示框同步） */
  group?: string
  /** y 轴与提示框数值格式化 */
  format?: (value: number) => string
  height?: number
}>()

const themeVersion = ref(0)
let stopThemeObserver: (() => void) | null = null

const hasData = computed(() => props.labels.length > 0 && props.series.length > 0)

const formatValue = (value: number) => (props.format ?? ((v: number) => v.toLocaleString('en-US')))(value)

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!)
}

function spanSeconds(): number {
  if (props.labels.length < 2) return 0
  const first = parseUtcTs(props.labels[0] ?? '')
  const last = parseUtcTs(props.labels[props.labels.length - 1] ?? '')
  return first && last ? (last.getTime() - first.getTime()) / 1000 : 0
}

/** 跨天只显示日期，单日内只显示时刻（均为浏览器本地时区） */
const labelStyle = computed<LocalTsStyle>(() => (spanSeconds() > 24 * 60 * 60 ? 'month-day' : 'hour-minute'))

function tooltipFormatter(params: unknown): string {
  const items = (Array.isArray(params) ? params : [params]).filter((item): item is Record<string, unknown> => {
    return Boolean(item && typeof item === 'object')
  })
  if (!items.length) return ''

  const first = items[0]!
  const rawAxisValue = first.axisValueLabel ?? first.axisValue
  const axisValue = rawAxisValue == null ? '' : String(rawAxisValue)
  const title = escapeHtml(formatLocalTs(axisValue, labelStyle.value))
  const rows = items.map((item) => {
    const name = escapeHtml(String(item.seriesName ?? ''))
    const rawValue = Array.isArray(item.value) ? item.value[item.value.length - 1] : item.value
    const value = typeof rawValue === 'number' && Number.isFinite(rawValue) ? formatValue(rawValue) : '--'
    const color = escapeHtml(String(item.color ?? readChartTheme().textDimmed))
    return `<div><span style="color:${color}">●</span> ${name}: <b>${escapeHtml(value)}</b></div>`
  })
  return `<div>${title}</div>${rows.join('')}`
}

const chartOption = computed(() => {
  // Rebuild options when Nuxt UI switches the root light/dark class.
  void themeVersion.value
  const theme = readChartTheme()
  const textColor = theme.textDimmed
  const highlightedColor = theme.text
  const borderColor = theme.border
  const surfaceColor = theme.surface

  return {
    animation: false,
    backgroundColor: 'transparent',
    color: props.series.map((series) => series.color),
    textStyle: { color: highlightedColor, fontFamily: 'inherit' },
    grid: { left: 8, right: 8, top: 12, bottom: 34, containLabel: true },
    tooltip: {
      trigger: 'axis' as const,
      confine: true,
      backgroundColor: surfaceColor,
      borderColor,
      borderWidth: 1,
      textStyle: { color: highlightedColor, fontSize: 12 },
      axisPointer: { type: 'line' as const, lineStyle: { color: textColor, width: 1 } },
      formatter: tooltipFormatter,
    },
    legend: {
      show: true,
      type: 'scroll' as const,
      bottom: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { color: textColor, fontSize: 12 },
      pageIconColor: highlightedColor,
      pageIconInactiveColor: borderColor,
      pageTextStyle: { color: textColor },
    },
    xAxis: {
      type: 'category' as const,
      data: props.labels,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: textColor,
        margin: 12,
        formatter: (value: string | number) => formatLocalTs(String(value), labelStyle.value),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: textColor, margin: 12, formatter: (value: number) => formatValue(value) },
      splitLine: { show: true, lineStyle: { color: borderColor, type: 'dashed' as const, width: 1 } },
      splitNumber: 4,
    },
    series: props.series.map((series) => ({
      name: series.name,
      type: 'line' as const,
      data: series.values,
      smooth: 0.25,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: 4,
      showAllSymbol: true,
      connectNulls: false,
      lineStyle: { color: series.color, width: 2.5 },
      itemStyle: { color: series.color },
      emphasis: { focus: 'series' as const },
      animation: false,
    })),
  }
})

onMounted(() => {
  stopThemeObserver = observeChartTheme(() => {
    themeVersion.value += 1
  })
})

watch(hasData, (value) => {
  const group = props.group
  if (!value || !group) return
  nextTick(() => connect(group))
}, { immediate: true })

onBeforeUnmount(() => {
  stopThemeObserver?.()
  stopThemeObserver = null
})
</script>

<template>
  <div class="min-w-0">
    <div
      v-if="!hasData"
      class="flex items-center justify-center text-sm text-(--ui-text-dimmed)"
      :style="{ height: `${height ?? 240}px` }"
    >
      {{ $t('dashboard.noData') }}
    </div>
    <div v-else :style="{ height: `${height ?? 240}px` }">
      <VChart
        class="h-full w-full"
        :option="chartOption"
        :autoresize="{ throttle: 100 }"
        :group="group"
      />
    </div>
  </div>
</template>
