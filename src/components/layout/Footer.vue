<script setup>
const year = new Date().getFullYear()
</script>
<template>
  <footer class="site-footer"><small>© {{ year }} timeStarry · Markr</small></footer>
</template>
<style scoped>
.site-footer{max-width:1600px;width:100%;margin:auto;padding:32px var(--markr-page-gutter);color:var(--markr-muted)}
.site-footer small{font-size:12px}
</style>
