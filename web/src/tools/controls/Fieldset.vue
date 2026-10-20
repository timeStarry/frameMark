<script setup lang="ts">
defineProps<{ legend: string }>()
</script>

<template>
  <fieldset>
    <legend>{{ legend }}</legend>
    <div class="body"><slot /></div>
  </fieldset>
</template>

<style scoped>
fieldset { border: 0; border-top: 1px solid var(--line); padding: var(--space-16) 0 0; margin: var(--space-16) 0 0; }
legend { padding-right: var(--space-12); color: var(--fg-muted); }
.body { display: flex; flex-direction: column; gap: var(--space-12); }
</style>
