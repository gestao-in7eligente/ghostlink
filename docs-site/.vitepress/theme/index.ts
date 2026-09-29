import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import BetaBadge from './components/BetaBadge.vue';
import './style.css';

// The default theme in GhostLink colors, plus the "beta" label above the home hero (spec §11:
// visible while the version is 0.x). Page components (download button, invite) are imported by
// the pages that use them, so the rest of the site does not carry their code.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-info-before': () => h(BetaBadge) }),
} satisfies Theme;
