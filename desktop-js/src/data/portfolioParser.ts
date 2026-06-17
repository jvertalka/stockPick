import type { StoredHolding } from './storage'

/**
 * Parses brokerage CSV exports + free-text paste blobs into StoredHolding
 * rows. Auto-detects column names so users don't need to reformat. Handles:
 *
 *   - Fidelity:  "Account Name, Account Number, Symbol, Description, Quantity,
 *                 Last Price, ..., Average Cost Basis, ..."
 *   - Schwab:    "Symbol, Description, Quantity, Price, Price Change %,
 *                 Market Value, Day Change $, Cost Basis, Gain/Loss $, ..."
 *   - E*TRADE:   "Symbol, Last Price $, Change $, Change %, Volume, ...,
 *                 Quantity #, Price Paid $, Total Gain $, Total Gain %, Value $"
 *   - Robinhood: "Symbol, Description, Average Cost, Total Cost, Quantity"
 *   - Generic CSV with Symbol + Quantity + Cost columns in any order
 *   - Free-text paste: "AAPL", "AAPL,40", "AAPL,40,165.50" rows
 */

export type ParsedImport = {
  rows: StoredHolding[]
  diagnostics: {
    detectedFormat: 'fidelity' | 'schwab' | 'etrade' | 'robinhood' | 'generic-csv' | 'paste'
    headerColumns?: string[]
    skippedRows: number
    duplicates: number
  }
  warnings: string[]
}

const SYMBOL_HEADERS = ['symbol', 'ticker', 'security', 'symbol/cusip', 'instrument']
const QUANTITY_HEADERS = [
  'quantity',
  'shares',
  'qty',
  'quantity #',
  'shares owned',
  'units',
  'shares held',
]
const COST_HEADERS = [
  'average cost basis',
  'avg cost',
  'avg cost basis',
  'cost basis per share',
  'price paid',
  'price paid $',
  'average cost',
  'cost/share',
  'cost per share',
  'avg price',
  'purchase price',
]
const TOTAL_COST_HEADERS = ['total cost', 'cost basis total', 'cost basis', 'total cost basis']

/** Skip rows where the "symbol" looks like cash, totals, or a header. */
const NON_HOLDING_SYMBOLS = new Set([
  'cash',
  'total',
  'subtotal',
  'pending',
  'pending activity',
  'spaxx**',
  'spaxx',
  'fdrxx',
  'fzfxx',
])

export function parsePortfolioInput(input: string): ParsedImport {
  const trimmed = input.trim()
  if (!trimmed) {
    return emptyResult('paste', ['No input provided'])
  }
  const rows = splitRows(trimmed)
  if (rows.length === 0) {
    return emptyResult('paste', ['No rows parsed'])
  }

  // Look for a header row in the first 3 lines — most brokerage exports
  // start with their own preamble (account info, dates, blank lines).
  const headerInfo = findHeader(rows.slice(0, 6))

  if (headerInfo) {
    return parseCsv(rows, headerInfo)
  }
  return parsePasteText(rows)
}

function findHeader(candidates: string[][]): {
  headerRow: string[]
  headerIndex: number
  symbolCol: number
  quantityCol: number
  costCol: number | null
  totalCostCol: number | null
  format: ParsedImport['diagnostics']['detectedFormat']
} | null {
  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i]
    if (row.length < 2) continue
    const lower = row.map((cell) => cell.trim().toLowerCase())
    const symbolCol = lower.findIndex((cell) => SYMBOL_HEADERS.includes(cell))
    if (symbolCol < 0) continue
    const quantityCol = lower.findIndex((cell) => QUANTITY_HEADERS.includes(cell))
    if (quantityCol < 0) continue
    const costCol = lower.findIndex((cell) => COST_HEADERS.includes(cell))
    const totalCostCol = lower.findIndex((cell) => TOTAL_COST_HEADERS.includes(cell))
    return {
      headerRow: row,
      headerIndex: i,
      symbolCol,
      quantityCol,
      costCol: costCol >= 0 ? costCol : null,
      totalCostCol: totalCostCol >= 0 ? totalCostCol : null,
      format: detectFormat(lower),
    }
  }
  return null
}

function detectFormat(
  headerLower: string[],
): ParsedImport['diagnostics']['detectedFormat'] {
  const joined = headerLower.join('|')
  if (joined.includes('account number') && joined.includes('average cost basis')) return 'fidelity'
  if (joined.includes('day change $') && joined.includes('cost basis')) return 'schwab'
  if (joined.includes('quantity #') && joined.includes('price paid')) return 'etrade'
  if (joined.includes('average cost') && joined.includes('total cost')) return 'robinhood'
  return 'generic-csv'
}

