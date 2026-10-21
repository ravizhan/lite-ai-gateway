<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { api } from '../lib/api'
import type { McpServerRow, McpServerType } from '../../shared/api'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ server?: McpServerRow | null }>()
const emit = defineEmits<{ saved: [] }>()
const open = defineModel<boolean>('open', { default: false })

const toast = useToast()
const { t } = useI18n()
const saving = ref(false)
const form = reactive({
  name: '',
  type: 'stdio' as McpServerType,
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  enabled: true,
})
const errors = reactive({ name: '', command: '', args: '', env: '', url: '', headers: '' })

const typeOptions = [
  { label: 'stdio', value: 'stdio' },
  { label: 'sse', value: 'sse' },
  { label: 'streamable-http', value: 'streamable-http' },
]

const isStdio = computed(() => form.type === 'stdio')

watch(open, (v) => {
  if (!v) return
  form.name = props.server?.name ?? ''
  form.type = props.server?.type ?? 'stdio'
  form.command = props.server?.command ?? ''
  form.args = props.server?.args ?? ''
  form.env = props.server?.env ?? ''
  form.url = props.server?.url ?? ''
  form.headers = props.server?.headers ?? ''
  form.enabled = (props.server?.enabled ?? 1) === 1
  clearErrors()
})

function clearErrors() {
  errors.name = errors.command = errors.args = errors.env = errors.url = errors.headers = ''
}

function jsonError(value: string, kind: 'array' | 'object'): string {
  if (!value.trim()) return ''
  try {
    const parsed = JSON.parse(value)
    if (kind === 'array' && !Array.isArray(parsed)) return t('mcpServerForm.mustBeJsonArray')
    if (kind === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      return t('mcpServerForm.mustBeJsonObject')
    }
    return ''
  } catch {
    return t('mcpServerForm.invalidJson')
  }
}

function validate(): boolean {
  clearErrors()
  errors.name = form.name.trim() ? '' : t('validation.nameRequired')
  if (isStdio.value) {
    errors.command = form.command.trim() ? '' : t('mcpServerForm.commandRequired')
    errors.args = jsonError(form.args, 'array')
    errors.env = jsonError(form.env, 'object')
  } else {
    errors.url = form.url.trim() ? '' : t('mcpServerForm.urlRequired')
    errors.headers = jsonError(form.headers, 'object')
  }
  return !Object.values(errors).some(Boolean)
}

async function submit() {
  if (!validate()) return
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      type: form.type,
      command: isStdio.value ? form.command.trim() : null,
      args: isStdio.value ? form.args.trim() || null : null,
      env: isStdio.value ? form.env.trim() || null : null,
      url: isStdio.value ? null : form.url.trim(),
      headers: isStdio.value ? null : form.headers.trim() || null,
    }
    if (props.server) {
      body.enabled = form.enabled ? 1 : 0
      await api(`/api/admin/mcp/servers/${props.server.id}`, { method: 'PUT', body })
      toast.add({ title: t('mcpServerForm.updated'), color: 'success' })
    } else {
      await api('/api/admin/mcp/servers', { method: 'POST', body })
      toast.add({ title: t('mcpServerForm.created'), color: 'success' })
    }
    open.value = false
    emit('saved')
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpServerForm.saveFailed'), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="props.server ? t('mcpServerForm.editTitle') : t('mcpServerForm.addTitle')"
    :description="t('mcpServerForm.description')"
    :ui="{ footer: 'justify-end gap-2' }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField :label="t('common.name')" :required="true" :error="errors.name || undefined">
          <UInput v-model="form.name" placeholder="e.g. filesystem" class="w-full" />
        </UFormField>
        <UFormField :label="t('cols.type')" :required="true">
          <USelect v-model="form.type" :items="typeOptions" class="w-full" />
        </UFormField>
        <template v-if="isStdio">
          <UFormField :label="t('mcpServerForm.command')" :required="true" :error="errors.command || undefined">
            <UInput v-model="form.command" placeholder="e.g. npx" class="w-full" />
          </UFormField>
          <UFormField
            :label="t('mcpServerForm.arguments')"
            :help="t('mcpServerForm.argsHelp')"
            :error="errors.args || undefined"
          >
            <UTextarea v-model="form.args" :rows="3" placeholder="[]" class="w-full font-mono text-sm" />
          </UFormField>
          <UFormField :label="t('mcpServerForm.environment')" :help="t('mcpServerForm.envHelp')" :error="errors.env || undefined">
            <UTextarea v-model="form.env" :rows="3" placeholder="{}" class="w-full font-mono text-sm" />
          </UFormField>
        </template>
        <template v-else>
          <UFormField :label="t('mcpServerForm.url')" :required="true" :error="errors.url || undefined">
            <UInput v-model="form.url" placeholder="http://localhost:3000/mcp" class="w-full" />
          </UFormField>
          <UFormField :label="t('mcpServerForm.headers')" :help="t('mcpServerForm.headersHelp')" :error="errors.headers || undefined">
            <UTextarea v-model="form.headers" :rows="3" placeholder="{}" class="w-full font-mono text-sm" />
          </UFormField>
        </template>
        <UFormField v-if="props.server" :label="t('common.enabled')">
          <USwitch v-model="form.enabled" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :label="t('common.cancel')" @click="open = false" />
      <UButton :loading="saving" :label="t('common.save')" @click="submit" />
    </template>
  </UModal>
</template>
