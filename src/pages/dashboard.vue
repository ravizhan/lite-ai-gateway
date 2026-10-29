<script setup lang="ts">
import { api } from '@/lib/api'
import type { StatsResult } from '../../shared/api'
import { useI18n } from 'vue-i18n'
import { readChartTheme, useChartTheme } from '@/lib/chartTheme'

const { t } = useI18n()

const rangeOptions = computed(() => [
  { label: t('dashboard.lastHour'), value: 3600 },
  { label: t('dashboard.last24Hours'), value: 86400 },
  { label: t('dashboard.last7Days'), value: 604800 },
  { label: t('dashboard.last30Days'), value: 2592000 },
])
const bucketSecondsByRange: Record<number, number> = {
  3600: 60,
  86400: 1800,
  604800: 10800,
  2592000: 43200,
}
const range = ref(86400)
const stats = ref<StatsResult | null>(null)
/** 已加载数据对应的查询窗口（毫秒）与分桶粒度（秒），用于补齐无数据的时间桶 */
const loadedWindow = ref<{ fromMs: number; toMs: number; bucket: number } | null>(null)
const loading = ref(false)
const error = ref(false)
const loadedRange = ref<number | null>(null)
const { themeVersion } = useChartTheme()

const staleStats = computed(() => stats.value != null && loadedRange.value !== range.value)

async function load() {
  loading.value = true
  error.value = false
  const requestedRange = range.value
  try {
    const toMs = Date.now()
    const fromMs = toMs - requestedRange * 1000
    const bucket = bucketSecondsByRange[requestedRange]!
    stats.value = await api<StatsResult>('/api/admin/stats', {
      query: { from: new Date(fromMs).toISOString(), bucket },
    })
    loadedWindow.value = { fromMs, toMs, bucket }
    loadedRange.value = requestedRange
  } catch {
    // 失败时保持旧数据，下次切换范围或点击重试
    error.value = true
  } finally {
    loading.value = false
  }
}

watch(range, load)
onMounted(load)

const totals = computed(() => stats.value?.totals)

const cacheRate = computed(() => {
  const t = totals.value
  return t && t.prompt_tokens > 0 ? (t.cached_tokens / t.prompt_tokens) * 100 : 0
})

/**
 * 按模型分桶 → 指标图共用的（时间戳 × 模型）矩阵。
 * 时间轴按查询窗口与分桶粒度连续生成（与服务端 strftime('%Y-%m-%dT%H:%M:00Z') 同格式），无数据的桶记 0，
 * 保证横轴间距等于真实时间间隔。
 */
const modelMatrix = computed(() => {
  void themeVersion.value
  const buckets = stats.value?.modelBuckets ?? []
  const window = loadedWindow.value
  const timestamps: string[] = []
  if (window && buckets.length) {
    const step = window.bucket * 1000
    for (let ms = Math.floor(window.fromMs / step) * step; ms <= window.toMs; ms += step) {
      timestamps.push(`${new Date(ms).toISOString().slice(0, 16)}:00Z`)
    }
  }
  const tsIndex = new Map(timestamps.map((ts, i) => [ts, i]))
  const models = [...new Set(buckets.map((b) => b.model))].sort()

  // 稳定配色：模型按字母序映射到语义主题调色板，跨指标图保持一致
  const palette = readChartTheme().palette

  const rows = models.map((model, i) => ({
    name: model,
    color: palette[i % palette.length]!,
    tokens: new Array<number>(timestamps.length).fill(0),
    cost: new Array<number>(timestamps.length).fill(0),
    requests: new Array<number>(timestamps.length).fill(0),
  }))
  const rowOf = new Map(rows.map((r) => [r.name, r]))

  for (const b of buckets) {
    const row = rowOf.get(b.model)
    const i = tsIndex.get(b.ts)
    if (!row || i == null) continue
    row.tokens[i]! += b.tokens
    row.cost[i]! += b.cost
    row.requests[i]! += b.requests
  }
  return { timestamps, rows }
})

const chartLabels = computed(() => modelMatrix.value.timestamps)

