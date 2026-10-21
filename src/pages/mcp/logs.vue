<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePagedList } from '../../composables/usePagedList'
import { formatLocalTs } from '../../lib/time'
import type { McpLogRow } from '../../../shared/api'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { rows, total, page, pageSize, loading, filters, load, search } = usePagedList<McpLogRow>(
  '/api/admin/mcp/logs',
  { server: '', method: '' },
)

const methodOptions = computed(() => [
  { label: t('mcpLogs.allMethods'), value: null },
  { label: 'initialize', value: 'initialize' },
  { label: 'notifications/initialized', value: 'notifications/initialized' },
  { label: 'ping', value: 'ping' },
  { label: 'tools/list', value: 'tools/list' },
  { label: 'tools/call', value: 'tools/call' },
  { label: 'prompts/list', value: 'prompts/list' },
  { label: 'prompts/get', value: 'prompts/get' },
  { label: 'resources/list', value: 'resources/list' },
  { label: 'resources/read', value: 'resources/read' },
])

// ---------- 详情弹窗 ----------
// 列表行已带完整请求体与失败响应体（SELECT *），点击行直接展示，无需二次请求
const detail = ref<McpLogRow | null>(null)

const detailOpen = computed({
  get: () => detail.value !== null,
  set: (v: boolean) => {
    if (!v) detail.value = null
  },
})

function openDetail(_e: Event, row: { original: McpLogRow }) {
  detail.value = row.original
}

