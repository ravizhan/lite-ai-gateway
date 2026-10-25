<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api } from '../../lib/api'
import type {
  McpCapabilitiesResult,
  McpCapabilityKind,
  McpGroupCapabilitySelection,
  McpGroupWithCapabilities,
  McpServerCapabilities,
} from '../../../shared/api'
import { useI18n } from 'vue-i18n'

const toast = useToast()
const { t } = useI18n()

const KINDS: McpCapabilityKind[] = ['tool', 'prompt', 'resource']
const KIND_ICONS: Record<McpCapabilityKind, string> = {
  tool: 'i-lucide-wrench',
  prompt: 'i-lucide-message-square-text',
  resource: 'i-lucide-database',
}

const groups = ref<McpGroupWithCapabilities[]>([])
const capabilityServers = ref<McpServerCapabilities[]>([])
const selectedId = ref<number | null>(null)
const newName = ref('')
const creating = ref(false)
const saving = ref(false)
const loading = ref(false)
const capsLoading = ref(false)
const deleting = ref<McpGroupWithCapabilities | null>(null)
const deleteLoading = ref(false)
const showDelete = computed({
  get: () => deleting.value !== null,
  set: (v: boolean) => {
    if (!v) deleting.value = null
  },
})

const form = reactive({ name: '', description: '', selected: new Set<string>(), webSearch: false })
const nameError = ref('')
const expandedServers = ref<string[]>([])

const selected = computed(() => groups.value.find((g) => g.id === selectedId.value) ?? null)

function keyOf(serverId: number, kind: McpCapabilityKind, name: string) {
  return `${serverId}::${kind}::${name}`
}

watch(selected, (g) => {
  form.selected = new Set(g ? g.capabilities.map((c) => keyOf(c.server_id, c.kind, c.name)) : [])
  form.webSearch = g?.web_search === 1
  form.name = g?.name ?? ''
  form.description = g?.description ?? ''
  nameError.value = ''
})

function groupCount(g: McpGroupWithCapabilities) {
  return g.capabilities.length + (g.web_search === 1 ? 1 : 0)
}

const selectedCount = computed(() => form.selected.size + (form.webSearch ? 1 : 0))

const groupEndpoint = computed(() =>
  selected.value ? `${window.location.origin}/mcp/${encodeURIComponent(selected.value.name)}` : '',
)

function clearAll() {
  form.selected = new Set()
  form.webSearch = false
}

function capsOf(server: McpServerCapabilities, kind: McpCapabilityKind) {
  return server.capabilities.filter((c) => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name))
}

function serverKinds(server: McpServerCapabilities) {
  return KINDS.filter((k) => capsOf(server, k).length > 0)
}

function isChecked(serverId: number, kind: McpCapabilityKind, name: string) {
  return form.selected.has(keyOf(serverId, kind, name))
}

function toggle(serverId: number, kind: McpCapabilityKind, name: string, checked: boolean) {
  const k = keyOf(serverId, kind, name)
  if (checked) form.selected.add(k)
  else form.selected.delete(k)
}

function kindSelectedCount(server: McpServerCapabilities, kind: McpCapabilityKind) {
  return capsOf(server, kind).filter((c) => isChecked(server.server_id, kind, c.name)).length
}

function kindState(server: McpServerCapabilities, kind: McpCapabilityKind): boolean | 'indeterminate' {
  const all = capsOf(server, kind)
  const n = all.filter((c) => isChecked(server.server_id, kind, c.name)).length
  if (n === 0) return false
  if (n === all.length) return true
  return 'indeterminate'
}

function toggleKind(server: McpServerCapabilities, kind: McpCapabilityKind, checked: boolean) {
  for (const c of capsOf(server, kind)) toggle(server.server_id, kind, c.name, checked)
}

function serverSelectedCount(server: McpServerCapabilities) {
  return server.capabilities.filter((c) => isChecked(server.server_id, c.kind, c.name)).length
}

function serverState(server: McpServerCapabilities): boolean | 'indeterminate' {
  const n = serverSelectedCount(server)
  if (n === 0) return false
  if (n === server.capabilities.length) return true
  return 'indeterminate'
}

function toggleServer(server: McpServerCapabilities, checked: boolean) {
  for (const c of server.capabilities) toggle(server.server_id, c.kind, c.name, checked)
}

