import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import {
  activeOptionsProvider,
  fetchOptionsSnapshot,
  type OptionsSnapshot,
} from '../data/optionsAdapter'

/**
 * Surfaces the live options-snapshot the adapter is fetching for the
 * currently-selected ticker. When no provider is configured the card
 * shows the proxy-derived state instead so the user knows the engine
 * is using estimated data, not real chains.
 */

type Status = 'loading' | 'configured' | 'unconfigured' | 'error'

export function OptionsCard({ ticker }: { ticker: string }) {
  const [snapshot, setSnapshot] = useState<OptionsSnapshot | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const provider = activeOptionsProvider()

  useEffect(() => {
    let cancelled = false
    if (provider.name === 'stub') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('unconfigured')
      setSnapshot(null)
      return
    }
    setStatus('loading')
    setSnapshot(null)
    fetchOptionsSnapshot(ticker)
      .then((value) => {
        if (cancelled) return
        if (value) {
          setSnapshot(value)
          setStatus('configured')
        } else {
          setStatus('error')
        }
      })
      .catch(() => {
        if (cancelled) return
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [ticker, provider.name])

  return (
    <section className="panel-block options-card">
      <header>
        <Activity size={14} />
        <strong>Options snapshot</strong>
        <span className="options-source">{providerLabel(provider.name, status)}</span>
      </header>
      {status === 'unconfigured' ? (
        <p className="options-empty">
          No options provider configured. The engine is using price-derived
          proxies for skew, implied vol, and event risk. Set
          <code> VITE_TRADIER_TOKEN </code> in <code>.env.local</code> and
          restart <code>npm run dev</code> to switch on real data.
        </p>
      ) : status === 'loading' ? (
        <p className="options-empty">Loading {ticker} chain from {provider.name}…</p>
      ) : status === 'error' || !snapshot ? (
        <p className="options-empty">
          {provider.name} returned no data for {ticker}. The symbol may not have
          listed options, or the token may be invalid. Check the backend cache
          logs for <code>upstream_unavailable</code>.
        </p>
      ) : (
        <div className="options-grid">
          <div>
            <span>ATM 30d IV</span>
            <strong>{snapshot.atm30dIv.toFixed(1)}%</strong>
          </div>
          <div>
            <span>IV rank</span>
            <strong>{Math.round(snapshot.impliedVolRank)}</strong>
          </div>
          <div>
            <span>25Δ put skew</span>
            <strong className={snapshot.put25DeltaSkew > 4 ? 'caution' : ''}>
              {snapshot.put25DeltaSkew >= 0 ? '+' : ''}
              {snapshot.put25DeltaSkew.toFixed(1)} vol pts
            </strong>
          </div>
          <div>
            <span>Put / Call OI</span>
            <strong>
              {snapshot.putCallOiRatio != null
                ? snapshot.putCallOiRatio.toFixed(2)
                : '—'}
            </strong>
          </div>
        </div>
      )}
    </section>
  )
}

function providerLabel(name: string, status: Status): string {
  if (status === 'unconfigured') return 'proxy (no token)'
  if (status === 'loading') return `${name} · loading`
  if (status === 'error') return `${name} · error`
  return name
}
