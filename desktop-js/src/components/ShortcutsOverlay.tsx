import { useEffect } from 'react'
import { Keyboard, X } from 'lucide-react'

/**
 * Modal overlay listing all keyboard shortcuts. Triggered by `?` from
 * anywhere in the app (handler lives in App.tsx). Escape or `?` again
 * dismisses it.
 */

const shortcuts: Array<{ keys: string; description: string }> = [
  { keys: '?', description: 'Show or hide this shortcut list' },
  { keys: '/', description: 'Jump to the search box' },
  { keys: 'J  /  ↓', description: 'Move selection down one row' },
  { keys: 'K  /  ↑', description: 'Move selection up one row' },
  { keys: 'Enter', description: 'Mark the selected row as reviewed' },
  { keys: 'O', description: 'Toggle owned status on the selected row' },
  { keys: 'W', description: 'Toggle watch status on the selected row' },
  { keys: 'Esc', description: 'Close this overlay or the detail drawer' },
]

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div aria-hidden className="drawer-backdrop" onClick={onClose} />
      <div
        aria-labelledby="shortcuts-title"
        aria-modal
        className="shortcuts-overlay"
        role="dialog"
      >
        <header>
          <Keyboard size={16} />
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button aria-label="Close shortcuts" className="ghost icon-only" onClick={onClose} type="button">
            <X size={14} />
          </button>
        </header>
        <dl>
          {shortcuts.map(({ keys, description }) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
        <footer>
          <span>Tip: most shortcuts are ignored while you're typing in a form field.</span>
        </footer>
      </div>
    </>
  )
}
