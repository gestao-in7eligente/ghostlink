// Audio assets imported for their URL (electron-vite emits them next to index.html, served over app://).
declare module '*.mp3?url' {
  const url: string;
  export default url;
}
