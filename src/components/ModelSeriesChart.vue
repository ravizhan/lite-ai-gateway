<script setup lang="ts">
import { AxisPointerComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { connect, graphic, use } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'
import { escapeHtml, readChartTheme, useChartTheme, withAlpha } from '@/lib/chartTheme'
import { formatLocalTs, parseUtcTs, type LocalTsStyle } from '@/lib/time'

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, AxisPointerComponent, LegendComponent])

const props = defineProps<{
  /** x 轴时间戳（与 values 行对齐） */
  labels: string[]
  /** 每模型一层堆叠面积；values 与 labels 对齐 */
  series: { name: string; color: string; values: number[] }[]
  /** 固定 group 名时多实例联动（同一时间戳的轴指针/提示框同步） */
  group?: string
  /** y 轴与提示框数值格式化 */
  format?: (value: number) => string
  height?: number
}>()

const { themeVersion } = useChartTheme()

const hasData = computed(() => props.labels.length > 0 && props.series.length > 0)

const formatValue = (value: number) => (props.format ?? ((v: number) => v.toLocaleString('en-US')))(value)

function spanSeconds(): number {
  if (props.labels.length < 2) return 0
  const first = parseUtcTs(props.labels[0] ?? '')
  const last = parseUtcTs(props.labels[props.labels.length - 1] ?? '')
  return first && last ? (last.getTime() - first.getTime()) / 1000 : 0
}

/** 跨天只显示日期，单日内只显示时刻（均为浏览器本地时区） */
const labelStyle = computed<LocalTsStyle>(() => (spanSeconds() > 24 * 60 * 60 ? 'month-day' : 'hour-minute'))

function tooltipFormatter(params: unknown, fallbackColor: string): string {
  const items = (Array.isArray(params) ? params : [params]).filter((item): item is Record<string, unknown> => {
    return Boolean(item && typeof item === 'object')
  })
  if (!items.length) return ''

  const first = items[0]!
  const rawAxisValue = first.axisValueLabel ?? first.axisValue
  const axisValue = rawAxisValue == null ? '' : String(rawAxisValue)
  const title = escapeHtml(formatLocalTs(axisValue, labelStyle.value))
  // 只列该时间桶有数据的模型，按数值降序；顶部给出合计
  const entries = items
    .map((item) => ({
      name: String(item.seriesName ?? ''),
      value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : 0,
      color: lineColors.value.get(String(item.seriesName ?? '')) ?? fallbackColor,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
  const total = entries.reduce((sum, entry) => sum + entry.value, 0)
  const rows = entries.map((entry) => (
    `<div style="display:flex;align-items:center;gap:8px;justify-content:space-between">`
    + `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${escapeHtml(entry.color)}"></span>${escapeHtml(entry.name)}</span>`
    + `<b style="font-variant-numeric:tabular-nums">${escapeHtml(formatValue(entry.value))}</b></div>`
  ))
  return `<div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:4px">`
    + `<span style="opacity:.7">${title}</span><b style="font-variant-numeric:tabular-nums">${escapeHtml(formatValue(total))}</b></div>`
    + rows.join('')
}

/** 序列名 → 线色（tooltip 里 item.color 是渐变对象，不能直接当 CSS 色用） */
const lineColors = computed(() => new Map(props.series.map((series) => [series.name, series.color])))

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
    grid: { left: 4, right: 12, top: 36, bottom: 4 },
    tooltip: {
      trigger: 'axis' as const,
      confine: true,
      backgroundColor: surfaceColor,
      borderColor,
      borderWidth: 1,
      padding: [8, 12],
      extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);min-width:180px',
      textStyle: { color: highlightedColor, fontSize: 12 },
      axisPointer: { type: 'line' as const, lineStyle: { color: textColor, width: 1, type: 'dashed' as const } },
      formatter: (params: unknown) => tooltipFormatter(params, textColor),
    },
    legend: {
      show: true,
      type: 'scroll' as const,
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: textColor, fontSize: 12 },
      pageIconColor: highlightedColor,
      pageIconInactiveColor: borderColor,
      pageTextStyle: { color: textColor },
    },
    xAxis: {
      type: 'category' as const,
      data: props.labels,
      boundaryGap: false,
      axisLine: { show: true, lineStyle: { color: borderColor } },
      axisTick: { show: false },
      axisLabel: {
        color: textColor,
        margin: 10,
        hideOverlap: true,
        formatter: (value: string | number) => formatLocalTs(String(value), labelStyle.value),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: textColor, margin: 10, formatter: (value: number) => formatValue(value) },
      splitLine: { show: true, lineStyle: { color: withAlpha(borderColor, 0.6), width: 1 } },
      splitNumber: 4,
    },
    series: props.series.map((series) => ({
      name: series.name,
      type: 'line' as const,
      stack: 'total',
      data: series.values,
      smooth: 0.35,
      smoothMonotone: 'x' as const,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color: series.color, width: 1.5 },
      itemStyle: { color: series.color, borderColor: surfaceColor, borderWidth: 1.5 },
      areaStyle: {
        color: new graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: withAlpha(series.color, 0.45) },
          { offset: 1, color: withAlpha(series.color, 0.08) },
        ]),
      },
      emphasis: { focus: 'series' as const },
      animation: false,
    })),
  }
})

watch(hasData, (value) => {
  const group = props.group
  if (!value || !group) return
  nextTick(() => connect(group))
}, { immediate: true })
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
