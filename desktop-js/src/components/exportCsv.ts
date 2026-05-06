/**
 * CSV export helpers. Builds a brokerage-friendly CSV string from a list
 * of decision rows and writes it to the clipboard via the async
 * Clipboard API. Falls back to a hidden textarea when clipboard access
 * is denied (e.g. inside hardened webviews).
 */

export type ExportRow = {
  ticker: string
  name: string
  action: string
  reason: string
  opportunityScore: number
  riskScore: number
  forecast20d: number
  lastPrice?: number
}

export function rowsToCsv(rows: ExportRow[]): string {
  const header = ['Ticker', 'Name', 'Action', 'Reason', 'Opportunity', 'Risk', '20d Forecast %', 'Last Price']
  const body = rows.map((row) => [
    row.ticker,
    row.name,
    row.action,
    row.reason,
    String(row.opportunityScore),
    String(row.riskScore),
    row.forecast20d.toFixed(2),
    row.lastPrice != null ? row.lastPrice.toFixed(2) : '',
  ])
  return [header, ...body].map(encodeRow).join('\n')
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to textarea fallback
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function encodeRow(cells: string[]): string {
  return cells.map(encodeCell).join(',')
}

function encodeCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
