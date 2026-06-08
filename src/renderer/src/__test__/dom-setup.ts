// Per-test-file setup for happy-dom DOM tests.
//
// happy-dom 20 inside vitest exposes a `localStorage` global that is a
// placeholder object without the Storage API; modules that read from it
// at import time (e.g. `ui-store.ts`) crash with "getItem is not a
// function". Polyfill the bare API so imports succeed.

class TestStorage implements Storage {
  private store: Map<string, string> = new Map()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

const ls = new TestStorage()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls })
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: ls })
}
