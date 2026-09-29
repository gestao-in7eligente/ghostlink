import ui from './ui.module.css';

/**
 * The ghost of the app icon (apps/desktop/build/icon.svg, 1024×1024 canvas).
 * scripts/test/icon.test.ts checks that both drawings use the same path and eyes.
 */
export const GHOST_PATH =
  'M252 742V456A260 260 0 0 1 772 456V742A86.67 86.67 0 0 1 598.67 742A86.67 86.67 0 0 1 425.33 742A86.67 86.67 0 0 1 252 742Z';

/** The app icon as an inline brand mark: white ghost on an accent-colored rounded tile. */
export function GhostMark({ size = 20 }: { size?: number }) {
  return (
    // The viewBox is cropped to the tile, so the small mark has no transparent margin.
    <svg className={ui.logo} width={size} height={size} viewBox="64 64 896 896" aria-hidden="true" focusable="false">
      <rect className={ui.logoTile} x="64" y="64" width="896" height="896" rx="200" />
      <path d={GHOST_PATH} fill="#ffffff" />
      <ellipse cx="406" cy="480" rx="46" ry="64" fill="#1e1f22" />
      <ellipse cx="618" cy="480" rx="46" ry="64" fill="#1e1f22" />
    </svg>
  );
}
