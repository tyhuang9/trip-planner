import '@testing-library/jest-dom/vitest'

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  get length() {
    return this.items.size
  }

  clear() {
    this.items.clear()
  }

  getItem(key: string) {
    return this.items.get(key) ?? null
  }

  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.items.delete(key)
  }

  setItem(key: string, value: string) {
    this.items.set(key, String(value))
  }
}

const testStorage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testStorage,
})
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testStorage,
})

// jsdom does not implement the browser Web Locks API. Provide the same
// exclusive, promise-based semantics production auth requires; individual
// coordination tests can replace or remove it to exercise queueing/fail-closed
// behavior.
let webLockTail = Promise.resolve<unknown>(undefined)
Object.defineProperty(globalThis.navigator, 'locks', {
  configurable: true,
  value: {
    request<T>(
      _name: string,
      _options: { mode: 'exclusive' },
      callback: () => T | Promise<T>,
    ): Promise<T> {
      const run = webLockTail.then(callback)
      webLockTail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  },
})
