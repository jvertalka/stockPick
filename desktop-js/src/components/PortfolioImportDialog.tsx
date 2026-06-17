import { useRef, useState } from 'react'
import { CheckCircle2, FileText, Upload, X } from 'lucide-react'
import { parsePortfolioInput, type ParsedImport } from '../data/portfolioParser'
import type { StoredHolding } from '../data/storage'

/**
 * Dialog for importing owned positions either from a brokerage CSV file
 * or pasted text. Auto-detects column layout (Fidelity / Schwab /
 * E*TRADE / Robinhood / generic) and shows a preview of what will be
 * imported before the user commits.
 */

type Props = {
  open: boolean
  onCancel: () => void
  onImport: (rows: StoredHolding[]) => void
}

export function PortfolioImportDialog({ open, onCancel, onImport }: Props) {
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<ParsedImport | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  if (!open) return null

  function reset() {
    setPasteText('')
    setParsed(null)
    setFileName(null)
  }

  function close() {
    reset()
    onCancel()
  }

  function handlePasteParse() {
    if (!pasteText.trim()) {
      setParsed(null)
      return
    }
    setParsed(parsePortfolioInput(pasteText))
    setFileName(null)
  }

  async function handleFile(file: File) {
    const text = await file.text()
    setFileName(file.name)
    setPasteText(text)
    setParsed(parsePortfolioInput(text))
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) void handleFile(file)
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }

  function commit() {
    if (!parsed || parsed.rows.length === 0) return
    onImport(parsed.rows)
    reset()
  }

  return (
    <>
      <div aria-hidden className="drawer-backdrop" onClick={close} />
      <div aria-modal className="import-dialog" role="dialog">
        <header>
          <FileText size={16} />
          <h2>Import portfolio</h2>
          <button aria-label="Close import dialog" className="ghost icon-only" onClick={close} type="button">
            <X size={14} />
          </button>
        </header>

        <div
          className="import-dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
        >
          <Upload size={18} />
          <strong>{fileName ?? 'Click to choose a CSV — or drag one here'}</strong>
          <span>
            Works with Fidelity / Schwab / E*TRADE / Robinhood exports. Any CSV with
            Symbol + Quantity columns works.
          </span>
          <input
            accept=".csv,.tsv,.txt"
            aria-label="Choose portfolio CSV"
            onChange={handleFileChange}
            ref={fileInputRef}
            style={{ display: 'none' }}
            type="file"
          />
        </div>

        <div className="import-divider">
          <span>or paste rows manually</span>
        </div>

        <textarea
          aria-label="Paste portfolio rows"
          className="import-textarea"
          onBlur={handlePasteParse}
          onChange={(event) => setPasteText(event.target.value)}
          placeholder={'AAPL,40,165.50\nMSFT,25,310.25\nNVDA,12'}
          rows={5}
          value={pasteText}
        />
        <button className="ghost" disabled={!pasteText.trim()} onClick={handlePasteParse} type="button">
          Parse pasted text
        </button>

        {parsed ? <ImportPreview parsed={parsed} /> : null}

        <footer>
          <button className="ghost" onClick={close} type="button">
            Cancel
          </button>
          <button
            className="primary"
            disabled={!parsed || parsed.rows.length === 0}
            onClick={commit}
            type="button"
          >
            <CheckCircle2 size={14} />
            Import {parsed?.rows.length ?? 0} position{parsed?.rows.length === 1 ? '' : 's'}
          </button>
        </footer>
      </div>
    </>
  )
}

function ImportPreview({ parsed }: { parsed: ParsedImport }) {
  if (parsed.rows.length === 0) {
    return (
      <section className="import-preview empty">
        <strong>No usable rows found.</strong>
        {parsed.warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
        <span className="import-preview-meta">
          Detected: {parsed.diagnostics.detectedFormat} · skipped {parsed.diagnostics.skippedRows}
        </span>
      </section>
    )
  }
  const withCost = parsed.rows.filter((row) => row.averageCost && row.shares > 0).length
  return (
    <section className="import-preview">
      <header>
        <strong>{parsed.rows.length} positions detected</strong>
        <span className="import-preview-meta">
          format: {parsed.diagnostics.detectedFormat}
          {parsed.diagnostics.skippedRows > 0 ? ` · skipped ${parsed.diagnostics.skippedRows}` : ''}
          {parsed.diagnostics.duplicates > 0 ? ` · ${parsed.diagnostics.duplicates} dupes merged` : ''}
          {withCost > 0 ? ` · ${withCost} with cost basis` : ''}
        </span>
      </header>
      <ul className="import-preview-list">
        {parsed.rows.slice(0, 12).map((row) => (
          <li key={row.ticker}>
            <strong>{row.ticker}</strong>
            <span>{row.shares > 0 ? `${row.shares.toLocaleString()} sh` : 'tracking only'}</span>
            <span>
              {row.averageCost ? `avg $${row.averageCost.toFixed(2)}` : '—'}
            </span>
          </li>
        ))}
        {parsed.rows.length > 12 ? <li className="more">+{parsed.rows.length - 12} more</li> : null}
      </ul>
      {parsed.warnings.map((warning) => (
        <span className="import-preview-warning" key={warning}>
          {warning}
        </span>
      ))}
    </section>
  )
}
