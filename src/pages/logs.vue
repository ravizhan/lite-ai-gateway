<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../lib/api'
import { formatLocalTs } from '../lib/time'
import { usePagedList } from '../composables/usePagedList'
import type { LlmLogRow, ProviderRow } from '../../shared/api'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { rows, total, page, pageSize, loading, filters, load, search } = usePagedList<LlmLogRow>(
  '/api/admin/logs',
  { model: '', protocol: '', providerId: '', status: '' },
)

const providers = ref<ProviderRow[]>([])

// 每 30 秒后台静默拉取当前页（保留筛选与页码，不显示加载态）；标签页隐藏时跳过
const AUTO_REFRESH_MS = 30_000
let refreshTimer: ReturnType<typeof setInterval> | undefined

// ---------- 详情弹窗 ----------
const detailOpen = ref(false)
const detailLoading = ref(false)
const detail = ref<LlmLogRow | null>(null)

const protocolOptions = computed(() => [
  { label: t('logs.allProtocols'), value: null },
  { label: 'chat', value: 'chat' },
  { label: 'responses', value: 'responses' },
  { label: 'embedding', value: 'embedding' },
])
const statusOptions = computed(() => [
  { label: t('logs.allStatuses'), value: null },
  { label: '200', value: '200' },
  { label: '400', value: '400' },
  { label: '401', value: '401' },
  { label: '429', value: '429' },
  { label: '500', value: '500' },
  { label: '502', value: '502' },
])

onMounted(async () => {
  void load()
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !loading.value) void load({ silent: true })
  }, AUTO_REFRESH_MS)
  try {
    providers.value = await api<ProviderRow[]>('/api/admin/providers')
  } catch {
    // 过滤选项为辅助数据，失败不阻塞列表
  }
})
onBeforeUnmount(() => clearInterval(refreshTimer))

// 点击行 → 拉取完整详情（含 req_body/resp_body）弹窗展示
async function openDetail(_e: Event, row: { id: string }) {
  detailOpen.value = true
  detailLoading.value = true
  detail.value = rows.value.find((r) => String(r.id) === row.id) ?? null
  try {
    detail.value = await api<LlmLogRow>(`/api/admin/logs/${row.id}`)
  } catch {
    // 详情拉取失败时保留列表行数据展示
  } finally {
    detailLoading.value = false
  }
}

function statusColor(status: number) {
  if (status < 300) return 'success'
  if (status < 500) return 'warning'
  return 'error'
}

function cacheRate(row: LlmLogRow) {
  return row.prompt_tokens > 0 ? ((row.cached_tokens / row.prompt_tokens) * 100).toFixed(1) : '-'
}

// 配色参考 new-api：success=绿、warning=琥珀、error=红（semantic 色随亮暗主题自动适配）
function rateColor(rate: string): string {
  if (rate === '-') return ''
  const n = Number(rate)
  if (n >= 50) return 'text-(--ui-success)'
  if (n >= 20) return 'text-(--ui-warning)'
  return 'text-(--ui-error)'
}

// new-api getFirstResponseTimeColor：<5s 绿、<10s 琥珀、>=10s 红
function ttftColor(ms: number | null): string {
  if (ms == null) return ''
  if (ms < 5000) return 'text-(--ui-success)'
  if (ms < 10000) return 'text-(--ui-warning)'
  return 'text-(--ui-error)'
}

function fmtTtft(ms: number | null): string {
  return ms == null ? '-' : `${(ms / 1000).toFixed(2)} s`
}

// new-api getThroughputColor：>=30 t/s 绿、>=15 琥珀、<15 红
function tpsColor(tps: number | null): string {
  if (tps == null) return ''
  if (tps >= 30) return 'text-(--ui-success)'
  if (tps >= 15) return 'text-(--ui-warning)'
  return 'text-(--ui-error)'
}

function billing(row: LlmLogRow): string {
  return t(row.protocol === 'embedding' ? 'logs.billingEmbedding' : 'logs.billingRecorded', {
    cost: row.cost.toFixed(6),
  })
}

const columns = computed(() => [
  { accessorKey: 'ts', header: t('cols.time') },
  { accessorKey: 'model', header: t('cols.model') },
  { accessorKey: 'provider_name', header: t('cols.provider') },
  { accessorKey: 'protocol', header: t('cols.protocol') },
  { accessorKey: 'stream', header: t('cols.mode') },
  { accessorKey: 'status', header: t('cols.status') },
  { id: 'tokens', header: t('cols.tokens') },
  { id: 'cache_rate', header: t('logs.cacheRate') },
  { accessorKey: 'ttft_ms', header: t('cols.ttft') },
  { accessorKey: 'tps', header: t('cols.tps') },
  { accessorKey: 'cost', header: t('cols.cost') },
])

