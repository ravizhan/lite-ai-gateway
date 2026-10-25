<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { api } from '../lib/api'
import type { McpCapabilitiesResult, McpServerCapabilities } from '../../shared/api'
import type {
  McpSearchPreset,
  McpSearchPresetsResult,
  McpSearchPreviewResult,
  McpSearchUpstreamItem,
} from '../../shared/mcp-search'

/** 统一请求样例：仅作为预览输入，从不提交；用户可改成真实请求 */
const SAMPLE_REQUEST_TEXT = JSON.stringify(
  {
    query: 'MCP structuredContent',
    max_results: 1,
    objective: 'Find official documentation for MCP structured outputs.',
  },
  null,
  2,
)
const SAMPLE_REQUEST_PLACEHOLDER = '{"query": "...", "max_results": 10}'
const SAMPLE_RESPONSE_PLACEHOLDER = '{"content": [{"type": "text", "text": "..."}]}'

const props = defineProps<{ upstream?: McpSearchUpstreamItem | null }>()
const emit = defineEmits<{ saved: [] }>()
const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const { t } = useI18n()
const saving = ref(false)

/** 引用数据：服务器/工具快照、预置、已有绑定（用于排除已占用的 server+tool 组合） */
const capabilityServers = ref<McpServerCapabilities[]>([])
const presets = ref<McpSearchPreset[]>([])
const occupied = ref<McpSearchUpstreamItem[]>([])
const refLoading = ref(false)
const refLoaded = ref(false)
const refError = ref('')

const form = reactive({
  server_id: null as number | null,
  tool_name: null as string | null,
  request_code: '',
  response_code: '',
  sample_request: SAMPLE_REQUEST_TEXT,
  sample_response: '',
  enabled: true,
  preset_id: null as string | null,
  preset_version: null as number | null,
})
const errors = reactive({ server_id: '', tool_name: '', request_code: '', response_code: '' })

/** 预置候选是未提交的表单动作；form.preset_id 才是已应用的来源元数据 */
const presetId = ref<string | null>(null)
const pendingPreset = ref<McpSearchPreset | null>(null)
const showOverwrite = ref(false)

interface PreviewState {
  loading: boolean
  error: string
  output: string
}
const requestPreview = reactive<PreviewState>({ loading: false, error: '', output: '' })
const responsePreview = reactive<PreviewState>({ loading: false, error: '', output: '' })
/** 每次输入变化递增：异步返回只在序号未变（输入仍是快照）时显示 */
let requestSeq = 0
let responseSeq = 0

watch(open, (value) => {
  if (!value) return
  resetForm()
  void loadReference()
})

watch(showOverwrite, (value) => {
  if (!value) pendingPreset.value = null
})

// 代码或样例一旦变化，旧预览结果立即失效，在途响应也会被序号检查丢弃
watch(
  () => [form.request_code, form.sample_request],
  () => invalidateRequestPreview(),
)
watch(
  () => [form.response_code, form.sample_response, form.sample_request],
  () => invalidateResponsePreview(),
)

function resetForm() {
  const upstream = props.upstream
  form.server_id = upstream?.server_id ?? null
  form.tool_name = upstream?.tool_name ?? null
  form.request_code = upstream?.request_code ?? ''
  form.response_code = upstream?.response_code ?? ''
  form.sample_request = SAMPLE_REQUEST_TEXT
  form.sample_response = ''
  form.enabled = (upstream?.enabled ?? 1) === 1
  form.preset_id = upstream?.preset_id ?? null
  form.preset_version = upstream?.preset_version ?? null
  presetId.value = null
  pendingPreset.value = null
  showOverwrite.value = false
  clearErrors()
  invalidateRequestPreview()
  invalidateResponsePreview()
}

function clearErrors() {
  errors.server_id = errors.tool_name = errors.request_code = errors.response_code = ''
}

