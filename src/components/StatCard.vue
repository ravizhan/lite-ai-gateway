<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; icon?: string }>()
</script>

<template>
  <UCard :ui="{ body: 'sm:p-4' }">
    <div class="flex items-center justify-between gap-2">
      <span class="truncate text-xs font-medium tracking-wide text-(--ui-text-muted) uppercase">{{ label }}</span>
      <UIcon v-if="icon" :name="icon" class="size-4 shrink-0 text-(--ui-text-dimmed)" />
    </div>
    <div class="mt-2 truncate text-2xl font-semibold tabular-nums text-(--ui-text-highlighted)">{{ value }}</div>
    <div v-if="hint" class="mt-1 truncate text-xs text-(--ui-text-dimmed)">{{ hint }}</div>
  </UCard>
</template>
