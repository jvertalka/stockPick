import { useEffect, useState } from 'react'
import { ExternalLink, Newspaper } from 'lucide-react'
import { cachedFetchNews, type NewsArticle } from '../data/marketData'

/**
 * Recent-news panel pulled from GDELT through the backend's CORS proxy.
 * Tone is normalized: GDELT returns roughly -10 to +10, we color-code
 * negative tone red and positive tone green so the user can scan for
 * bad-news clusters quickly.
 */

export function NewsStream({ ticker, name }: { ticker: string; name: string }) {
  const [articles, setArticles] = useState<NewsArticle[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    cachedFetchNews(ticker, name, 8)
      .then((rows) => {
        if (cancelled) return
        setArticles(rows)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setArticles([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ticker, name])

  return (
    <section className="panel-block news-stream">
      <header>
        <Newspaper size={14} />
        <strong>Recent news</strong>
        <span className="news-meta">via GDELT</span>
      </header>
      {loading && !articles ? (
        <p className="news-loading">Loading recent coverage…</p>
      ) : !articles || articles.length === 0 ? (
        <p className="news-empty">
          No recent articles surfaced. GDELT picks up English-language web news within ~15 minutes
          of publish; if this stays empty after a refresh, the source may not have indexed {ticker}{' '}
          yet.
        </p>
      ) : (
        <ul className="news-list">
          {articles.map((article) => (
            <li className={toneClass(article.tone)} key={`${article.url}-${article.publishedAt}`}>
              <a href={article.url} rel="noreferrer noopener" target="_blank">
                <span className="news-title">{article.title}</span>
                <ExternalLink size={11} />
              </a>
              <span className="news-row-meta">
                <span>{article.source}</span>
                <span>·</span>
                <span>{formatRelative(article.publishedAt)}</span>
                {article.tone != null ? (
                  <>
                    <span>·</span>
                    <span title="GDELT tone score (-10 negative … +10 positive)">
                      tone {article.tone.toFixed(1)}
                    </span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function toneClass(tone?: number) {
  if (typeof tone !== 'number') return ''
  if (tone <= -3) return 'tone-negative'
  if (tone >= 3) return 'tone-positive'
  return ''
}

function formatRelative(iso: string) {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = Date.now() - then
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
