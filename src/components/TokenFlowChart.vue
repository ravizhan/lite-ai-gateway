<script setup lang="ts">
import { SankeyChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useI18n } from 'vue-i18n'
import VChart from 'vue-echarts'
import type { StatsResult } from '../../shared/api'
import { observeChartTheme, readChartTheme, withAlpha } from '@/lib/chartTheme'

use([CanvasRenderer, SankeyChart, TooltipComponent])

type TokenFlow = StatsResult['tokenFlows'][number]

interface FlowAggregate {
  tokens: number
  requests: number
  cost: number
  promptTokens: number
  cachedTokens: number
}

const props = defineProps<{
  flows: TokenFlow[]
  loading?: boolean
  error?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()

const { locale, t } = useI18n()
const themeVersion = ref(0)
let stopThemeObserver: (() => void) | null = null

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!)
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatCost(value: number): string {
  return `$${value > 0 && value < 0.01 ? value.toExponential(1) : value.toFixed(4)}`
}

function providerLabel(flow: TokenFlow): string {
  const name = flow.provider_name.trim()
  return !name || name === 'Unknown' ? t('dashboard.unknownProvider') : name
}

function modelNodeId(model: string): string {
  return `model:${model}`
}

function providerNodeId(flow: TokenFlow): string {
  const name = flow.provider_name.trim() || 'unknown'
  return flow.provider_id == null
    ? `provider:name:${name}`
    : `provider:${flow.provider_id}`
}

function emptyAggregate(): FlowAggregate {
  return { tokens: 0, requests: 0, cost: 0, promptTokens: 0, cachedTokens: 0 }
}

const graph = computed(() => {
  const nodes = new Map<string, { id: string; name: string; index: number }>()
  const links = new Map<string, { source: string; target: string; value: number; metrics: FlowAggregate }>()

  for (const flow of props.flows) {
    if (!flow.model || !Number.isFinite(flow.total_tokens) || flow.total_tokens <= 0) continue
    const source = modelNodeId(flow.model)
    const target = providerNodeId(flow)
    if (!nodes.has(source)) nodes.set(source, { id: source, name: flow.model, index: nodes.size })
    if (!nodes.has(target)) nodes.set(target, { id: target, name: providerLabel(flow), index: nodes.size })
    const key = `${source}\u0000${target}`
    let link = links.get(key)
    if (!link) {
      link = { source, target, value: 0, metrics: emptyAggregate() }
      links.set(key, link)
    }
    link.value += flow.total_tokens
    link.metrics.tokens += flow.total_tokens
    link.metrics.requests += flow.requests
    link.metrics.cost += flow.cost
    link.metrics.promptTokens += flow.prompt_tokens
    link.metrics.cachedTokens += flow.cached_tokens
  }

  // 节点汇总指标 = 所有相连边的合计
  const nodeMetrics = new Map<string, FlowAggregate>()
  for (const link of links.values()) {
    for (const nodeId of [link.source, link.target]) {
      const agg = nodeMetrics.get(nodeId) ?? emptyAggregate()
      agg.tokens += link.metrics.tokens
      agg.requests += link.metrics.requests
      agg.cost += link.metrics.cost
      agg.promptTokens += link.metrics.promptTokens
      agg.cachedTokens += link.metrics.cachedTokens
      nodeMetrics.set(nodeId, agg)
    }
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()],
    nodeMetrics,
  }
})

const hasData = computed(() => graph.value.nodes.length > 0 && graph.value.links.length > 0)

const chartHeight = computed(() => {
  const modelCount = graph.value.nodes.filter((node) => node.id.startsWith('model:')).length
  const providerCount = graph.value.nodes.filter((node) => node.id.startsWith('provider:')).length
  const columnCount = Math.max(modelCount, providerCount, 1)
  // Leave each node a readable slot in addition to ECharts' node gaps.
  return Math.max(288, columnCount * 24 + (columnCount - 1) * 12 + 24)
})

/** 悬浮框共用行：Token / 请求数 / 成本 / 平均缓存命中率 */
function metricRows(metrics: FlowAggregate): string {
  const cacheRate = metrics.promptTokens > 0 ? (metrics.cachedTokens / metrics.promptTokens) * 100 : 0
  const rows: [string, string][] = [
    [t('dashboard.tokens'), formatTokens(metrics.tokens)],
    [t('dashboard.requests'), formatTokens(metrics.requests)],
    [t('dashboard.costUsd'), formatCost(metrics.cost)],
    [t('dashboard.cacheRate'), `${cacheRate.toFixed(1)}%`],
  ]
  return rows
    .map(([label, value]) => `<div>${escapeHtml(label)}: <b>${escapeHtml(value)}</b></div>`)
    .join('')
}

