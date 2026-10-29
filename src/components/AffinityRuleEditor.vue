<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AffinityRule } from '../../shared/api'
import AffinitySourceEditor from '@/components/AffinitySourceEditor.vue'

const rule = defineModel<AffinityRule>('rule', { required: true })
/** draggableDisabled 仅用于保存期间禁用来源列表的拖拽（原生控件由外层 fieldset 统一禁用） */
const props = withDefaults(defineProps<{ index: number; total: number; draggableDisabled?: boolean }>(), {
  draggableDisabled: false,
})
const emit = defineEmits<{
  remove: []
  move: [direction: 'up' | 'down']
}>()
const { t } = useI18n()

function ruleLabel() {
  return rule.value.name || t('settings.rules.rule.unnamed')
}
</script>

<template>
  <section class="rounded-lg border border-(--ui-border) bg-(--ui-bg-muted)/20">
    <div class="flex flex-wrap items-end gap-3 border-b border-(--ui-border) p-4">
      <div class="flex shrink-0 items-center gap-2 self-center">
        <UIcon
          name="i-lucide-grip-vertical"
          class="rule-drag-handle size-4 cursor-grab text-(--ui-text-dimmed) active:cursor-grabbing"
          :aria-label="t('settings.rules.rule.dragHandle')"
        />
        <UBadge color="neutral" variant="subtle" class="tabular-nums">#{{ props.index + 1 }}</UBadge>
      </div>

      <UFormField :label="t('settings.rules.rule.name')" :required="true" class="min-w-48 flex-1">
        <UInput v-model="rule.name" :placeholder="t('settings.rules.rule.namePlaceholder')" class="w-full" />
      </UFormField>

      <UFormField :label="t('settings.rules.rule.enabled')" class="shrink-0">
        <USwitch v-model="rule.enabled" :aria-label="t('settings.rules.rule.toggleEnabled', { name: ruleLabel() })" />
      </UFormField>

      <div class="flex flex-wrap items-center gap-1">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="props.index === 0"
          :label="t('settings.rules.rule.moveUp')"
          @click="emit('move', 'up')"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :disabled="props.index === props.total - 1"
          :label="t('settings.rules.rule.moveDown')"
          @click="emit('move', 'down')"
        />
        <UButton
          size="xs"
          color="error"
          variant="ghost"
          :label="t('settings.rules.rule.remove')"
          @click="emit('remove')"
        />
      </div>
    </div>

    <div class="flex flex-col gap-5 p-4">
      <div>
        <h3 class="text-sm font-medium text-(--ui-text-highlighted)">{{ t('settings.rules.rule.matchTitle') }}</h3>
        <p class="mt-1 text-sm text-(--ui-text-muted)">{{ t('settings.rules.rule.matchDescription') }}</p>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UFormField :label="t('settings.rules.rule.modelPattern')" :help="t('settings.rules.rule.modelPatternHelp')">
          <UInput
            v-model="rule.modelPattern"
            class="w-full font-mono text-sm"
            :placeholder="t('settings.rules.rule.matchAllPlaceholder')"
          />
        </UFormField>
        <UFormField :label="t('settings.rules.rule.pathPattern')" :help="t('settings.rules.rule.pathPatternHelp')">
          <UInput
            v-model="rule.pathPattern"
            class="w-full font-mono text-sm"
            :placeholder="t('settings.rules.rule.matchAllPlaceholder')"
          />
        </UFormField>
        <UFormField :label="t('settings.rules.rule.userAgent')" :help="t('settings.rules.rule.userAgentHelp')">
          <UInput
            v-model="rule.userAgent"
            class="w-full"
            :placeholder="t('settings.rules.rule.matchAllPlaceholder')"
          />
        </UFormField>
        <UFormField :label="t('settings.rules.rule.valuePattern')" :help="t('settings.rules.rule.valuePatternHelp')">
          <UInput
            v-model="rule.valuePattern"
            class="w-full font-mono text-sm"
            :placeholder="t('settings.rules.rule.matchAllPlaceholder')"
          />
        </UFormField>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <UFormField :label="t('settings.rules.rule.ttl')" :help="t('settings.rules.rule.ttlHelp')">
          <div class="flex items-center gap-2">
            <UInput v-model.number="rule.ttlSeconds" type="number" min="0" step="1" class="w-full" />
            <span class="shrink-0 text-sm text-(--ui-text-muted)">{{ t('settings.affinity.seconds') }}</span>
          </div>
        </UFormField>
      </div>

      <div class="border-t border-(--ui-border) pt-5">
        <h3 class="text-sm font-medium text-(--ui-text-highlighted)">{{ t('settings.rules.rule.sourcesTitle') }}</h3>
        <p class="mt-1 text-sm text-(--ui-text-muted)">{{ t('settings.rules.rule.sourcesDescription') }}</p>
        <div class="mt-4">
          <AffinitySourceEditor v-model="rule.keySources" :draggable-disabled="props.draggableDisabled" />
        </div>
      </div>
    </div>
  </section>
</template>
