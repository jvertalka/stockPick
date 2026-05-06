import { useEffect, useMemo, useState } from 'react'
import { Filter as FilterIcon, Plus, Save, Trash2, X } from 'lucide-react'
import { kvGet, kvSet } from '../data/storage'
import type { DecisionSignal } from '../data/decisionEngine'
import {
  BOOLEAN_FIELDS,
  FIELD_LABELS,
  NUMERIC_FIELDS,
  type ComparisonOp,
  type FilterField,
  type FilterRule,
} from './filterTypes'

/**
 * Search-by-criteria filter builder UI. Pure component — predicate
 * logic lives in `filterTypes.ts` so this file only exports a React
 * component (Fast Refresh requirement).
 */

const SAVED_KEY = 'finance-oracle:saved-filters'
const SEEDED_KEY = 'finance-oracle:filters-seeded'

type SavedFilter = { name: string; rules: FilterRule[] }

/**
 * Built-in starter filters, seeded once on first launch so the user has
 * something useful to click instead of an empty Saved list. They can
 * delete or edit any of them — once seeded we don't re-add.
 */
const BUILT_IN_FILTERS: SavedFilter[] = [
  {
    name: 'Quality growth',
    rules: [
      { id: 'qg-1', field: 'opportunityScore', op: '>=', value: '70' },
      { id: 'qg-2', field: 'confidence', op: '>=', value: '70' },
      { id: 'qg-3', field: 'fragilityScore', op: '<=', value: '60' },
    ],
  },
  {
    name: 'Value setups',
    rules: [
      { id: 'val-1', field: 'opportunityScore', op: '>=', value: '60' },
      { id: 'val-2', field: 'riskScore', op: '<=', value: '60' },
      { id: 'val-3', field: 'forecast20d', op: '>=', value: '0' },
    ],
  },
  {
    name: 'Defensive',
    rules: [
      { id: 'def-1', field: 'fragilityScore', op: '<=', value: '50' },
      { id: 'def-2', field: 'riskScore', op: '<=', value: '50' },
      { id: 'def-3', field: 'confidence', op: '>=', value: '65' },
    ],
  },
  {
    name: 'High-conviction owned',
    rules: [
      { id: 'own-1', field: 'owned', op: '=', value: 'true' },
      { id: 'own-2', field: 'confidence', op: '>=', value: '70' },
    ],
  },
]

export function FilterBuilder({
  rules,
  onChange,
  universe,
}: {
  rules: FilterRule[]
  onChange: (rules: FilterRule[]) => void
  universe: DecisionSignal[]
}) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<SavedFilter[]>([])
  const [name, setName] = useState('')

  useEffect(() => {
    void (async () => {
      const value = (await kvGet<SavedFilter[]>(SAVED_KEY)) ?? []
      const alreadySeeded = await kvGet<boolean>(SEEDED_KEY)
      if (!alreadySeeded && value.length === 0) {
        await kvSet(SAVED_KEY, BUILT_IN_FILTERS)
        await kvSet(SEEDED_KEY, true)
        setSaved(BUILT_IN_FILTERS)
      } else {
        setSaved(value)
      }
    })()
  }, [])

  const sectors = useMemo(
    () => Array.from(new Set(universe.map((row) => row.sector))).sort(),
    [universe],
  )

  function addRule() {
    onChange([
      ...rules,
      {
        id: `${Date.now()}-${rules.length}`,
        field: 'opportunityScore',
        op: '>=',
        value: '70',
      },
    ])
  }

  function updateRule(id: string, patch: Partial<FilterRule>) {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))
  }

  function removeRule(id: string) {
    onChange(rules.filter((rule) => rule.id !== id))
  }

  async function saveCurrent() {
    if (!name.trim()) return
    const next = [...saved.filter((entry) => entry.name !== name.trim()), { name: name.trim(), rules }]
    setSaved(next)
    await kvSet(SAVED_KEY, next)
    setName('')
  }

  async function deleteSaved(filterName: string) {
    const next = saved.filter((entry) => entry.name !== filterName)
    setSaved(next)
    await kvSet(SAVED_KEY, next)
  }

  function loadSaved(filterName: string) {
    const found = saved.find((entry) => entry.name === filterName)
    if (found) onChange(found.rules)
  }

  return (
    <section className="filter-builder">
      <header>
        <button
          aria-expanded={open}
          className={`ghost ${rules.length > 0 ? 'active' : ''}`}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <FilterIcon size={14} />
          Custom filters{rules.length > 0 ? ` (${rules.length})` : ''}
        </button>
        {rules.length > 0 ? (
          <button className="ghost" onClick={() => onChange([])} type="button">
            Clear
          </button>
        ) : null}
      </header>
      {open ? (
        <div className="filter-builder-body">
          {rules.length === 0 ? (
            <p className="filter-builder-empty">
              No rules yet. Add one to combine criteria like "Tech sector + Opp ≥ 70 + Risk ≤ 60".
            </p>
          ) : (
            <ul className="filter-rules">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <select
                    aria-label="Field"
                    onChange={(event) =>
                      updateRule(rule.id, { field: event.target.value as FilterField })
                    }
                    value={rule.field}
                  >
                    {Object.entries(FIELD_LABELS).map(([field, label]) => (
                      <option key={field} value={field}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Operator"
                    onChange={(event) =>
                      updateRule(rule.id, { op: event.target.value as ComparisonOp })
                    }
                    value={rule.op}
                  >
                    <option value=">=">{'≥'}</option>
                    <option value="<=">{'≤'}</option>
                    <option value="=">=</option>
                    <option value="!=">{'≠'}</option>
                  </select>
                  {BOOLEAN_FIELDS.has(rule.field) ? (
                    <select
                      aria-label="Value"
                      onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                      value={rule.value}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : rule.field === 'sector' ? (
                    <select
                      aria-label="Sector"
                      onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                      value={rule.value}
                    >
                      <option value="">choose…</option>
                      {sectors.map((sector) => (
                        <option key={sector} value={sector}>
                          {sector}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Value"
                      onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                      placeholder={NUMERIC_FIELDS.has(rule.field) ? '70' : 'Technology'}
                      value={rule.value}
                    />
                  )}
                  <button
                    aria-label="Remove rule"
                    className="ghost icon-only"
                    onClick={() => removeRule(rule.id)}
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="ghost" onClick={addRule} type="button">
            <Plus size={12} />
            Add rule
          </button>
          <div className="filter-saved">
            <div className="filter-save-row">
              <input
                aria-label="Filter name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Name this filter…"
                value={name}
              />
              <button className="ghost" disabled={!name.trim() || rules.length === 0} onClick={saveCurrent} type="button">
                <Save size={12} />
                Save
              </button>
            </div>
            {saved.length > 0 ? (
              <ul className="saved-filter-list">
                {saved.map((entry) => (
                  <li key={entry.name}>
                    <button className="ghost" onClick={() => loadSaved(entry.name)} type="button">
                      {entry.name} <span>({entry.rules.length})</span>
                    </button>
                    <button
                      aria-label={`Delete ${entry.name}`}
                      className="ghost icon-only"
                      onClick={() => deleteSaved(entry.name)}
                      type="button"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