async function loadAll() {
  loading.value = true
  capsLoading.value = true
  try {
    const [g, caps] = await Promise.all([
      api<McpGroupWithCapabilities[]>('/api/admin/mcp/groups'),
      api<McpCapabilitiesResult>('/api/admin/mcp/capabilities'),
    ])
    groups.value = g
    capabilityServers.value = caps.servers
    if (selectedId.value && !g.some((x) => x.id === selectedId.value)) selectedId.value = null
  } finally {
    loading.value = false
    capsLoading.value = false
  }
}
onMounted(loadAll)

async function createGroup() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const created = await api<McpGroupWithCapabilities>('/api/admin/mcp/groups', {
      method: 'POST',
      body: { name: newName.value.trim() },
    })
    newName.value = ''
    toast.add({ title: t('mcpGroups.created'), color: 'success' })
    await loadAll()
    selectedId.value = created.id
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpGroups.createFailed'), color: 'error' })
  } finally {
    creating.value = false
  }
}

async function confirmDelete() {
  if (!deleting.value) return
  deleteLoading.value = true
  try {
    await api(`/api/admin/mcp/groups/${deleting.value.id}`, { method: 'DELETE' })
    toast.add({ title: t('mcpGroups.deleted'), color: 'success' })
    if (selectedId.value === deleting.value.id) selectedId.value = null
    deleting.value = null
    await loadAll()
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('common.deleteFailed'), color: 'error' })
  } finally {
    deleteLoading.value = false
  }
}