function tooltipFormatter(params: unknown): string {
  const item = (Array.isArray(params) ? params[0] : params) as Record<string, unknown> | undefined
  if (!item) return ''
  const data = item.data && typeof item.data === 'object' ? item.data as Record<string, unknown> : {}
  const sourceId = String(data.source ?? item.source ?? '')
  const targetId = String(data.target ?? item.target ?? '')
  if (sourceId && targetId) {
    const link = graph.value.links.find((l) => l.source === sourceId && l.target === targetId)
    if (!link) return ''
    const source = graph.value.nodes.find((node) => node.id === sourceId)?.name ?? sourceId
    const target = graph.value.nodes.find((node) => node.id === targetId)?.name ?? targetId
    return `<div><b>${escapeHtml(source)} → ${escapeHtml(target)}</b></div>${metricRows(link.metrics)}`
  }
  const nodeId = String(data.id ?? item.id ?? '')
  const name = String(data.name ?? item.name ?? '')
  const metrics = graph.value.nodeMetrics.get(nodeId)
  if (!metrics) return escapeHtml(name)
  return `<div><b>${escapeHtml(name)}</b></div>${metricRows(metrics)}`
}

const chartOption = computed(() => {
  // Rebuild options when Nuxt UI switches the root light/dark class.
  void themeVersion.value
  const theme = readChartTheme()
  const textColor = theme.text
  const dimmedColor = theme.textDimmed
  const borderColor = theme.border
  const surfaceColor = theme.surface
  const nodeData = graph.value.nodes.map((node) => {
    const base = theme.palette[node.index % theme.palette.length]!
    return {
      id: node.id,
      name: node.name,
      itemStyle: {
        color: withAlpha(base, 0.72),
        borderColor: withAlpha(base, 0.9),
        borderWidth: 1,
      },
    }
  })

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: textColor, fontFamily: 'inherit' },
    tooltip: {
      trigger: 'item' as const,
      confine: true,
      backgroundColor: surfaceColor,
      borderColor,
      borderWidth: 1,
      textStyle: { color: textColor, fontSize: 12 },
      formatter: tooltipFormatter,
    },
    series: [{
      type: 'sankey' as const,
      data: nodeData,
      links: graph.value.links,
      orient: 'horizontal' as const,
      nodeAlign: 'justify' as const,
      nodeWidth: 12,
      nodeGap: 12,
      // Keep both model (left) and provider (right) labels inside narrow cards.
      left: 96,
      right: 88,
      top: 12,
      bottom: 12,
      draggable: false,
      layoutIterations: 32,
      label: {
        color: textColor,
        fontSize: 12,
        width: 88,
        overflow: 'truncate' as const,
        formatter: (params: unknown) => {
          if (!params || typeof params !== 'object') return ''
          const item = params as { data?: { name?: unknown }; name?: unknown }
          return String(item.data?.name ?? item.name ?? '')
        },
      },
      lineStyle: { color: 'gradient' as const, opacity: 0.25, curveness: 0.5 },
      emphasis: {
        focus: 'adjacency' as const,
        itemStyle: { opacity: 0.9 },
        lineStyle: { opacity: 0.45 },
      },
      levels: [
        { depth: 0, label: { position: 'left' as const, color: dimmedColor } },
        { depth: 1, label: { position: 'right' as const, color: dimmedColor } },
      ],
    }],
  }
})

onMounted(() => {
  stopThemeObserver = observeChartTheme(() => {
    themeVersion.value += 1
  })
})

onBeforeUnmount(() => {
  stopThemeObserver?.()
  stopThemeObserver = null
})
</script>

<template>
  <div class="min-w-0">
    <div v-if="loading" class="h-72 sm:h-80">
      <USkeleton class="h-full w-full" />
    </div>
    <div v-else-if="error" class="flex h-72 flex-col items-center justify-center gap-3 text-center sm:h-80">
      <p class="text-sm text-(--ui-text-muted)">{{ t('dashboard.chartLoadError') }}</p>
      <UButton
        size="sm"
        variant="outline"
        icon="i-lucide-refresh-cw"
        :label="t('dashboard.retry')"
        @click="emit('retry')"
      />
    </div>
    <div v-else-if="!hasData" class="flex h-72 items-center justify-center text-sm text-(--ui-text-dimmed) sm:h-80">
      {{ t('dashboard.noTokenFlowData') }}
    </div>
    <div v-else class="min-w-0" :style="{ height: `${chartHeight}px` }">
      <VChart class="h-full w-full" :option="chartOption" :autoresize="{ throttle: 100 }" />
    </div>
  </div>
</template>