function invalidateRequestPreview() {
  requestSeq += 1
  requestPreview.loading = false
  requestPreview.error = ''
  requestPreview.output = ''
}

function invalidateResponsePreview() {
  responseSeq += 1
  responsePreview.loading = false
  responsePreview.error = ''
  responsePreview.output = ''
}

async function loadReference() {
  refLoading.value = true
  refError.value = ''
  try {
    const [caps, presetResult, bindings] = await Promise.all([
      api<McpCapabilitiesResult>('/api/admin/mcp/capabilities'),
      api<McpSearchPresetsResult>('/api/admin/mcp/search/presets'),
      api<McpSearchUpstreamItem[]>('/api/admin/mcp/search/upstreams'),
    ])
    capabilityServers.value = caps.servers
    presets.value = [...presetResult.presets]
    occupied.value = bindings
    refLoaded.value = true
  } catch (e) {
    refError.value = e instanceof Error ? e.message : t('mcpSearch.referenceFailed')
  } finally {
    refLoading.value = false
  }
}

const serverOptions = computed(() => {
  const serverId = form.server_id
  const options: { label: string; value: number | null }[] = [
    { label: t('mcpSearch.selectServer'), value: null },
    ...capabilityServers.value.map((server) => ({ label: server.server_name, value: server.server_id })),
  ]
  // 快照里找不到当前服务器时仍展示已保存的值，便于停用或改选
  if (serverId !== null && !options.some((option) => option.value === serverId)) {
    options.unshift({ label: props.upstream?.server_name ?? String(serverId), value: serverId })
  }
  return options
})

const selectedServer = computed(
  () => capabilityServers.value.find((server) => server.server_id === form.server_id) ?? null,
)

const serverToolNames = computed(() =>
  (selectedServer.value?.capabilities ?? [])
    .filter((capability) => capability.kind === 'tool')
    .map((capability) => capability.name)
    .sort((a, b) => a.localeCompare(b)),
)

const hasServerTools = computed(() => serverToolNames.value.length > 0)

function isOccupied(serverId: number, toolName: string) {
  return occupied.value.some(
    (binding) => binding.server_id === serverId && binding.tool_name === toolName && binding.id !== props.upstream?.id,
  )
}

const toolOptions = computed(() => {
  const serverId = form.server_id
  if (serverId === null) return []
  const options: { label: string; value: string | null }[] = [
    { label: t('mcpSearch.selectTool'), value: null },
    ...serverToolNames.value
      .filter((name) => !isOccupied(serverId, name))
      .map((name) => ({ label: name, value: name })),
  ]
  // 已保存的工具即使已从快照消失也保留显示（只允许停用或改选）
  const toolName = form.tool_name
  if (toolName && !options.some((option) => option.value === toolName)) {
    options.unshift({ label: toolName, value: toolName })
  }
  return options
})

const toolMissingFromSnapshot = computed(() => {
  if (!refLoaded.value || form.server_id === null || !form.tool_name) return false
  return !serverToolNames.value.includes(form.tool_name)
})

const targetChanged = computed(() => {
  const upstream = props.upstream
  if (!upstream) return true
  return upstream.server_id !== form.server_id || upstream.tool_name !== form.tool_name
})

/** 与服务端一致：目标变化或从禁用切到启用时，快照里必须仍有该工具 */
const missingToolBlocksSave = computed(() => {
  if (!toolMissingFromSnapshot.value) return false
  if (targetChanged.value) return true
  return props.upstream?.enabled === 0 && form.enabled
})

const toolError = computed(() => {
  if (errors.tool_name) return errors.tool_name
  if (!missingToolBlocksSave.value) return ''
  return targetChanged.value ? t('mcpSearch.unknownPresetTool') : t('mcpSearch.toolMissing')
})

const toolHelp = computed(() => {
  if (toolMissingFromSnapshot.value && !missingToolBlocksSave.value) return t('mcpSearch.toolMissing')
  if (form.server_id !== null && refLoaded.value && !hasServerTools.value) return t('mcpSearch.noTools')
  return ''
})

