import type { DecisionSignal } from '../data/decisionEngine'
import type { StoredHolding } from '../data/storage'

/**
 * Find the user's holding for a given decision signal so we can size
 * covered calls / protective puts correctly.
 */
export function findHoldingForSignal(
  signal: DecisionSignal,
  holdings: StoredHolding[],
): StoredHolding | null {
  return holdings.find((entry) => entry.ticker === signal.ticker) ?? null
}
