// One-off: why does price-only mode never produce a bullish action?
;(globalThis as Record<string, unknown> & { window?: unknown }).window = globalThis
import { readFileSync } from 'node:fs'

async function main() {
  const { scoreUniverse } = await import('../src/data/decisionEngine')
  const path = process.argv[2]
  const payload = JSON.parse(readFileSync(path, 'utf8')) as { rawSignals: unknown[] }
  const scored = scoreUniverse(payload.rawSignals as never, 'base')
  const counts: Record<string, number> = {}
  for (const s of scored) counts[s.action] = (counts[s.action] ?? 0) + 1
  const sorted = [...scored].sort((a, b) => b.compositeAlphaZ - a.compositeAlphaZ)
  console.log('actions:', JSON.stringify(counts))
  console.log('names:', scored.length)
  console.log('top-5 by compositeAlphaZ:')
  for (const s of sorted.slice(0, 5)) {
    console.log(
      `  ${s.ticker.padEnd(6)} z=${s.compositeAlphaZ.toFixed(2)} pct=${s.alphaPercentile}` +
        ` agree=${s.factorAgreement} action=${s.action}`,
    )
  }
  const maxAgree = Math.max(...scored.map((s) => s.factorAgreement))
  const buyable = scored.filter(
    (s) => s.alphaPercentile >= 67 && s.compositeAlphaZ >= 0.5 && s.factorAgreement >= 50,
  ).length
  console.log(`max factorAgreement anywhere: ${maxAgree}`)
  console.log(`names passing pct+z+agreement (pre-risk) Accumulate gates: ${buyable}`)
  process.exit(0)
}
main()
