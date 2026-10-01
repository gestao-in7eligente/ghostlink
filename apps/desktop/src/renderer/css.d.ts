// CSS Modules: Vite turns `import ui from './x.module.css'` into a class-name map.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

// Plain stylesheets (and the @fontsource faces) are imported for their side effects only.
declare module '*.css';

// `import url from 'x?url'`: Vite copies the file into the build's assets and gives its URL
// (the noise suppressors' worklets and WebAssembly, served by app://ghostlink like the rest).
declare module '*?url' {
  const url: string;
  export default url;
}
