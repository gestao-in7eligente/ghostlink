/** The server image Railway pulls; its tag is the app's version, so app and server match. */
export const RAILWAY_IMAGE_REPOSITORY = 'ghcr.io/gestao-in7eligente/ghostlink-server';

export interface RailwayImageOptions {
  /** app.getVersion(), e.g. "0.2.0". */
  version: string;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

/** The image for a new server. Development only (never packaged): GHOSTLINK_RAILWAY_IMAGE overrides it. */
export function railwayImage(opts: RailwayImageOptions): string {
  const override = opts.packaged ? undefined : opts.env.GHOSTLINK_RAILWAY_IMAGE?.trim();
  return override || `${RAILWAY_IMAGE_REPOSITORY}:${opts.version}`;
}
