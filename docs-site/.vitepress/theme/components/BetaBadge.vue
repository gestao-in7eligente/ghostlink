<script setup lang="ts">
import { useData } from 'vitepress';
import { computed } from 'vue';
import { stringsFor } from '../lib/strings.js';

const { lang } = useData();
const t = computed(() => stringsFor(lang.value).beta);
</script>

<template>
  <p class="gl-beta"><span class="gl-beta__pill">beta</span>{{ t }}</p>
</template>

<style scoped>
.gl-beta {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 18px;
  padding: 4px 12px 4px 4px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 20px;
}

.gl-beta__pill {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--gl-blurple);
  color: var(--gl-on-blurple);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
