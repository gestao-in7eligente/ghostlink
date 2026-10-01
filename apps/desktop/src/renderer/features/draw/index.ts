// The pencil on shared screens (spec 2026-10-01-lapis-na-tela-design.md). The voice UI plugs in:
//   - DrawLayer({ sharerId }) inside a stream's box (after the video and label, before its bar);
//   - PencilButton({ sharerId }) in a stream's bar, OwnTilePencil({ userId }) on my own tile;
//   - OwnShareDrawControls() in the LIVE part of the voice panel, and useDrawRuntime() in the panel
//     so "Permitir desenhos" events are followed for the whole call.
export { DrawLayer } from './DrawLayer.js';
export { OwnShareDrawControls, OwnTilePencil, PencilButton } from './DrawControls.js';
export { setAllowDrawing, setPencil, useDrawRuntime } from './runtime.js';
export { useDrawStore } from './state.js';
