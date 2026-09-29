// Vite resolves these imports; tsc only needs to know they exist. (.vue files are compiled by
// VitePress, not typechecked here; their logic lives in theme/lib/*.ts, which is.)
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}

declare module '*.css';
