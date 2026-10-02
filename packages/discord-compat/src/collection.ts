/**
 * discord.js's Collection (@discordjs/collection): a Map with array-like helpers. The common
 * ones, with the same names and results.
 */
export class Collection<K, V> extends Map<K, V> {
  first(): V | undefined;
  first(amount: number): V[];
  first(amount?: number): V | V[] | undefined {
    const values = [...this.values()];
    if (amount === undefined) return values[0];
    return amount < 0 ? values.slice(amount) : values.slice(0, amount);
  }

  firstKey(): K | undefined {
    return this.keys().next().value;
  }

  last(): V | undefined;
  last(amount: number): V[];
  last(amount?: number): V | V[] | undefined {
    const values = [...this.values()];
    if (amount === undefined) return values.at(-1);
    if (amount === 0) return [];
    return amount < 0 ? values.slice(0, -amount) : values.slice(-amount);
  }

  lastKey(): K | undefined {
    return [...this.keys()].at(-1);
  }

  at(index: number): V | undefined {
    return [...this.values()].at(Math.trunc(index));
  }

  keyAt(index: number): K | undefined {
    return [...this.keys()].at(Math.trunc(index));
  }

  random(): V | undefined {
    const values = [...this.values()];
    return values[Math.floor(Math.random() * values.length)];
  }

  find(fn: (value: V, key: K, collection: this) => unknown): V | undefined {
    for (const [key, value] of this) if (fn(value, key, this)) return value;
    return undefined;
  }

  findKey(fn: (value: V, key: K, collection: this) => unknown): K | undefined {
    for (const [key, value] of this) if (fn(value, key, this)) return key;
    return undefined;
  }

  filter(fn: (value: V, key: K, collection: this) => unknown): Collection<K, V> {
    const out = new Collection<K, V>();
    for (const [key, value] of this) if (fn(value, key, this)) out.set(key, value);
    return out;
  }

  partition(fn: (value: V, key: K, collection: this) => unknown): [Collection<K, V>, Collection<K, V>] {
    const pass = new Collection<K, V>();
    const fail = new Collection<K, V>();
    for (const [key, value] of this) (fn(value, key, this) ? pass : fail).set(key, value);
    return [pass, fail];
  }

  map<T>(fn: (value: V, key: K, collection: this) => T): T[] {
    const out: T[] = [];
    for (const [key, value] of this) out.push(fn(value, key, this));
    return out;
  }

  mapValues<T>(fn: (value: V, key: K, collection: this) => T): Collection<K, T> {
    const out = new Collection<K, T>();
    for (const [key, value] of this) out.set(key, fn(value, key, this));
    return out;
  }

  some(fn: (value: V, key: K, collection: this) => unknown): boolean {
    for (const [key, value] of this) if (fn(value, key, this)) return true;
    return false;
  }

  every(fn: (value: V, key: K, collection: this) => unknown): boolean {
    for (const [key, value] of this) if (!fn(value, key, this)) return false;
    return true;
  }

  reduce<T = V>(fn: (accumulator: T, value: V, key: K, collection: this) => T, initialValue?: T): T {
    let accumulator: T | undefined = initialValue;
    let first = arguments.length < 2;
    for (const [key, value] of this) {
      if (first) {
        accumulator = value as unknown as T;
        first = false;
        continue;
      }
      accumulator = fn(accumulator as T, value, key, this);
    }
    if (first) throw new TypeError('Reduce of empty collection with no initial value');
    return accumulator as T;
  }

  each(fn: (value: V, key: K, collection: this) => void): this {
    for (const [key, value] of this) fn(value, key, this);
    return this;
  }

  hasAll(...keys: K[]): boolean {
    return keys.every((k) => this.has(k));
  }

  hasAny(...keys: K[]): boolean {
    return keys.some((k) => this.has(k));
  }

  ensure(key: K, defaultValueGenerator: (key: K, collection: this) => V): V {
    if (this.has(key)) return this.get(key)!;
    const value = defaultValueGenerator(key, this);
    this.set(key, value);
    return value;
  }

  sweep(fn: (value: V, key: K, collection: this) => unknown): number {
    const before = this.size;
    for (const [key, value] of this) if (fn(value, key, this)) this.delete(key);
    return before - this.size;
  }

  clone(): Collection<K, V> {
    return new Collection<K, V>(this);
  }

  concat(...collections: ReadonlyMap<K, V>[]): Collection<K, V> {
    const out = this.clone();
    for (const c of collections) for (const [key, value] of c) out.set(key, value);
    return out;
  }

  sort(compare: (firstValue: V, secondValue: V, firstKey: K, secondKey: K) => number = defaultSort): this {
    const entries = [...this.entries()];
    entries.sort((a, b) => compare(a[1], b[1], a[0], b[0]));
    this.clear();
    for (const [key, value] of entries) this.set(key, value);
    return this;
  }

  toJSON(): V[] {
    return [...this.values()];
  }
}

/** @discordjs/collection's default: ascending by `>` (numbers, strings). */
function defaultSort(a: unknown, b: unknown): number {
  return Number((a as string) > (b as string)) || Number(a === b) - 1;
}