/** 详情里的请求/响应体：能解析成 JSON 就美化缩进，否则原样展示 */
function formatBody(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
</script>

<template>
  <PageHeader :title="t('logs.title')" :description="t('logs.description')" />

  <UCard>
    <div class="flex flex-wrap items-end gap-3">
      <UFormField :label="t('logs.modelFilter')" class="w-full sm:w-44">
        <UInput v-model="filters.model" placeholder="e.g. deepseek" class="w-full" @keyup.enter="search" />
      </UFormField>
      <UFormField :label="t('logs.protocol')" class="w-full sm:w-40">
        <USelect v-model="filters.protocol" :items="protocolOptions" class="w-full" />
      </UFormField>
      <UFormField :label="t('logs.provider')" class="w-full sm:w-44">
        <USelect
          v-model="filters.providerId"
          :items="[{ label: t('logs.allProviders'), value: null }, ...providers.map((p) => ({ label: p.name, value: String(p.id) }))]"
          class="w-full"
        />
      </UFormField>
      <UFormField :label="t('logs.status')" class="w-full sm:w-36">
        <USelect v-model="filters.status" :items="statusOptions" class="w-full" />
      </UFormField>
      <UButton icon="i-lucide-search" :label="t('common.search')" :loading="loading" @click="search" />
    </div>
  </UCard>

  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <UTable
      :data="rows"
      :columns="columns"
      :loading="loading"
      :get-row-id="(r: LlmLogRow) => String(r.id)"
      class="cursor-pointer"
      :empty="t('logs.empty')"
      @select="openDetail"
    >
      <template #ts-cell="{ row }">
        <span class="whitespace-nowrap tabular-nums">{{ formatLocalTs(row.original.ts, 'datetime-short') }}</span>
      </template>
      <template #model-cell="{ row }">
        <span class="block max-w-44 truncate font-medium text-(--ui-text-highlighted)" :title="row.original.model">
          {{ row.original.model }}
        </span>
      </template>
      <template #provider_name-cell="{ row }">
        {{ row.original.provider_name ?? '-' }}
      </template>
      <template #protocol-cell="{ row }">
        <UBadge color="info" variant="subtle">{{ row.original.protocol }}</UBadge>
      </template>
      <template #stream-cell="{ row }">
        <UBadge :color="row.original.stream === 1 ? 'primary' : 'neutral'" variant="subtle">
          {{ row.original.stream === 1 ? t('logs.stream') : t('logs.sync') }}
        </UBadge>
      </template>
      <template #status-cell="{ row }">
        <UBadge :color="statusColor(row.original.status)" variant="subtle">{{ row.original.status }}</UBadge>
      </template>
      <template #tokens-cell="{ row }">
        <UTooltip
          :text="t('logs.tokensTooltip', {
            prompt: row.original.prompt_tokens,
            completion: row.original.completion_tokens,
            cached: row.original.cached_tokens,
          })"
        >
          <span class="whitespace-nowrap tabular-nums">
            <span class="text-(--ui-success)">{{ row.original.prompt_tokens }}</span>
            <span class="text-(--ui-text-dimmed)"> / </span>
            <span class="text-(--ui-info)">{{ row.original.completion_tokens }}</span>
            <span class="text-(--ui-text-dimmed)"> / </span>
            <span class="text-(--ui-warning)">{{ row.original.cached_tokens }}</span>
          </span>
        </UTooltip>
      </template>
      <template #cache_rate-cell="{ row }">
        <span class="tabular-nums" :class="rateColor(cacheRate(row.original))">
          {{ cacheRate(row.original) }}<template v-if="cacheRate(row.original) !== '-'">%</template>
        </span>
      </template>
      <template #ttft_ms-cell="{ row }">
        <span class="tabular-nums" :class="ttftColor(row.original.ttft_ms)">{{ fmtTtft(row.original.ttft_ms) }}</span>
      </template>
      <template #tps-cell="{ row }">
        <span class="tabular-nums" :class="tpsColor(row.original.tps)">
          {{ row.original.tps != null ? row.original.tps.toFixed(1) : '-' }}
        </span>
      </template>
      <template #cost-cell="{ row }">
        <span class="tabular-nums">${{ row.original.cost.toFixed(6) }}</span>
      </template>
    </UTable>
    <div v-if="total > 0" class="flex flex-wrap items-center justify-between gap-2 border-t border-(--ui-border) px-4 py-3">
      <span class="text-xs text-(--ui-text-muted)">{{ t('logs.count', { count: total }) }}</span>
      <UPagination v-model:page="page" :total="total" :items-per-page="pageSize" @update:page="load()" />
    </div>
  </UCard>

  <UModal
    v-model:open="detailOpen"
    :title="t('logs.detailTitle')"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div v-if="detailLoading && !detail" class="flex flex-col gap-2">
        <USkeleton class="h-5 w-full" />
        <USkeleton class="h-5 w-2/3" />
        <USkeleton class="h-32 w-full" />
      </div>
      <div v-else-if="detail" class="flex flex-col gap-4 text-sm">
        <div class="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.time') }}</div>
            <div class="tabular-nums">{{ formatLocalTs(detail.ts) }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.model') }}</div>
            <div class="font-medium text-(--ui-text-highlighted)">{{ detail.model }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.provider') }}</div>
            <div>{{ detail.provider_name ?? '-' }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.protocol') }}</div>
            <UBadge color="info" variant="subtle">{{ detail.protocol }}</UBadge>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.mode') }}</div>
            <UBadge :color="detail.stream === 1 ? 'primary' : 'neutral'" variant="subtle">
              {{ detail.stream === 1 ? t('logs.stream') : t('logs.sync') }}
            </UBadge>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.status') }}</div>
            <UBadge :color="statusColor(detail.status)" variant="subtle">{{ detail.status }}</UBadge>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.tokens') }}</div>
            <div class="tabular-nums">
              <span class="text-(--ui-success)">{{ detail.prompt_tokens }}</span>
              <span class="text-(--ui-text-dimmed)"> / </span>
              <span class="text-(--ui-info)">{{ detail.completion_tokens }}</span>
              <span class="text-(--ui-text-dimmed)"> / </span>
              <span class="text-(--ui-warning)">{{ detail.cached_tokens }}</span>
            </div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.ttft') }}</div>
            <div class="tabular-nums" :class="ttftColor(detail.ttft_ms)">{{ fmtTtft(detail.ttft_ms) }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.tps') }}</div>
            <div class="tabular-nums" :class="tpsColor(detail.tps)">
              {{ detail.tps != null ? detail.tps.toFixed(1) : '-' }}
            </div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.cost') }}</div>
            <div class="tabular-nums">${{ detail.cost.toFixed(6) }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('logs.duration') }}</div>
            <div class="tabular-nums">{{ detail.duration_ms }} ms</div>
          </div>
          <div v-if="detail.client_ip">
            <div class="text-xs text-(--ui-text-muted)">{{ t('logs.clientIp') }}</div>
            <div>{{ detail.client_ip }}</div>
          </div>
        </div>

        <div v-if="detail.error" class="rounded-md border border-(--ui-error)/30 bg-(--ui-error)/5 px-3 py-2 text-(--ui-text-error)">
          <span class="font-semibold">{{ t('logs.error') }}:</span> {{ detail.error }}
        </div>

        <div class="text-xs text-(--ui-text-muted)">
          <span class="font-semibold text-(--ui-text)">{{ t('logs.billing') }}:</span> {{ billing(detail) }}
        </div>

        <template v-if="detail.req_body !== null || detail.resp_body !== null">
          <UCollapsible v-if="detail.req_body !== null" class="rounded-md border border-(--ui-border)">
            <div class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 hover:bg-(--ui-bg-elevated)">
              <span class="flex items-center gap-1.5 text-xs font-semibold text-(--ui-text-highlighted)">
                <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed) transition-transform [[data-state=open]_&]:rotate-90" />
                {{ t('logs.reqBody') }}
              </span>
              <span @click.stop>
                <CopyButton :text="formatBody(detail.req_body)" />
              </span>
            </div>
            <template #content>
              <pre class="max-h-72 overflow-auto border-t border-(--ui-border) bg-(--ui-bg-muted) p-3 font-mono text-xs leading-relaxed">{{ formatBody(detail.req_body) }}</pre>
            </template>
          </UCollapsible>
          <UCollapsible v-if="detail.resp_body !== null" class="rounded-md border border-(--ui-border)">
            <div class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 hover:bg-(--ui-bg-elevated)">
              <span class="flex items-center gap-1.5 text-xs font-semibold text-(--ui-text-highlighted)">
                <UIcon name="i-lucide-chevron-right" class="size-4 text-(--ui-text-dimmed) transition-transform [[data-state=open]_&]:rotate-90" />
                {{ t('logs.respBody') }}
              </span>
              <span @click.stop>
                <CopyButton :text="formatBody(detail.resp_body)" />
              </span>
            </div>
            <template #content>
              <pre class="max-h-72 overflow-auto border-t border-(--ui-border) bg-(--ui-bg-muted) p-3 font-mono text-xs leading-relaxed">{{ formatBody(detail.resp_body) }}</pre>
            </template>
          </UCollapsible>
        </template>
      </div>
    </template>
  </UModal>
</template>