const presetOptions = computed<{ label: string; value: string | null }[]>(() => [
  { label: t('mcpSearch.selectPreset'), value: null },
  ...presets.value.map((preset) => ({ label: preset.label, value: preset.id })),
])

const appliedPresetLabel = computed(() => {
  if (!form.preset_id) return ''
  return presets.value.find((preset) => preset.id === form.preset_id)?.label ?? form.preset_id
})

/** Tavily 纯文本格式的已知损失：只在选中/来源为 tavily 时说明 */
const showTavilyWarning = computed(() => presetId.value === 'tavily' || form.preset_id === 'tavily')

function onServerChange(value: number | null) {
  form.server_id = value
  form.tool_name = null
  errors.tool_name = ''
}

function applySelectedPreset() {
  const preset = presets.value.find((item) => item.id === presetId.value)
  if (!preset) return
  if (form.request_code.trim() || form.response_code.trim()) {
    pendingPreset.value = preset
    showOverwrite.value = true
    return
  }
  copyPreset(preset)
}

function copyPreset(preset: McpSearchPreset) {
  form.tool_name = preset.tool_name
  form.request_code = preset.request_code
  form.response_code = preset.response_code
  form.sample_request = JSON.stringify(preset.sample_request, null, 2)
  form.sample_response = JSON.stringify(preset.sample_response, null, 2)
  form.preset_id = preset.id
  form.preset_version = preset.version
  errors.tool_name = ''
  errors.request_code = ''
  errors.response_code = ''
  showOverwrite.value = false
  pendingPreset.value = null
}

