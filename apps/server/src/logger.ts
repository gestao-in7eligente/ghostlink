export interface Logger {
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

function line(level: string, msg: string, meta?: object): string {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
  return `${new Date().toISOString()} ${level} ${msg}${suffix}`;
}

/** Default logger. Never pass message content, tokens or secrets in `meta` (spec §7). */
export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(line('info', msg, meta)),
  warn: (msg, meta) => console.warn(line('warn', msg, meta)),
  error: (msg, meta) => console.error(line('error', msg, meta)),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
