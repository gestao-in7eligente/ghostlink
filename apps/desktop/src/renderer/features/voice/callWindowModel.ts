// The call's mini window while I share my screen (spec 2026-10-02-janelinha-da-chamada-design.md),
// its rule without React or the DOM: when the window is open (with the share, until ✕, back on the
// next share). The video area shows my shared screen (CallWindow.tsx).

/** What opening and closing the window does (CallWindow.tsx: the popup and its portal). */
export interface CallWindowOps {
  /** Opens it; false when it could not open (main refused it). */
  open(): boolean;
  close(): void;
}

/**
 * When the mini window is open: while my share is live, from its start to its end (stopped by any
 * path, or the call ended). ✕ closes it until the next share; so does closing it by other means
 * (Alt+F4), and a refused window is not asked for again during the same share.
 */
export class CallWindowLifecycle {
  readonly #ops: CallWindowOps;
  #live = false;
  #dismissed = false;
  #open = false;
  #disposed = false;

  constructor(ops: CallWindowOps) {
    this.#ops = ops;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Whether my share is live; a share that ends lets the next one open the window again. */
  update(live: boolean): void {
    if (!live) this.#dismissed = false;
    this.#live = live;
    this.#apply();
  }

  /** ✕: closed until the next share (the share goes on). */
  dismiss(): void {
    this.#dismissed = true;
    this.#apply();
  }

  /** The window went away by itself (Alt+F4, the system): as ✕. */
  gone(): void {
    if (!this.#open) return;
    this.#dismissed = true;
    this.#open = false;
    this.#ops.close();
  }

  /** The page goes (or the host unmounts): closed for good. */
  dispose(): void {
    this.#disposed = true;
    this.#apply();
  }

  #apply(): void {
    const wanted = this.#live && !this.#dismissed && !this.#disposed;
    if (wanted === this.#open) return;
    if (!wanted) {
      this.#open = false;
      this.#ops.close();
      return;
    }
    this.#open = this.#ops.open();
    if (!this.#open) this.#dismissed = true;
  }
}
