import { Check, Minus, X } from 'lucide-react'
import type { ConvictionStack } from '../data/convictionStack'

/**
 * Six-segment evidence meter for the detail panel's verdict block.
 * Each segment is one independent method (rules / ML / Monte Carlo /
 * options skew / regime / multi-horizon); hovering a segment shows the
 * exact evidence and threshold behind its vote. No blended number —
 * the user sees HOW MANY methods corroborate, and which.
 */
export function ConvictionStackMeter({ stack }: { stack: ConvictionStack | null }) {
  if (!stack) return null
  return (
    <section
      className={`conviction-stack ${stack.tone}`}
      data-testid="conviction-stack"
    >
      <header>
        <p>Conviction stack</p>
        <strong>
          {stack.label}
          <span className="conviction-count">
            {stack.passed}/{stack.available} methods agree
            {stack.available < stack.layers.length
              ? ` · ${stack.layers.length - stack.available} unavailable`
              : ''}
          </span>
        </strong>
      </header>
      <div className="conviction-segments" role="list">
        {stack.layers.map((layer) => (
          <div
            className={`conviction-segment ${layer.status}`}
            key={layer.id}
            role="listitem"
            title={`${layer.label}: ${layer.detail}`}
          >
            {layer.status === 'pass' ? (
              <Check size={11} />
            ) : layer.status === 'fail' ? (
              <X size={11} />
            ) : (
              <Minus size={11} />
            )}
            <span>{layer.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