async function saveGroup() {
  if (!selected.value) return
  nameError.value = form.name.trim() ? '' : t('validation.nameRequired')
  if (nameError.value) return
  saving.value = true
  try {
    const capabilities: McpGroupCapabilitySelection[] = [...form.selected].map((k) => {
      const [serverId, kind, name] = k.split('::')
      return { server_id: Number(serverId), kind: kind as McpCapabilityKind, name }
    })
    await api(`/api/admin/mcp/groups/${selected.value.id}`, {
      method: 'PUT',
      body: { name: form.name.trim(), description: form.description, capabilities, web_search: form.webSearch ? 1 : 0 },
    })
    toast.add({ title: t('mcpGroups.saved'), color: 'success' })
    await loadAll()
  } catch (e) {
    toast.add({ title: e instanceof Error ? e.message : t('mcpGroups.saveFailed'), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <PageHeader :title="t('mcpGroups.title')" :description="t('mcpGroups.description')" />

  <div class="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
    <UCard :title="t('mcpGroups.groups')" :ui="{ body: 'flex flex-col gap-1' }">
      <template v-if="loading && !groups.length">
        <USkeleton v-for="i in 3" :key="i" class="h-8 w-full" />
      </template>
      <button
        v-for="g in groups"
        :key="g.id"
        type="button"
        class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors"
        :class="
          selectedId === g.id
            ? 'bg-(--ui-bg-elevated) font-medium text-(--ui-text-highlighted)'
            : 'text-(--ui-text) hover:bg-(--ui-bg-elevated)/60'
        "
        @click="selectedId = g.id"
      >
        <span class="min-w-0 truncate">{{ g.name }}</span>
        <span class="flex shrink-0 items-center gap-1">
          <UBadge color="neutral" variant="subtle" size="sm">{{ groupCount(g) }}</UBadge>
          <UTooltip :text="t('mcpGroups.deleteGroup')">
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="t('mcpGroups.deleteGroup')"
              @click.stop="deleting = g"
            />
          </UTooltip>
        </span>
      </button>
      <p v-if="!loading && !groups.length" class="py-4 text-center text-xs text-(--ui-text-muted)">{{ t('mcpGroups.noGroups') }}</p>
      <div class="mt-2 flex items-center gap-1.5 border-t border-(--ui-border) pt-3">
        <UInput v-model="newName" size="sm" :placeholder="t('mcpGroups.newGroupPlaceholder')" class="flex-1" @keyup.enter="createGroup" />
        <UButton size="sm" icon="i-lucide-plus" :aria-label="t('mcpGroups.createGroup')" :loading="creating" :disabled="!newName.trim()" @click="createGroup" />
      </div>
    </UCard>

    <UCard v-if="selected" :title="t('mcpGroups.editTitle', { name: selected.name })">
      <div class="flex flex-col gap-4">
        <UFormField :label="t('common.name')" :required="true" :error="nameError || undefined">
          <UInput v-model="form.name" class="w-full" />
        </UFormField>
        <UFormField :label="t('mcpGroups.descriptionLabel')">
          <UInput v-model="form.description" class="w-full" />
        </UFormField>

        <UFormField :label="t('mcpGroups.includedCapabilities')">
          <div class="flex flex-col gap-2 rounded-md border border-(--ui-border) p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-(--ui-text-muted)">{{ t('mcpGroups.selectedCount', { count: selectedCount }) }}</span>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-rotate-ccw"
                :label="t('mcpGroups.clearAll')"
                :disabled="!selectedCount"
                @click="clearAll"
              />
            </div>

            <UCheckbox
              v-model="form.webSearch"
              :label="t('mcpGroups.webSearch')"
              :description="t('mcpGroups.webSearchHelp')"
              class="rounded-md border border-(--ui-border) px-3 py-2.5"
            />

            <div v-if="capsLoading" class="flex flex-col gap-2">
              <USkeleton v-for="i in 3" :key="i" class="h-10 w-full" />
            </div>

            <p v-else-if="!capabilityServers.length" class="py-2 text-xs text-(--ui-text-muted)">{{ t('mcpGroups.noCapabilities') }}</p>

            <div v-for="server in capabilityServers" :key="server.server_id" class="rounded-md border border-(--ui-border)">
              <div class="flex items-center gap-2 px-3 py-2">
                <UCheckbox
                  :model-value="serverState(server)"
                  :aria-label="server.server_name"
                  @update:model-value="toggleServer(server, $event === true)"
                />
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  @click="expandedServers = expandedServers.includes(String(server.server_id)) ? expandedServers.filter((x) => x !== String(server.server_id)) : [...expandedServers, String(server.server_id)]"
                >
                  <span class="truncate text-sm font-medium text-(--ui-text-highlighted)">{{ server.server_name }}</span>
                  <UBadge color="neutral" variant="subtle" size="sm">{{ serverSelectedCount(server) }}/{{ server.counts.total }}</UBadge>
                  <UIcon
                    name="i-lucide-chevron-down"
                    class="ml-auto size-4 shrink-0 text-(--ui-text-muted) transition-transform"
                    :class="{ 'rotate-180': expandedServers.includes(String(server.server_id)) }"
                  />
                </button>
              </div>

              <div v-if="expandedServers.includes(String(server.server_id))" class="flex flex-col gap-3 border-t border-(--ui-border) px-3 py-3">
                <div v-for="kind in serverKinds(server)" :key="kind" class="flex flex-col gap-1.5">
                  <div class="flex items-center gap-2">
                    <UCheckbox
                      :model-value="kindState(server, kind)"
                      :aria-label="t(`mcpCapabilities.${kind}s`)"
                      @update:model-value="toggleKind(server, kind, $event === true)"
                    />
                    <UIcon :name="KIND_ICONS[kind]" class="size-4 text-(--ui-text-muted)" />
                    <span class="text-sm font-medium text-(--ui-text-highlighted)">{{ t(`mcpCapabilities.${kind}s`) }}</span>
                    <UBadge color="neutral" variant="subtle" size="sm">{{ kindSelectedCount(server, kind) }}/{{ capsOf(server, kind).length }}</UBadge>
                  </div>
                  <div class="ms-6 flex flex-col gap-1">
                    <UCheckbox
                      v-for="cap in capsOf(server, kind)"
                      :key="cap.name"
                      :model-value="isChecked(server.server_id, kind, cap.name)"
                      :label="cap.name"
                      @update:model-value="toggle(server.server_id, kind, cap.name, $event === true)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </UFormField>

        <div class="flex flex-col gap-1.5 rounded-md border border-(--ui-border) px-3 py-2.5">
          <span v-if="selected.web_search === 1" class="text-xs text-(--ui-text-muted)">{{ t('mcpGroups.webSearchEndpoint') }}</span>
          <div class="flex min-w-0 items-center gap-2">
            <code class="min-w-0 flex-1 break-all rounded bg-(--ui-bg-muted) px-2 py-1 font-mono text-xs text-(--ui-text)">{{ groupEndpoint }}</code>
            <CopyButton :text="groupEndpoint" />
          </div>
        </div>

        <div class="flex justify-end border-t border-(--ui-border) pt-4">
          <UButton :label="t('mcpGroups.saveGroup')" :loading="saving" @click="saveGroup" />
        </div>
      </div>
    </UCard>

    <UEmpty
      v-else
      icon="i-lucide-folder-open"
      :title="t('mcpGroups.noSelected')"
      :description="t('mcpGroups.noSelectedDesc')"
    />
  </div>

  <ConfirmModal
    v-model:open="showDelete"
    :title="t('mcpGroups.deleteTitle')"
    :name="deleting?.name"
    :detail="t('mcpGroups.deleteDetail')"
    :loading="deleteLoading"
    @confirm="confirmDelete"
  />
</template>
