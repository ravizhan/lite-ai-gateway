<script setup lang="ts">
defineProps<{ runtime?: string | null; db?: string | null; version?: string | null }>()
</script>

<template>
  <UBadge v-if="runtime" color="primary" variant="subtle" icon="i-lucide-cpu">{{ runtime }}</UBadge>
  <UBadge v-if="db" color="neutral" variant="subtle" icon="i-lucide-database">
    {{ db }}<template v-if="version"> · v{{ version }}</template>
  </UBadge>
</template>
