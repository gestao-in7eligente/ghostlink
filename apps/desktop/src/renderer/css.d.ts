// CSS Modules: Vite turns `import ui from './x.module.css'` into a class-name map.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

// Plain stylesheets (and the @fontsource faces) are imported for their side effects only.
declare module '*.css';
