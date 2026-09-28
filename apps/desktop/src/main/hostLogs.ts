/** spec §9: the Host panel shows the last 500 lines of the hosted server's output. */
export const HOST_LOG_LINES = 500;
const MAX_LINE_LENGTH = 2_000;

/**
 * A bounded list of log lines. `write` accepts raw stream chunks: a line split
 * across two chunks is joined, and `\r\n` / `\r` count as line ends.
 */
export class LineRing {
  readonly #max: number;
  #lines: string[] = [];
  #partial = '';

  constructor(max = HOST_LOG_LINES) {
    this.#max = max;
  }

  push(line: string): void {
    this.#lines.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line);
    if (this.#lines.length > this.#max) this.#lines.splice(0, this.#lines.length - this.#max);
  }

  write(chunk: string): void {
    const parts = (this.#partial + chunk).split(/\r\n|\r|\n/);
    this.#partial = parts.pop() ?? '';
    if (this.#partial.length > MAX_LINE_LENGTH) {
      this.push(this.#partial);
      this.#partial = '';
    }
    for (const line of parts) if (line !== '') this.push(line);
  }

  lines(): string[] {
    return this.#partial === '' ? [...this.#lines] : [...this.#lines, this.#partial].slice(-this.#max);
  }
}
