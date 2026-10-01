// The stage's tile grid, like Discord's call screen: every tile 16:9, as large as the stage
// allows, in the column count that gives the largest tiles, centred. Pure (no DOM): the
// stage measures itself (VoiceStage's useTileLayout).

export const TILE_GAP = 8;
const RATIO = 16 / 9;
/** Below this width tiles stop shrinking and the stage scrolls instead. */
export const MIN_TILE_WIDTH = 160;

export interface TileLayout {
  columns: number;
  /** Tile width in whole pixels (its height follows from 16:9). */
  width: number;
}

/** The column count giving the largest 16:9 tiles for `count` tiles in a `width`×`height` box. */
export function fitTiles(count: number, width: number, height: number, gap = TILE_GAP): TileLayout {
  const n = Math.max(1, count);
  if (width <= 0 || height <= 0) return { columns: 1, width: 0 };
  let best: TileLayout = { columns: 1, width: 0 };
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const byWidth = (width - (columns - 1) * gap) / columns;
    const byHeight = ((height - (rows - 1) * gap) / rows) * RATIO;
    const w = Math.floor(Math.min(byWidth, byHeight));
    if (w > best.width) best = { columns, width: w };
  }
  if (best.width >= MIN_TILE_WIDTH) return best;
  // Too many to fit: as many minimum-width columns as the width takes, and the stage scrolls.
  const columns = Math.max(1, Math.min(n, Math.floor((width + gap) / (MIN_TILE_WIDTH + gap))));
  return { columns, width: Math.max(0, Math.floor((width - (columns - 1) * gap) / columns)) };
}