const metricCharts = computed(() => {
  const rows = modelMatrix.value.rows
  return [
    {
      key: 'tokenDistribution',
      format: fmtCompact,
      series: rows.map((r) => ({ name: r.name, color: r.color, values: r.tokens })),
    },
    {
      key: 'costDistribution',
      format: (v: number) => `$${v < 0.01 && v > 0 ? v.toExponential(1) : v.toFixed(4)}`,
      series: rows.map((r) => ({ name: r.name, color: r.color, values: r.cost })),
    },
    {
      key: 'requestDistribution',
      format: fmtCompact,
      series: rows.map((r) => ({ name: r.name, color: r.color, values: r.requests })),
    },
  ] as const
})

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtCompact(n: number): string {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
</script>

<template>
  <PageHeader :title="t('dashboard.title')" :description="t('dashboard.description')">
    <USelect v-model="range" :items="rangeOptions" class="w-40" :disabled="loading" />
  </PageHeader>

  <div v-if="stats && (error || staleStats)" class="flex flex-col gap-1 rounded-lg border border-(--ui-border) p-4 sm:flex-row sm:items-center sm:justify-between">
    <div class="text-sm text-(--ui-text-muted)">
      <p v-if="error">{{ t('dashboard.loadError') }}</p>
      <p v-else>{{ t('dashboard.refreshing') }}</p>
      <p v-if="staleStats" class="text-xs text-(--ui-text-dimmed)">{{ t('dashboard.showingPreviousRange') }}</p>
    </div>
    <UButton v-if="error" size="sm" variant="outline" icon="i-lucide-refresh-cw" :label="t('dashboard.retry')" @click="load" />
  </div>

  <div v-if="loading && !stats" class="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
    <UCard v-for="i in 6" :key="i" :ui="{ body: 'sm:p-4' }">
      <USkeleton class="h-3 w-16" />
      <USkeleton class="mt-2 h-7 w-24" />
    </UCard>
  </div>
  <div v-else-if="error && !stats" class="rounded-lg border border-(--ui-border) p-4">
    <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm text-(--ui-text-muted)">{{ t('dashboard.loadError') }}</p>
      <UButton size="sm" variant="outline" icon="i-lucide-refresh-cw" :label="t('dashboard.retry')" @click="load" />
    </div>
  </div>
  <div v-else class="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
    <StatCard :label="t('dashboard.requests')" :value="fmtInt(totals?.requests ?? 0)" icon="i-lucide-activity" />
    <StatCard :label="t('dashboard.tokens')" :value="fmtInt(totals?.total_tokens ?? 0)" icon="i-lucide-hash" />
    <StatCard :label="t('dashboard.costUsd')" :value="`$${(totals?.cost ?? 0).toFixed(4)}`" icon="i-lucide-dollar-sign" />
    <StatCard
      :label="t('dashboard.avgTtft')"
      :value="totals?.avg_ttft_ms != null ? `${(totals.avg_ttft_ms / 1000).toFixed(2)} s` : '-'"
      icon="i-lucide-timer"
    />
    <StatCard
      :label="t('dashboard.avgTps')"
      :value="totals?.avg_tps != null ? totals.avg_tps.toFixed(1) : '-'"
      icon="i-lucide-gauge"
    />
    <StatCard :label="t('dashboard.cacheRate')" :value="`${cacheRate.toFixed(1)}%`" icon="i-lucide-database-zap" />
  </div>

  <div class="flex min-w-0 flex-col gap-4">
    <UCard :title="t('dashboard.tokenFlow')" :ui="{ body: 'min-w-0' }">
      <TokenFlowChart
        :flows="stats?.tokenFlows ?? []"
        :loading="loading && !stats"
        :error="error && !stats"
        @retry="load"
      />
    </UCard>
    <UCard v-for="chart in metricCharts" :key="chart.key" :title="t(`dashboard.${chart.key}`)" :ui="{ body: 'min-w-0' }">
      <ModelSeriesChart
        :labels="chartLabels"
        :series="chart.series"
        :format="chart.format"
        group="dashboard-model-metrics"
      />
    </UCard>
  </div>
</template>