function parseCsv(rows: string[][], info: NonNullable<ReturnType<typeof findHeader>>): ParsedImport {
  const out: StoredHolding[] = []
  const seen = new Set<string>()
  let skipped = 0
  let duplicates = 0
  const warnings: string[] = []
  const now = new Date().toISOString()

  for (let i = info.headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.length <= info.symbolCol) {
      skipped++
      continue
    }
    const rawSymbol = row[info.symbolCol]?.trim() ?? ''
    const ticker = sanitizeTicker(rawSymbol)
    if (!ticker) {
      skipped++
      continue
    }
    if (NON_HOLDING_SYMBOLS.has(rawSymbol.toLowerCase()) || rawSymbol.startsWith('**')) {
      skipped++
      continue
    }

    const shares = parseNumber(row[info.quantityCol])
    if (shares == null) {
      skipped++
      continue
    }

    let averageCost: number | undefined
    if (info.costCol != null) {
      const c = parseNumber(row[info.costCol])
      if (c != null && c > 0) averageCost = c
    }
    if (averageCost == null && info.totalCostCol != null && shares > 0) {
      const total = parseNumber(row[info.totalCostCol])
      if (total != null && total > 0) averageCost = total / shares
    }

    if (seen.has(ticker)) {
      duplicates++
      continue
    }
    seen.add(ticker)
    out.push({
      ticker,
      shares: shares > 0 ? shares : 0,
      averageCost,
      addedAt: now,
    })
  }

  if (out.length === 0) {
    warnings.push(
      'CSV header was detected but no usable rows were found. Confirm the file has Symbol + Quantity columns with real data.',
    )
  }

  return {
    rows: out,
    diagnostics: {
      detectedFormat: info.format,
      headerColumns: info.headerRow.map((cell) => cell.trim()),
      skippedRows: skipped,
      duplicates,
    },
    warnings,
  }
}

function parsePasteText(rows: string[][]): ParsedImport {
  const out: StoredHolding[] = []
  const seen = new Set<string>()
  let skipped = 0
  let duplicates = 0
  const now = new Date().toISOString()

  for (const row of rows) {
    // Each row could be: TICKER  /  TICKER,SHARES  /  TICKER,SHARES,COST
    const cells = row.length === 1 ? row[0].split(/\s+/u).filter(Boolean) : row
    const ticker = sanitizeTicker(cells[0] ?? '')
    if (!ticker) {
      skipped++
      continue
    }
    const shares = cells[1] ? parseNumber(cells[1]) ?? 0 : 0
    const averageCost = cells[2] ? parseNumber(cells[2]) ?? undefined : undefined
    if (seen.has(ticker)) {
      duplicates++
      continue
    }
    seen.add(ticker)
    out.push({
      ticker,
      shares: shares > 0 ? shares : 0,
      averageCost: averageCost && averageCost > 0 ? averageCost : undefined,
      addedAt: now,
    })
  }

  return {
    rows: out,
    diagnostics: {
      detectedFormat: 'paste',
      skippedRows: skipped,
      duplicates,
    },
    warnings: [],
  }
}

function emptyResult(
  format: ParsedImport['diagnostics']['detectedFormat'],
  warnings: string[],
): ParsedImport {
  return {
    rows: [],
    diagnostics: { detectedFormat: format, skippedRows: 0, duplicates: 0 },
    warnings,
  }
}

/** Splits raw text into row arrays. Handles CSV quoting and TSV. */
export function splitRows(text: string): string[][] {
  const rows: string[][] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    if (line.trim() === '') continue
    rows.push(splitCsvRow(line))
  }
  return rows
}

function splitCsvRow(line: string): string[] {
  // Detect tab-separated as a fallback for users pasting from Excel
  if (line.includes('\t') && !line.includes(',')) {
    return line.split('\t').map((cell) => cell.trim())
  }
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        inQuotes = false
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function sanitizeTicker(value: string): string | null {
  if (!value) return null
  // Strip common decorations: $AAPL, "AAPL", AAPL ($284.18), AAPL — Apple
  const cleaned = value
    .replace(/^\$/, '')
    .replace(/[(].*?[)]/g, '')
    .replace(/\s+—.*$/u, '')
    .replace(/\s+-.*$/u, '')
    .trim()
    .toUpperCase()
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/u.test(cleaned)) return null
  return cleaned
}

function parseNumber(value: string | undefined): number | null {
  if (value == null) return null
  const cleaned = value.replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1').trim()
  if (!cleaned) return null
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}
