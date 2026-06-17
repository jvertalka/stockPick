import type { DecisionSignal } from '../data/decisionEngine'

/**
 * Types and predicate logic for the FilterBuilder. Lives in a non-
 * component module so the FilterBuilder.tsx file can be hot-reloaded
 * without violating the react-refresh/only-export-components rule.
 */

export type ComparisonOp = '>=' | '<=' | '=' | '!='

export type FilterField =
  | 'opportunityScore'
  | 'riskScore'
  | 'confidence'
  | 'regimeFit'
  | 'fragilityScore'
  | 'forecast20d'
  | 'sector'
  | 'industry'
  | 'action'
  | 'owned'
  | 'watched'

export type FilterRule = {
  id: string
  field: FilterField
  op: ComparisonOp
  value: string
}

export const NUMERIC_FIELDS = new Set<FilterField>([
  'opportunityScore',
  'riskScore',
  'confidence',
  'regimeFit',
  'fragilityScore',
  'forecast20d',
])

export const BOOLEAN_FIELDS = new Set<FilterField>(['owned', 'watched'])

export const FIELD_LABELS: Record<FilterField, string> = {
  opportunityScore: 'Opportunity',
  riskScore: 'Risk',
  confidence: 'Confidence',
  regimeFit: 'Regime fit',
  fragilityScore: 'Fragility',
  forecast20d: '20d forecast',
  sector: 'Sector',
  industry: 'Industry',
  action: 'Action',
  owned: 'Owned',
  watched: 'Watched',
}

export function buildPredicate(
  rules: FilterRule[],
  ownedTickers: Set<string>,
  watchTickers: Set<string>,
) {
  if (rules.length === 0) return () => true
  return (row: DecisionSignal) =>
    rules.every((rule) => evaluateRule(rule, row, ownedTickers, watchTickers))
}

function evaluateRule(
  rule: FilterRule,
  row: DecisionSignal,
  owned: Set<string>,
  watched: Set<string>,
) {
  const { field, op, value } = rule
  if (BOOLEAN_FIELDS.has(field)) {
    const actual = field === 'owned' ? owned.has(row.ticker) : watched.has(row.ticker)
    const expected = value === 'true'
    return op === '!=' ? actual !== expected : actual === expected
  }
  if (NUMERIC_FIELDS.has(field)) {
    const actual = ((row as unknown as Record<string, number>)[field]) ?? 0
    const expected = Number(value)
    if (!Number.isFinite(expected)) return true
    if (op === '>=') return actual >= expected
    if (op === '<=') return actual <= expected
    if (op === '=') return Math.abs(actual - expected) < 0.001
    return Math.abs(actual - expected) >= 0.001
  }
  const actual = String((row as unknown as Record<string, unknown>)[field] ?? '').toLowerCase()
  const expected = value.toLowerCase()
  if (op === '!=') return actual !== expected
  return actual === expected || actual.includes(expected)
}