/** 请求/失败响应体：能解析成 JSON 就美化缩进，否则按原文展示 */
function formatBody(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const columns = computed(() => [
  { accessorKey: 'ts', header: t('cols.time') },
  { accessorKey: 'group_name', header: t('cols.group') },
  { accessorKey: 'server_name', header: t('cols.server') },
  { accessorKey: 'method', header: t('cols.method') },
  { accessorKey: 'tool_name', header: t('cols.tool') },
  { accessorKey: 'duration_ms', header: t('cols.duration') },
  { accessorKey: 'ok', header: t('cols.result') },
])

onMounted(() => {
  void load()
})
</script>

<template>
  <PageHeader :title="t('mcpLogs.title')" :description="t('mcpLogs.description')" />

  <UCard>
    <div class="flex flex-wrap items-end gap-3">
      <UFormField :label="t('mcpLogs.serverFilter')" class="w-full sm:w-48">
        <UInput v-model="filters.server" placeholder="e.g. filesystem" class="w-full" @keyup.enter="search" />
      </UFormField>
      <UFormField :label="t('mcpLogs.method')" class="w-full sm:w-48">
        <USelect v-model="filters.method" :items="methodOptions" class="w-full" />
      </UFormField>
      <UButton icon="i-lucide-search" :label="t('common.search')" :loading="loading" @click="search" />
    </div>
  </UCard>

  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <UTable
      :data="rows"
      :columns="columns"
      :loading="loading"
      :get-row-id="(r: McpLogRow) => String(r.id)"
      class="cursor-pointer"
      :empty="t('mcpLogs.empty')"
      @select="openDetail"
    >
      <template #ts-cell="{ row }">
        <span class="whitespace-nowrap tabular-nums">{{ formatLocalTs(row.original.ts, 'datetime-short') }}</span>
      </template>
      <template #group_name-cell="{ row }">
        {{ row.original.group_name ?? '-' }}
      </template>
      <template #server_name-cell="{ row }">
        <span class="font-medium text-(--ui-text-highlighted)">{{ row.original.server_name ?? '-' }}</span>
      </template>
      <template #method-cell="{ row }">
        <UBadge color="neutral" variant="subtle">{{ row.original.method }}</UBadge>
      </template>
      <template #tool_name-cell="{ row }">
        <span class="block max-w-44 truncate font-mono text-xs" :title="row.original.tool_name ?? ''">
          {{ row.original.tool_name ?? '-' }}
        </span>
      </template>
      <template #duration_ms-cell="{ row }">
        <span class="tabular-nums">{{ row.original.duration_ms }} ms</span>
      </template>
      <template #ok-cell="{ row }">
        <UBadge :color="row.original.ok === 1 ? 'success' : 'error'" variant="subtle">
          {{ row.original.ok === 1 ? t('mcpLogs.ok') : t('mcpLogs.failed') }}
        </UBadge>
      </template>
    </UTable>
    <div v-if="total > 0" class="flex flex-wrap items-center justify-between gap-2 border-t border-(--ui-border) px-4 py-3">
      <span class="text-xs text-(--ui-text-muted)">{{ t('mcpLogs.entries', { count: total }) }}</span>
      <UPagination v-model:page="page" :total="total" :items-per-page="pageSize" @update:page="load" />
    </div>
  </UCard>

  <UModal
    v-model:open="detailOpen"
    :title="t('mcpLogs.detailTitle')"
    :ui="{ content: 'max-w-3xl', footer: 'justify-end' }"
  >
    <template #body>
      <div v-if="detail" class="flex flex-col gap-4 text-sm">
        <div class="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.time') }}</div>
            <div class="tabular-nums">{{ formatLocalTs(detail.ts) }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.group') }}</div>
            <div>{{ detail.group_name ?? '-' }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.server') }}</div>
            <div class="font-medium text-(--ui-text-highlighted)">{{ detail.server_name ?? '-' }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.method') }}</div>
            <UBadge color="neutral" variant="subtle">{{ detail.method }}</UBadge>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.tool') }}</div>
            <div class="break-all font-mono text-xs">{{ detail.tool_name ?? '-' }}</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.duration') }}</div>
            <div class="tabular-nums">{{ detail.duration_ms }} ms</div>
          </div>
          <div>
            <div class="text-xs text-(--ui-text-muted)">{{ t('cols.result') }}</div>
            <UBadge :color="detail.ok === 1 ? 'success' : 'error'" variant="subtle">
              {{ detail.ok === 1 ? t('mcpLogs.ok') : t('mcpLogs.failed') }}
            </UBadge>
          </div>
        </div>

        <div
          v-if="detail.error"
          class="break-all rounded-md border border-(--ui-error)/30 bg-(--ui-error)/5 px-3 py-2 text-(--ui-text-error)"
        >
          <span class="font-semibold">{{ t('mcpLogs.error') }}:</span> {{ detail.error }}
        </div>

        <UCollapsible v-if="detail.request_body" class="rounded-md border border-(--ui-border)">
          <div class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 hover:bg-(--ui-bg-elevated)">
            <span class="flex items-center gap-1.5 text-xs font-semibold text-(--ui-text-highlighted)">
              <UIcon
                name="i-lucide-chevron-right"
                class="size-4 text-(--ui-text-dimmed) transition-transform [[data-state=open]_&]:rotate-90"
              />
              {{ t('mcpLogs.requestBody') }}
            </span>
            <span @click.stop>
              <CopyButton :text="formatBody(detail.request_body)" />
            </span>
          </div>
          <template #content>
            <pre
              class="max-h-72 overflow-auto border-t border-(--ui-border) bg-(--ui-bg-muted) p-3 font-mono text-xs leading-relaxed"
            >{{ formatBody(detail.request_body) }}</pre>
          </template>
        </UCollapsible>
        <div v-else class="rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) px-3 py-2 text-xs text-(--ui-text-muted)">
          {{ t('mcpLogs.noRequestBody') }}
        </div>

        <!-- 成功调用不记录响应体，只有失败时才展示上游原始响应 -->
        <UCollapsible
          v-if="detail.ok !== 1 && detail.response_body"
          class="rounded-md border border-(--ui-border)"
        >
          <div class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 hover:bg-(--ui-bg-elevated)">
            <span class="flex items-center gap-1.5 text-xs font-semibold text-(--ui-text-highlighted)">
              <UIcon
                name="i-lucide-chevron-right"
                class="size-4 text-(--ui-text-dimmed) transition-transform [[data-state=open]_&]:rotate-90"
              />
              {{ t('mcpLogs.responseBody') }}
            </span>
            <span @click.stop>
              <CopyButton :text="formatBody(detail.response_body)" />
            </span>
          </div>
          <template #content>
            <pre
              class="max-h-72 overflow-auto border-t border-(--ui-border) bg-(--ui-bg-muted) p-3 font-mono text-xs leading-relaxed"
            >{{ formatBody(detail.response_body) }}</pre>
          </template>
        </UCollapsible>
      </div>
    </template>
    <template #footer>
      <UButton :label="t('common.close')" @click="detail = null" />
    </template>
  </UModal>
</template>
