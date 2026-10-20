<template>
  <main class="not-found">
    <h1>找不到这个页面</h1>
    <p><RouterLink to="/">回到首页</RouterLink></p>
  </main>
</template>

<style scoped>
.not-found {
  padding: var(--space-48) var(--space-24);
}
h1 {
  font-family: var(--font-title);
  font-weight: 400;
  margin-bottom: var(--space-12);
}
a {
  color: var(--accent);
}
</style>
