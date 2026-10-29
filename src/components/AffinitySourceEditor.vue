<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { VueDraggable } from 'vue-draggable-plus'
import type { AffinityKeySource, AffinityKeySourceType } from '../../shared/api'

const sources = defineModel<AffinityKeySource[]>({ required: true })
/** draggableDisabled 仅用于保存期间禁用拖拽（原生控件由外层 fieldset 统一禁用） */
const props = withDefaults(defineProps<{ draggableDisabled?: boolean }>(), { draggableDisabled: false })
const { t } = useI18n()

const sourceTypeOptions = computed(() => [
  { label: t('settings.rules.rule.sourceHeader'), value: 'header' as AffinityKeySourceType },
  { label: t('settings.rules.rule.sourceBody'), value: 'body' as AffinityKeySourceType },
  { label: t('settings.rules.rule.sourceDerived'), value: 'derived' as AffinityKeySourceType },
])

const newSourceType = ref<AffinityKeySourceType>('header')
const newSourceKey = ref('')
const sourceIds = new WeakMap<AffinityKeySource, string>()
let sourceIdCounter = 0

function sourceId(source: AffinityKeySource) {
  const existing = sourceIds.get(source)
  if (existing) return existing
  const id = `source-${++sourceIdCounter}`
  sourceIds.set(source, id)
  return id
}

function addSource() {
  const key = newSourceType.value === 'derived' ? '' : newSourceKey.value.trim()
  if (newSourceType.value !== 'derived' && !key) return
  sources.value.push({ type: newSourceType.value, key })
  newSourceKey.value = ''
  if (newSourceType.value === 'header') newSourceType.value = 'body'
  else if (newSourceType.value === 'body') newSourceType.value = 'derived'
}

function removeSource(index: number) {
  sources.value.splice(index, 1)
}

function moveSource(index: number, direction: 'up' | 'down') {
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= sources.value.length) return
  const [source] = sources.value.splice(index, 1)
  if (source) sources.value.splice(nextIndex, 0, source)
}

function onTypeChange(source: AffinityKeySource) {
  if (source.type === 'derived') source.key = ''
}

function onNewSourceTypeChange() {
  newSourceKey.value = ''
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <VueDraggable
      v-if="sources.length"
      v-model="sources"
      handle=".source-drag-handle"
      :animation="150"
      :disabled="props.draggableDisabled"
      class="flex flex-col gap-3"
    >
      <div
        v-for="(source, index) in sources"
        :key="sourceId(source)"
        class="flex flex-col gap-3 rounded-md border border-(--ui-border) bg-(--ui-bg-elevated) p-3 lg:flex-row lg:items-end"
      >
        <div class="flex shrink-0 items-center gap-2 lg:self-center">
          <UIcon
            name="i-lucide-grip-vertical"
            class="source-drag-handle size-4 cursor-grab text-(--ui-text-dimmed) active:cursor-grabbing"
            :aria-label="t('settings.rules.rule.sourceDragHandle')"
          />
          <UBadge color="neutral" variant="subtle" class="tabular-nums">#{{ index + 1 }}</UBadge>
        </div>

        <UFormField :label="t('settings.rules.rule.sourceType')" class="w-full lg:min-w-0 lg:flex-1">
          <USelect
            v-model="source.type"
            :items="sourceTypeOptions"
            class="w-full"
            @update:model-value="onTypeChange(source)"
          />
        </UFormField>

        <UFormField
          v-if="source.type !== 'derived'"
          :label="t('settings.rules.rule.sourceKey')"
          class="w-full lg:min-w-0 lg:flex-[2]"
        >
          <UInput
            v-model="source.key"
            class="w-full font-mono text-sm"
            :placeholder="t('settings.rules.rule.sourceKeyPlaceholder')"
          />
        </UFormField>
        <div v-else class="w-full pb-1 text-sm text-(--ui-text-muted) lg:min-w-0 lg:flex-[2]">
          {{ t('settings.rules.rule.derivedKey') }}
        </div>

        <div class="flex flex-wrap items-center justify-end gap-1 lg:shrink-0">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :disabled="index === 0"
            :label="t('settings.rules.rule.moveUp')"
            @click="moveSource(index, 'up')"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :disabled="index === sources.length - 1"
            :label="t('settings.rules.rule.moveDown')"
            @click="moveSource(index, 'down')"
          />
          <UButton
            size="xs"
            color="error"
            variant="ghost"
            :label="t('settings.rules.rule.removeSource')"
            @click="removeSource(index)"
          />
        </div>
      </div>
    </VueDraggable>

    <p v-else class="rounded-md border border-dashed border-(--ui-border) px-3 py-4 text-sm text-(--ui-text-muted)">
      {{ t('settings.rules.rule.noSources') }}
    </p>

    <div class="flex flex-col gap-2 lg:flex-row lg:items-end">
      <UFormField :label="t('settings.rules.rule.sourceType')" class="w-full lg:w-52">
        <USelect
          v-model="newSourceType"
          :items="sourceTypeOptions"
          class="w-full"
          @update:model-value="onNewSourceTypeChange"
        />
      </UFormField>
      <UFormField
        v-if="newSourceType !== 'derived'"
        :label="t('settings.rules.rule.sourceKey')"
        class="w-full lg:min-w-0 lg:flex-1"
      >
        <UInput v-model="newSourceKey" class="w-full font-mono text-sm" :placeholder="t('settings.rules.rule.sourceKeyPlaceholder')" />
      </UFormField>
      <UButton
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        :label="t('settings.rules.rule.addSource')"
        :disabled="newSourceType !== 'derived' && !newSourceKey.trim()"
        @click="addSource"
      />
    </div>
  </div>
</template>
