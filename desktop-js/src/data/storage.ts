/**
 * IndexedDB wrapper for the workstation's local persistence layer.
 *
 * LocalStorage caps at ~5MB which is fine for theme + view state but
 * cannot hold notes, decision history, or holdings-with-cost long term.
 * This module exposes a tiny promise-based wrapper around four object
 * stores:
 *
 *   - notes:         per-ticker free-text thesis notes
 *   - decision_log:  rolling history of action transitions per ticker
 *   - holdings:      per-ticker shares + average cost basis
 *   - kv:            small key/value scratch (last sync attempt, etc.)
 *
 * Each store has a primary key on `ticker` (or `key` for kv). Decision
 * log entries cap at the 60 most recent rows per ticker — older entries
 * are pruned on each append so unbounded growth doesn't haunt anyone.
 */

const DB_NAME = 'finance-oracle-workstation'
const DB_VERSION = 1

const STORES = {
  notes: 'notes',
  decisionLog: 'decision_log',
  holdings: 'holdings',
  kv: 'kv',
} as const

export type DecisionLogEntry = {
  ticker: string
  asOf: string
  action: string
  opportunityScore: number
  riskScore: number
  confidence: number
  reason: string
}

export type StoredHolding = {
  ticker: string
  shares: number
  averageCost?: number
  addedAt: string
}

export type TickerNote = {
  ticker: string
  text: string
  updatedAt: string
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORES.notes)) {
        db.createObjectStore(STORES.notes, { keyPath: 'ticker' })
      }
      if (!db.objectStoreNames.contains(STORES.decisionLog)) {
        const store = db.createObjectStore(STORES.decisionLog, {
          keyPath: 'id',
          autoIncrement: true,
        })
        store.createIndex('ticker', 'ticker', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.holdings)) {
        db.createObjectStore(STORES.holdings, { keyPath: 'ticker' })
      }
      if (!db.objectStoreNames.contains(STORES.kv)) {
        db.createObjectStore(STORES.kv, { keyPath: 'key' })
      }
    }
  })
  return dbPromise
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const store = transaction.objectStore(storeName)
        const request = fn(store)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }),
  )
}

/* =========================================================================
   Notes
   ========================================================================= */
export async function getNote(ticker: string): Promise<TickerNote | null> {
  try {
    const result = await tx<TickerNote | undefined>(STORES.notes, 'readonly', (store) =>
      store.get(ticker),
    )
    return result ?? null
  } catch {
    return null
  }
}

export async function setNote(ticker: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) {
    await tx<undefined>(STORES.notes, 'readwrite', (store) => store.delete(ticker))
    return
  }
  const entry: TickerNote = { ticker, text: trimmed, updatedAt: new Date().toISOString() }
  await tx<IDBValidKey>(STORES.notes, 'readwrite', (store) => store.put(entry))
}

export async function getAllNotes(): Promise<Record<string, TickerNote>> {
  try {
    const all = await tx<TickerNote[]>(STORES.notes, 'readonly', (store) => store.getAll())
    return Object.fromEntries(all.map((entry) => [entry.ticker, entry]))
  } catch {
    return {}
  }
}

/* =========================================================================
   Decision log
   ========================================================================= */
const MAX_LOG_PER_TICKER = 60

export async function appendDecisionLog(entry: DecisionLogEntry): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORES.decisionLog, 'readwrite')
      const store = transaction.objectStore(STORES.decisionLog)
      const index = store.index('ticker')
      const cursorReq = index.openCursor(IDBKeyRange.only(entry.ticker))
      const existing: Array<{ id: number; entry: DecisionLogEntry }> = []
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          existing.push({ id: cursor.primaryKey as number, entry: cursor.value })
          cursor.continue()
          return
        }
        const previous = existing[existing.length - 1]?.entry
        if (previous && previous.action === entry.action) {
          // No transition — skip to avoid log spam on every refresh.
          resolve()
          return
        }
        store.add(entry)
        // Prune oldest if we exceed cap.
        const overflow = existing.length + 1 - MAX_LOG_PER_TICKER
        if (overflow > 0) {
          existing
            .slice(0, overflow)
            .forEach((row) => store.delete(row.id))
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } catch {
    // Logging is best-effort.
  }
}

export async function getDecisionLog(ticker: string): Promise<DecisionLogEntry[]> {
  try {
    const db = await openDb()
    return await new Promise<DecisionLogEntry[]>((resolve, reject) => {
      const transaction = db.transaction(STORES.decisionLog, 'readonly')
      const index = transaction.objectStore(STORES.decisionLog).index('ticker')
      const request = index.getAll(IDBKeyRange.only(ticker))
      request.onsuccess = () =>
        resolve(
          (request.result as DecisionLogEntry[]).slice().sort((left, right) =>
            left.asOf.localeCompare(right.asOf),
          ),
        )
      request.onerror = () => reject(request.error)
    })
  } catch {
    return []
  }
}

/* =========================================================================
   Holdings (with cost basis)
   ========================================================================= */
export async function getHoldings(): Promise<StoredHolding[]> {
  try {
    return await tx<StoredHolding[]>(STORES.holdings, 'readonly', (store) => store.getAll())
  } catch {
    return []
  }
}

export async function putHolding(entry: StoredHolding): Promise<void> {
  await tx<IDBValidKey>(STORES.holdings, 'readwrite', (store) => store.put(entry))
}

export async function deleteHolding(ticker: string): Promise<void> {
  await tx<undefined>(STORES.holdings, 'readwrite', (store) => store.delete(ticker))
}

export async function bulkPutHoldings(entries: StoredHolding[]): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.holdings, 'readwrite')
    const store = transaction.objectStore(STORES.holdings)
    entries.forEach((entry) => store.put(entry))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

/* =========================================================================
   KV scratch
   ========================================================================= */
export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const result = await tx<{ key: string; value: T } | undefined>(STORES.kv, 'readonly', (store) =>
      store.get(key),
    )
    return result?.value ?? null
  } catch {
    return null
  }
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await tx<IDBValidKey>(STORES.kv, 'readwrite', (store) => store.put({ key, value }))
}

/**
 * Records the current action for every owned/watched ticker. Logging
 * skips inserts when the action hasn't changed, so the timeline only
 * ever shows transitions.
 */
export async function recordCurrentDecisions(rows: DecisionLogEntry[]): Promise<void> {
  await Promise.all(rows.map(appendDecisionLog))
}

/* =========================================================================
   One-time migration from localStorage owned-tickers to IndexedDB holdings.
   Keeps backward compatibility: imports without cost basis are stored with
   shares=0 so the user knows to fill them in later.
   ========================================================================= */
export async function migrateLegacyOwnedTickers(legacy: string[]): Promise<void> {
  if (legacy.length === 0) return
  const existing = await getHoldings()
  const known = new Set(existing.map((entry) => entry.ticker))
  const missing = legacy.filter((ticker) => !known.has(ticker))
  if (missing.length === 0) return
  const now = new Date().toISOString()
  await bulkPutHoldings(
    missing.map((ticker) => ({ ticker, shares: 0, addedAt: now })),
  )
}