function confirmOverwrite() {
  const preset = pendingPreset.value
  showOverwrite.value = false
  pendingPreset.value = null
  if (preset) copyPreset(preset)
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

async function previewRequest() {
  requestPreview.error = ''
  requestPreview.output = ''
  const request = parseJsonObject(form.sample_request)
  if (!request) {
    requestPreview.error = t('mcpSearch.invalidJson')
    return
  }
  const seq = ++requestSeq
  requestPreview.loading = true
  try {
    const result = await api<McpSearchPreviewResult>('/api/admin/mcp/search/preview', {
      method: 'POST',
      body: { stage: 'request', code: form.request_code, request },
    })
    if (seq !== requestSeq) return
    requestPreview.output = JSON.stringify(result.output, null, 2)
  } catch (e) {
    if (seq !== requestSeq) return
    requestPreview.error = e instanceof Error ? e.message : t('mcpSearch.previewFailed')
  } finally {
    if (seq === requestSeq) requestPreview.loading = false
  }
}

async function previewResponse() {
  responsePreview.error = ''
  responsePreview.output = ''
  const request = parseJsonObject(form.sample_request)
  const response = parseJsonObject(form.sample_response)
  if (!request || !response) {
    responsePreview.error = t('mcpSearch.invalidJson')
    return
  }
  const seq = ++responseSeq
  responsePreview.loading = true
  try {
    const result = await api<McpSearchPreviewResult>('/api/admin/mcp/search/preview', {
      method: 'POST',
      body: { stage: 'response', code: form.response_code, request, response },
    })
    if (seq !== responseSeq) return
    responsePreview.output = JSON.stringify(result.output, null, 2)
  } catch (e) {
    if (seq !== responseSeq) return
    responsePreview.error = e instanceof Error ? e.message : t('mcpSearch.previewFailed')
  } finally {
    if (seq === responseSeq) responsePreview.loading = false
  }
}

async function submit() {
  if (saving.value) return
  clearErrors()
  const serverId = form.server_id
  const toolName = form.tool_name
  if (serverId === null) errors.server_id = t('mcpSearch.selectServer')
  if (!toolName) errors.tool_name = t('mcpSearch.selectTool')
  if (!form.request_code.trim()) errors.request_code = t('mcpSearch.codeRequired')
  if (!form.response_code.trim()) errors.response_code = t('mcpSearch.codeRequired')
  if (errors.server_id || errors.tool_name || errors.request_code || errors.response_code) return
  if (serverId === null || !toolName) return
  if (missingToolBlocksSave.value) {
    errors.tool_name = toolError.value
    return
  }
  saving.value = true
  try {
    const body = {
      server_id: serverId,
      tool_name: toolName.trim(),
      request_code: form.request_code,
      response_code: form.response_code,
      enabled: form.enabled ? 1 : 0,
      preset_id: form.preset_id,
      preset_version: form.preset_version,
    }
    if (props.upstream) {
      await api(`/api/admin/mcp/search/upstreams/${props.upstream.id}`, { method: 'PUT', body })
    } else {
      await api('/api/admin/mcp/search/upstreams', { method: 'POST', body })
    }
    toast.add({ title: t('mcpSearch.saved'), color: 'success' })
    open.value = false
    emit('saved')
  } catch (e) {
    const message = e instanceof Error ? e.message : t('mcpSearch.saveFailed')
    // 语法错误回填到对应字段，其余失败只提示；输入与弹窗都保留
    if (message.includes('request_code')) errors.request_code = message
    else if (message.includes('response_code')) errors.response_code = message
    else toast.add({ title: message, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="props.upstream ? t('mcpSearch.editTitle') : t('mcpSearch.addTitle')"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'sm:max-w-4xl', footer: 'justify-end gap-2' }"
  >
    <template #body>
      <fieldset :disabled="saving" class="flex min-w-0 flex-col gap-4">
        <UAlert
          v-if="refError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('mcpSearch.referenceFailed')"
          :description="refError"
        >
          <template #actions>
            <UButton
              size="xs"
              color="error"
              variant="outline"
              :label="t('mcpSearch.retry')"
              :loading="refLoading"
              @click="loadReference"
            />
          </template>
        </UAlert>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField :label="t('mcpSearch.server')" :required="true" :error="errors.server_id || undefined">
            <USelect
              :model-value="form.server_id"
              :items="serverOptions"
              :placeholder="t('mcpSearch.selectServer')"
              :loading="refLoading && !refLoaded"
              class="w-full"
              @update:model-value="onServerChange"
            />
          </UFormField>
          <UFormField
            :label="t('mcpSearch.tool')"
            :required="true"
            :error="toolError || undefined"
            :help="toolHelp || undefined"
          >
            <USelect
              v-model="form.tool_name"
              :items="toolOptions"
              :placeholder="t('mcpSearch.selectTool')"
              :disabled="form.server_id === null"
              class="w-full"
              @update:model-value="errors.tool_name = ''"
            />
          </UFormField>
        </div>

        <div class="flex flex-col gap-2 rounded-md border border-(--ui-border) p-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
            <UFormField :label="t('mcpSearch.preset')" class="min-w-0 sm:flex-1">
              <USelect
                v-model="presetId"
                :items="presetOptions"
                :placeholder="t('mcpSearch.selectPreset')"
                :loading="refLoading && !refLoaded"
                class="w-full"
              />
            </UFormField>
            <UButton
              color="neutral"
              variant="outline"
              :label="t('mcpSearch.applyPreset')"
              :disabled="!presetId"
              @click="applySelectedPreset"
            />
          </div>
          <p v-if="form.preset_id" class="text-xs text-(--ui-text-muted)">
            {{ t('mcpSearch.preset') }}:
            {{ appliedPresetLabel }}
            <span v-if="form.preset_version">{{ t('mcpSearch.presetVersion', { version: form.preset_version }) }}</span>
          </p>
          <p v-if="showTavilyWarning" class="flex items-start gap-1.5 text-xs text-(--ui-warning)">
            <UIcon name="i-lucide-triangle-alert" class="mt-px size-3.5 shrink-0" />
            <span class="min-w-0">{{ t('mcpSearch.tavilyTextWarning') }}</span>
          </p>
        </div>

        <div class="flex min-w-0 flex-col gap-3 border-t border-(--ui-border) pt-4">
          <UFormField :label="t('mcpSearch.requestCode')" :error="errors.request_code || undefined">
            <UTextarea
              v-model="form.request_code"
              :rows="8"
              class="w-full font-mono text-sm"
              spellcheck="false"
              @update:model-value="errors.request_code = ''"
            />
          </UFormField>
          <UFormField :label="t('mcpSearch.sampleRequest')">
            <UTextarea
              v-model="form.sample_request"
              :rows="5"
              class="w-full font-mono text-sm"
              spellcheck="false"
              :placeholder="SAMPLE_REQUEST_PLACEHOLDER"
            />
          </UFormField>
          <div>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-eye"
              :label="t('mcpSearch.preview')"
              :loading="requestPreview.loading"
              @click="previewRequest"
            />
          </div>
          <UAlert
            v-if="requestPreview.error"
            color="error"
            variant="subtle"
            :title="t('mcpSearch.previewFailed')"
            :description="requestPreview.error"
          />
          <div v-else-if="requestPreview.output" class="flex min-w-0 flex-col gap-1">
            <span class="text-xs font-medium text-(--ui-text-muted)">{{ t('mcpSearch.requestOutput') }}</span>
            <pre
              class="max-h-48 min-w-0 max-w-full overflow-auto rounded-md bg-(--ui-bg-muted) p-2.5 font-mono text-xs leading-relaxed"
            >{{ requestPreview.output }}</pre>
          </div>
        </div>

        <div class="flex min-w-0 flex-col gap-3 border-t border-(--ui-border) pt-4">
          <UFormField :label="t('mcpSearch.responseCode')" :error="errors.response_code || undefined">
            <UTextarea
              v-model="form.response_code"
              :rows="8"
              class="w-full font-mono text-sm"
              spellcheck="false"
              @update:model-value="errors.response_code = ''"
            />
          </UFormField>
          <UFormField :label="t('mcpSearch.sampleResponse')">
            <UTextarea
              v-model="form.sample_response"
              :rows="5"
              class="w-full font-mono text-sm"
              spellcheck="false"
              :placeholder="SAMPLE_RESPONSE_PLACEHOLDER"
            />
          </UFormField>
          <div>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-eye"
              :label="t('mcpSearch.preview')"
              :loading="responsePreview.loading"
              @click="previewResponse"
            />
          </div>
          <UAlert
            v-if="responsePreview.error"
            color="error"
            variant="subtle"
            :title="t('mcpSearch.previewFailed')"
            :description="responsePreview.error"
          />
          <div v-else-if="responsePreview.output" class="flex min-w-0 flex-col gap-1">
            <span class="text-xs font-medium text-(--ui-text-muted)">{{ t('mcpSearch.responseOutput') }}</span>
            <pre
              class="max-h-48 min-w-0 max-w-full overflow-auto rounded-md bg-(--ui-bg-muted) p-2.5 font-mono text-xs leading-relaxed"
            >{{ responsePreview.output }}</pre>
          </div>
        </div>

        <UFormField v-if="props.upstream" :label="t('common.enabled')">
          <USwitch v-model="form.enabled" />
        </UFormField>
      </fieldset>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" :disabled="saving" @click="open = false" />
      <UButton :loading="saving" :label="t('common.save')" @click="submit" />
    </template>
  </UModal>

  <ConfirmModal
    v-model:open="showOverwrite"
    :title="t('mcpSearch.overwriteTitle')"
    :message="t('mcpSearch.overwriteDetail')"
    :confirm-label="t('mcpSearch.applyPreset')"
    @confirm="confirmOverwrite"
  />
</template>
