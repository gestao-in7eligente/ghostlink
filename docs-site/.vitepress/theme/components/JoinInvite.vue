<script setup lang="ts">
// The /j/ invite page (spec §3.5). The invite is the #GL1-… fragment: it is read here, in the
// browser, and never sent anywhere. The page tries ghostlink://join?… and, if the app has not
// taken it after 1.5 s, shows the download and the GL1- code to paste after installing.
// No trackers, no external calls (the download button asks the GitHub API only when clicked).
import { useData, withBase } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import type { WebInvite } from '../lib/invite.js';
import { OPEN_APP_TIMEOUT_MS, canTryAppLinkOnLoad, inviteFromFragment } from '../lib/invite.js';
import { stringsFor } from '../lib/strings.js';
import DownloadButton from './DownloadButton.vue';

/** `autoLang`: follow the visitor's browser language (the root /j/ page, which every web invite opens). */
const props = withDefaults(defineProps<{ autoLang?: boolean }>(), { autoLang: false });

const { lang: pageLang } = useData();
const locale = ref(pageLang.value);
const t = computed(() => stringsFor(locale.value).invite);

const phase = ref<'reading' | 'invalid' | 'invite'>('reading');
const invite = ref<WebInvite | null>(null);
/** trying: waiting for the app · opened: the page lost focus, the app probably opened · offer: show the download. */
const app = ref<'trying' | 'opened' | 'offer'>('trying');
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
const codeBox = ref<HTMLTextAreaElement | null>(null);
const codeId = useId();

let leftPage = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const markLeft = () => {
  if (document.visibilityState === 'hidden') leftPage = true;
};
const onBlur = () => {
  leftPage = true;
};

onMounted(() => {
  if (props.autoLang) locale.value = navigator.language || pageLang.value;
  const found = inviteFromFragment(window.location.hash);
  if (!found) {
    phase.value = 'invalid';
    return;
  }
  invite.value = found;
  phase.value = 'invite';
  if (!canTryAppLinkOnLoad(navigator.userAgent)) {
    app.value = 'offer';
    return;
  }
  document.addEventListener('visibilitychange', markLeft);
  window.addEventListener('blur', onBlur);
  window.location.href = found.deepLink;
  timer = setTimeout(() => {
    app.value = leftPage ? 'opened' : 'offer';
  }, OPEN_APP_TIMEOUT_MS);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  document.removeEventListener('visibilitychange', markLeft);
  window.removeEventListener('blur', onBlur);
});

async function copyCode(): Promise<void> {
  if (!invite.value) return;
  try {
    await navigator.clipboard.writeText(invite.value.pasteCode);
    copyState.value = 'copied';
  } catch {
    codeBox.value?.focus();
    codeBox.value?.select();
    copyState.value = 'failed';
  }
}
</script>

<template>
  <section class="gl-invite" :lang="locale">
    <div class="gl-card gl-invite__card">
      <img class="gl-invite__logo" :src="withBase('/logo.svg')" alt="" width="56" height="56" />

      <template v-if="phase === 'reading'">
        <h1 class="gl-invite__title">{{ t.reading }}</h1>
      </template>

      <template v-else-if="phase === 'invalid'">
        <h1 class="gl-invite__title">{{ t.invalidTitle }}</h1>
        <p class="gl-muted">{{ t.invalidBody }}</p>
        <DownloadButton lazy :lang="locale" />
        <p class="gl-invite__small">
          <a :href="withBase(t.guideLink)">{{ t.guide }}</a>
        </p>
      </template>

      <template v-else-if="invite">
        <p class="gl-invite__eyebrow">{{ t.invitedTo }}</p>
        <h1 class="gl-invite__title">{{ invite.name ?? t.unnamed }}</h1>
        <p class="gl-muted" aria-live="polite">
          {{ app === 'opened' ? t.opened : app === 'trying' ? t.opening : t.manual }}
        </p>
        <div class="gl-invite__actions">
          <a class="gl-button gl-button--primary" :href="invite.deepLink">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
            {{ t.openApp }}
          </a>
          <button v-if="app === 'opened'" type="button" class="gl-button gl-button--secondary" @click="app = 'offer'">
            {{ t.notOpened }}
          </button>
        </div>

        <div v-if="app === 'offer'" class="gl-invite__fallback">
          <h2 class="gl-invite__subtitle">{{ t.noAppTitle }}</h2>
          <ol class="gl-invite__steps">
            <li>
              <p>{{ t.step1 }}</p>
              <DownloadButton lazy :lang="locale" />
            </li>
            <li>
              <p><label :for="codeId">{{ t.step2 }}</label></p>
              <textarea
                :id="codeId"
                ref="codeBox"
                class="gl-invite__code"
                readonly
                rows="3"
                spellcheck="false"
                autocomplete="off"
                :value="invite.pasteCode"
                @focus="($event.target as HTMLTextAreaElement).select()"
              ></textarea>
              <div class="gl-invite__copy">
                <button type="button" class="gl-button gl-button--secondary" @click="copyCode">
                  {{ copyState === 'copied' ? t.copied : t.copy }}
                </button>
                <span class="gl-invite__small" aria-live="polite">{{ copyState === 'failed' ? t.copyFailed : '' }}</span>
              </div>
            </li>
          </ol>
          <details class="gl-invite__details">
            <summary>{{ t.addresses }}</summary>
            <ul>
              <li v-for="address in invite.addresses" :key="address"><code>{{ address }}</code></li>
            </ul>
          </details>
        </div>

        <p class="gl-invite__small gl-invite__privacy">{{ t.privacy }}</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.gl-invite {
  display: flex;
  justify-content: center;
  padding: 24px 0 48px;
}

.gl-invite__card {
  width: 100%;
  max-width: 560px;
  padding: 32px;
}

@media (max-width: 480px) {
  .gl-invite__card {
    padding: 20px;
  }
}

.gl-invite__logo {
  display: block;
  width: 56px;
  height: 56px;
  margin-bottom: 20px;
  border-radius: 14px;
}

.gl-invite__eyebrow {
  margin: 0 !important;
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.gl-invite__title {
  margin: 4px 0 8px;
  font-size: 28px;
  line-height: 36px;
  font-weight: 700;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.gl-invite__subtitle {
  margin: 0 0 8px;
  padding: 0;
  border: 0;
  font-size: 18px;
  line-height: 28px;
  font-weight: 600;
}

.gl-invite__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 0;
}

.gl-invite__fallback {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid var(--vp-c-divider);
}

.gl-invite__steps {
  margin: 0;
  padding-left: 20px;
}

.gl-invite__steps > li + li {
  margin-top: 8px;
}

.gl-invite__steps p {
  margin: 0 0 4px;
}

.gl-invite__code {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--gl-radius-sm);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 20px;
  word-break: break-all;
  resize: none;
}

.gl-invite__code:focus-visible {
  outline: 2px solid var(--gl-blurple);
  outline-offset: 1px;
}

.gl-invite__copy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.gl-invite__details {
  margin-top: 20px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.gl-invite__details summary {
  cursor: pointer;
}

.gl-invite__details ul {
  margin: 8px 0 0;
}

.gl-invite__small {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 20px;
}

.gl-invite__privacy {
  margin-top: 24px !important;
}
</style>
