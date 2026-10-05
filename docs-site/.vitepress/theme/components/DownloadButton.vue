<script setup lang="ts">
// The Windows download button (spec §16). By default it asks the GitHub API for the latest
// release when the page opens; with `lazy` (the /j/ invite page) it only asks once the visitor
// clicks it. Whatever goes wrong, the link falls back to the latest release page.
import { useData } from 'vitepress';
import { computed, onMounted, ref, useId } from 'vue';
import type { VisitorPlatform, WindowsDownload } from '../lib/download.js';
import { LATEST_RELEASE_PAGE_URL, fetchLatestWindowsDownload, isWindowsVisitor } from '../lib/download.js';
import { fill, stringsFor } from '../lib/strings.js';

const props = withDefaults(defineProps<{ lazy?: boolean; lang?: string }>(), { lazy: false, lang: undefined });

const { lang: pageLang } = useData();
const locale = computed(() => props.lang ?? pageLang.value);
const t = computed(() => stringsFor(locale.value).download);

const state = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
const download = ref<WindowsDownload | null>(null);
const otherOs = ref(false);
const detailId = useId();
const href = computed(() => download.value?.url ?? LATEST_RELEASE_PAGE_URL);

const detail = computed(() => {
  if (state.value === 'loading') return t.value.checking;
  const parts = [t.value.requirements];
  const d = download.value;
  if (d) {
    parts.unshift(fill(t.value.version, { version: d.version }));
    if (d.size !== null) {
      const mb = new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }).format(d.size / 1_000_000);
      parts.push(fill(t.value.size, { size: mb }));
    }
  }
  return parts.join(' · ');
});

async function lookUp(): Promise<void> {
  state.value = 'loading';
  download.value = await fetchLatestWindowsDownload();
  state.value = download.value ? 'ready' : 'failed';
}

onMounted(() => {
  otherOs.value = !isWindowsVisitor(navigator as unknown as VisitorPlatform);
  if (!props.lazy) void lookUp();
});

async function onClick(event: MouseEvent): Promise<void> {
  // A plain click on a lazy button looks the installer up first; modified clicks (new tab) keep the release page.
  if (!props.lazy || download.value || state.value === 'loading') return;
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  await lookUp();
  window.location.assign(href.value);
}
</script>

<template>
  <div class="gl-download">
    <a
      class="gl-button gl-button--primary gl-download__button"
      :href="href"
      :aria-busy="state === 'loading'"
      :aria-describedby="detailId"
      @click="onClick"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      <span>{{ t.button }}</span>
    </a>
    <p :id="detailId" class="gl-download__detail" aria-live="polite">{{ detail }}</p>
    <p v-if="state === 'failed'" class="gl-download__note">{{ t.failed }}</p>
    <p v-if="otherOs" class="gl-download__note">{{ t.notWindows }}</p>
  </div>
</template>

<style scoped>
.gl-download {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 16px 0 24px;
}

.gl-download__button {
  min-height: 48px;
  padding: 10px 22px;
  font-size: 16px;
}

.gl-download__detail {
  margin: 0 !important;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 20px;
}

.gl-download__note {
  margin: 4px 0 0 !important;
  max-width: 560px;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 22px;
}
</style>
