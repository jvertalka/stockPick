/**
 * Helpers for the pre-registered walk-forward run (tools/backtest-cli.ts).
 *
 * The model core (src/data/historicalBacktest.ts) scores every test window
 * inside one function call and keeps the results in memory until the end.
 * On a run that takes most of a day, a crash near the end throws away
 * everything. This module lets the CLI drive the same window loop itself,
 * writing each window's result to disk as soon as it exists, so a restart
 * picks up where the last run stopped and loses at most one window.
 *
 * Nothing here changes what is measured. The windows are cut by the core's
 * own buildCalendarWindows, each window is scored by the core's own
 * walkForwardStep, the paired intervals come from the core's own
 * computeBaselineEvidence, and the served models are trained by the core's
 * own runWalkForwardBacktest. The test file next to this module proves that
 * a run which stops and resumes produces exactly the same numbers as one
 * straight call into the core.
 *
 * Also here, because the runner needs them and they are small: the list of
 * exchange-traded funds in the universe, the required-windows arithmetic
 * from docs/EVIDENCE_QUALITY.md section 5, and the holdout split from
 * section 4.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BACKTEST_TICKERS,
  computeBaselineEvidence,
  measuredOverlapBlockLength,
  runWalkForwardBacktest,
  summarizeCalendarWindows,
  walkForwardStep,
  windowRows,
  type BaselineComparisonEvidence,
  type CalendarWindow,
  type ConfidenceInterval,
  type CorrelationKind,
  type FullBacktestResult,
  type HistoricalSample,
  type IndexedSample,
  type MomentumBaselineDefinition,
  type WalkForwardResult,
  type WindowRule,
} from '../src/data/historicalBacktest'
import { TRADING_DAYS_PER_YEAR } from '../src/data/quantConfig'

/* =========================================================================
   JSON that keeps NaN and infinity
   -------------------------------------------------------------------------
   A window's record carries "not a number" in a few places on purpose (for
   example the 12-0 momentum reading when that column is not in the feature
   set). Plain JSON turns those into null, and a null would later read as
   "missing" rather than "measured and undefined". These two functions write
   such values as a small marker object and read them back unchanged.
   ========================================================================= */

const NON_FINITE_KEY = '$nonFinite'

export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      return { [NON_FINITE_KEY]: Number.isNaN(item) ? 'NaN' : item > 0 ? 'Infinity' : '-Infinity' }
    }
    return item
  })
}

export function decodeJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (
      item != null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.keys(item).length === 1 &&
      typeof (item as Record<string, unknown>)[NON_FINITE_KEY] === 'string'
    ) {
      const marker = (item as Record<string, string>)[NON_FINITE_KEY]
      return marker === 'NaN' ? Number.NaN : marker === 'Infinity' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    }
    return item
  }) as T
}

/* =========================================================================
   The checkpoint directory
   -------------------------------------------------------------------------
   Four files:
     run.json       what this run is (tickers, features, window rule, gate
                    settings, tree settings, and a content hash of the rows
                    the windows were cut from). A resume must match it.
     windows.jsonl  one line per finished window, appended as each finishes.
     resume.json    a small marker rewritten after every window: how many
                    windows are done and through which date. The line file
                    is the source of truth; the marker is for a quick look.
     lock.json      the process id of the run that holds the directory, so
                    two runs can never write windows into it at once.
   ========================================================================= */

/** Content hash of the dataset rows a checkpoint was cut from. */
export type SampleContentHash = {
  /** Rows dated on or before this date are hashed. It is fixed when the
   * checkpoint is created (the last sample date minus a short tail margin)
   * and reused by every resume, so rows that a later fetch legitimately
   * appends at the tail of the history do not change the hash. Those tail
   * rows fall into windows that were not scored yet, and a window that was
   * scored is still checked row for row when it is replayed. Null when the
   * dataset was empty. */
  throughDate: string | null
  /** How many rows the hash covers. */
  count: number
  /** SHA-256 over every covered row's ticker, date, the four raw and four
   * relative forward returns, the four label end dates, the market cap at
   * formation and whether a real SEC snapshot was observed, in (ticker,
   * date) order. Two datasets that hash the same have the same rows with
   * the same answers and the same fundamentals coverage. */
  sha256: string
}

export type CheckpointFingerprint = {
  schemaVersion: 2
  /** Sorted, so the same universe named in a different order still matches. */
  tickers: string[]
  featureNames: string[]
  rule: WindowRule
  momentumBaseline: MomentumBaselineDefinition
  correlation: CorrelationKind
  hyperparameters: { numTrees: number; depth: number; learningRate: number }
  freezeHparams: boolean
  horizonDays: number
  range: string
  excludeEtfs: boolean
  cadenceDays: number
  /** Where the samples start. New bars at the tail of the history do not
   * change already-scored windows, so the tail is deliberately not part of
   * the fingerprint; every replayed window is checked row for row instead. */
  firstSampleDate: string | null
  /** Names that produced samples in the dataset build, sorted. A resume whose
   * fetches lost or gained a name cannot reuse the windows (the rows differ),
   * and this field names the difference instead of leaving a row-count
   * mismatch on window 0 to explain it. */
  usableTickers: string[]
  /** One hash over the settings that decide what is measured: the sorted
   * ticker list, the feature list, the momentum baseline, the correlation,
   * the window days, the burn-in, the embargo, the ETF exclusion and the
   * frozen-hyperparameter choice. The same settings are also stored as plain
   * fields above so a mismatch can be named; the hash is the one-line
   * summary of them. */
  settingsHash: string
  /** Fundamentals coverage of the built dataset, in plain numbers, so a
   * resume whose backend answered fewer SEC lookups is refused with the two
   * percentages side by side instead of an unexplained row hash. */
  fundamentals: { tickersWithFundamentals: number; sampleCoveragePct: number }
  /** Content hash of the rows themselves. */
  samples: SampleContentHash
}

/** The settings half of the fingerprint, hashed. Exported so the CLI and the
 * tests build the fingerprint the same way. */
export function hashRunSettings(settings: {
  tickers: readonly string[]
  featureNames: readonly string[]
  momentumBaseline: MomentumBaselineDefinition
  correlation: CorrelationKind
  rule: WindowRule
  excludeEtfs: boolean
  freezeHparams: boolean
}): string {
  const canonical = JSON.stringify({
    tickers: [...settings.tickers].sort(),
    featureNames: [...settings.featureNames],
    momentumBaseline: settings.momentumBaseline,
    correlation: settings.correlation,
    windowDays: settings.rule.stepTradingDays,
    burnInYears: settings.rule.burnInYears,
    embargoTradingDays: settings.rule.embargoTradingDays,
    excludeEtfs: settings.excludeEtfs,
    freezeHparams: settings.freezeHparams,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Calendar days of rows left out of the sample hash at the tail. A fetch
 * made later the same day, or the next day, can add one more bar per name,
 * which can add one more row at the tail of a name's sample grid (rows are
 * formed every tenth bar, so a new row lands within ten trading days of the
 * previous last one) and shift the cross-sectional demeaning on that date.
 * Thirty calendar days covers that with room to spare. */
export const SAMPLE_HASH_TAIL_MARGIN_DAYS = 30

/** The date the sample hash of a new checkpoint runs through: the last
 * sample date minus the tail margin. Null when there are no rows. */
export function sampleHashThroughDate(samples: readonly HistoricalSample[]): string | null {
  let last: string | null = null
  for (const sample of samples) {
    if (last == null || sample.asOf > last) last = sample.asOf
  }
  if (last == null) return null
  const [year, month, day] = last.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day - SAMPLE_HASH_TAIL_MARGIN_DAYS)).toISOString().slice(0, 10)
}

/**
 * Hash every row dated on or before `throughDate`. One pass to pick the
 * rows, one sort by (ticker, date) so the build order cannot matter, one
 * streaming hash. About a second per million rows.
 */
export function hashSampleContent(samples: readonly HistoricalSample[], throughDate: string | null): SampleContentHash {
  const covered = throughDate == null ? [] : samples.filter((sample) => sample.asOf <= throughDate)
  covered.sort((left, right) => (left.ticker < right.ticker ? -1 : left.ticker > right.ticker ? 1 : left.asOf < right.asOf ? -1 : left.asOf > right.asOf ? 1 : 0))
  const hash = createHash('sha256')
  // Numbers are written with their full precision (String(number) round-trips
  // exactly), and a missing market cap is written as NaN, which is itself
  // information: it says no filed cap was available for that row.
  for (const sample of covered) {
    hash.update(
      `${sample.ticker}|${sample.asOf}|${sample.forwardReturn5d}|${sample.forwardReturn20d}|${sample.forwardReturn60d}|${sample.forwardReturn120d}` +
        `|${sample.forwardReturn5dRel}|${sample.forwardReturn20dRel}|${sample.forwardReturn60dRel}|${sample.forwardReturn120dRel}` +
        `|${sample.labelEnd5d}|${sample.labelEnd20d}|${sample.labelEnd60d}|${sample.labelEnd120d}` +
        `|${sample.logMarketCap}|${sample.pitFundamentalsObserved === true ? 'sec' : 'none'}\n`,
    )
  }
  return { throughDate, count: covered.length, sha256: hash.digest('hex') }
}

/** The fingerprint a checkpoint directory was created with, or null when the
 * directory has no run.json yet. A resume reads this first so it can hash
 * its rows through the same date the original run did. */
export function readStoredFingerprint(dir: string): CheckpointFingerprint | null {
  const runPath = join(dir, 'run.json')
  if (!existsSync(runPath)) return null
  return decodeJson<{ fingerprint: CheckpointFingerprint }>(readFileSync(runPath, 'utf8')).fingerprint
}

/* -------------------------------------------------------------------------
   The lock file
   -------------------------------------------------------------------------
   Two runs writing windows.jsonl at once would interleave lines from two
   loops and neither could be trusted. The first run to open the directory
   writes lock.json with its process id; a second run on the same machine
   sees a live process and refuses. A lock whose process is gone (the run was
   killed, the machine restarted) is stale and is taken over, and the caller
   is told so. A lock written on another machine cannot be checked and is
   treated as live; delete it by hand once that run is known to be dead.
   ------------------------------------------------------------------------- */

export type CheckpointLock = {
  pid: number
  hostname: string
  startedAt: string
  command: string
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission denied means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(path: string): CheckpointLock | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CheckpointLock>
    if (typeof parsed.pid !== 'number' || typeof parsed.hostname !== 'string') return null
    return { pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt ?? 'unknown', command: parsed.command ?? '' }
  } catch {
    return null
  }
}

/** Take the lock, reclaiming a stale one. Returns the stale lock that was
 * taken over, if any, so the caller can say so. */
function acquireLock(path: string): CheckpointLock | null {
  let reclaimed: CheckpointLock | null = null
  const mine: CheckpointLock = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), command: process.argv.slice(1).join(' ') }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' creates the file only if it does not exist, so two processes
      // racing for a free lock cannot both believe they won.
      writeFileSync(path, JSON.stringify(mine, null, 2), { flag: 'wx' })
      return reclaimed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const held = readLock(path)
    if (held == null) {
      // Unreadable: a crash mid-write. Nothing live can own it.
      unlinkSync(path)
      continue
    }
    if (held.pid === process.pid && held.hostname === mine.hostname) return null
    if (held.hostname !== mine.hostname) {
      throw new Error(
        `Checkpoint lock ${path} was written on another machine (${held.hostname}, pid ${held.pid}, started ${held.startedAt}) and cannot be checked from here. ` +
          'If that run is known to be dead, delete lock.json and start again.',
      )
    }
    if (processIsAlive(held.pid)) {
      throw new Error(
        `Checkpoint directory is in use by another run (pid ${held.pid}, started ${held.startedAt}${held.command ? `, command: ${held.command}` : ''}). ` +
          'Wait for it to finish, or use a different --checkpoint directory.',
      )
    }
    reclaimed = held
    unlinkSync(path)
  }
  throw new Error(`Could not take the checkpoint lock ${path}: another run kept taking it first.`)
}

/** Give the lock back. Safe to call more than once and when the lock is not ours. */
export function releaseCheckpoint(checkpoint: Pick<Checkpoint, 'lockPath'>): void {
  const held = readLock(checkpoint.lockPath)
  if (held && held.pid === process.pid && held.hostname === hostname()) {
    try {
      unlinkSync(checkpoint.lockPath)
    } catch {
      /* already gone */
    }
  }
}

export type CheckpointLine = {
  index: number
  testStartDate: string
  testEndDate: string
  testRowCount: number
  testNameCount: number
  /** False when the core skipped the window (too few rows). Recorded so a
   * resume skips it too instead of trying again. */
  scored: boolean
  trainSize: number | null
  step: WalkForwardResult | null
  completedAt: string
}

export type Checkpoint = {
  dir: string
  windowsPath: string
  runPath: string
  resumePath: string
  lockPath: string
  fingerprint: CheckpointFingerprint
  /** Finished windows by window index, read from windows.jsonl. */
  completed: Map<number, CheckpointLine>
  /** True when the last line of windows.jsonl was cut off mid-write (the
   * previous run died while writing it). That line is ignored and the
   * window is scored again. */
  droppedPartialLine: boolean
  /** The stale lock this open took over, when the previous run holding the
   * directory is no longer running; null when the directory was free. */
  lockReclaimed: CheckpointLock | null
}

/** What each fingerprint field means when it differs, in plain words, so the
 * refusal message explains itself. */
const FINGERPRINT_FIELD_HINTS: Partial<Record<keyof CheckpointFingerprint, string>> = {
  samples: 'the dataset rows differ (a different set of names, dates, forward returns or fundamentals coverage), so the finished windows were cut from different data',
  settingsHash: 'one or more of the run settings listed above changed',
  fundamentals: 'the backend answered a different share of the SEC fundamentals lookups this time',
  usableTickers: 'the price fetches produced a different set of usable names',
  firstSampleDate: 'the earliest row moved, which shifts every window',
}

export function fingerprintDifferences(stored: CheckpointFingerprint, current: CheckpointFingerprint): string[] {
  const keys = new Set([...Object.keys(stored), ...Object.keys(current)]) as Set<keyof CheckpointFingerprint>
  const differences: string[] = []
  for (const key of keys) {
    const before = stored[key]
    const now = current[key]
    const left = JSON.stringify(before)
    const right = JSON.stringify(now)
    if (left === right) continue
    const hint = FINGERPRINT_FIELD_HINTS[key]
    if (key === 'samples') {
      const was = before as SampleContentHash | undefined
      const is = now as SampleContentHash | undefined
      differences.push(
        `samples: checkpoint hashed ${was?.count ?? 'n/a'} rows through ${was?.throughDate ?? 'n/a'} as ${was?.sha256.slice(0, 12) ?? 'n/a'}..., ` +
          `now ${is?.count ?? 'n/a'} rows through ${is?.throughDate ?? 'n/a'} hash ${is?.sha256.slice(0, 12) ?? 'n/a'}... (${hint})`,
      )
      continue
    }
    if (key === 'fundamentals') {
      const was = before as CheckpointFingerprint['fundamentals'] | undefined
      const is = now as CheckpointFingerprint['fundamentals'] | undefined
      differences.push(
        `fundamentals: checkpoint had ${was?.tickersWithFundamentals ?? 'n/a'} names with SEC fundamentals covering ${was?.sampleCoveragePct ?? 'n/a'}% of rows, ` +
          `now ${is?.tickersWithFundamentals ?? 'n/a'} names covering ${is?.sampleCoveragePct ?? 'n/a'}% (${hint})`,
      )
      continue
    }
    // A list of names (tickers, features) is reported as what went missing
    // and what is new, which is readable at a thousand names where two
    // whole arrays are not.
    if (Array.isArray(before) && Array.isArray(now) && before.every((item) => typeof item === 'string') && now.every((item) => typeof item === 'string')) {
      const beforeSet = new Set(before as string[])
      const nowSet = new Set(now as string[])
      const missing = (before as string[]).filter((item) => !nowSet.has(item))
      const added = (now as string[]).filter((item) => !beforeSet.has(item))
      const parts: string[] = []
      if (missing.length) parts.push(`missing now: ${missing.join(', ')}`)
      if (added.length) parts.push(`new now: ${added.join(', ')}`)
      if (parts.length === 0) parts.push('same names in a different order')
      differences.push(`${key}: ${parts.join('; ')}${hint ? ` (${hint})` : ''}`)
      continue
    }
    differences.push(`${key}: checkpoint=${left} now=${right}${hint ? ` (${hint})` : ''}`)
  }
  return differences
}

/**
 * Open (or create) a checkpoint directory for this run. Refuses to resume a
 * checkpoint written by a differently configured run, or from different
 * data, because mixing windows from two configurations would be a wrong
 * answer that looks like a right one. Takes the directory's lock first, so
 * a second run cannot open it while this one holds it; the caller releases
 * the lock with releaseCheckpoint when it is done.
 */
export function openCheckpoint(dir: string, fingerprint: CheckpointFingerprint): Checkpoint {
  mkdirSync(dir, { recursive: true })
  const runPath = join(dir, 'run.json')
  const windowsPath = join(dir, 'windows.jsonl')
  const resumePath = join(dir, 'resume.json')
  const lockPath = join(dir, 'lock.json')
  const lockReclaimed = acquireLock(lockPath)
  const giveBack = () => releaseCheckpoint({ lockPath })
  if (existsSync(runPath)) {
    const stored = readStoredFingerprint(dir)!
    if ((stored.schemaVersion as number) !== fingerprint.schemaVersion) {
      giveBack()
      throw new Error(
        `Checkpoint ${dir} was written with fingerprint schema ${stored.schemaVersion}, and this runner writes schema ${fingerprint.schemaVersion}: ` +
          'the older record does not carry the row hash a resume is checked against. Use a fresh --checkpoint directory.',
      )
    }
    const differences = fingerprintDifferences(stored, fingerprint)
    if (differences.length > 0) {
      giveBack()
      throw new Error(
        `Checkpoint ${dir} was written by a different run configuration or from different data and cannot be resumed:\n  ` +
          differences.join('\n  ') +
          '\nUse a fresh --checkpoint directory for this configuration.',
      )
    }
  } else {
    writeFileSync(runPath, encodeJson({ createdAt: new Date().toISOString(), fingerprint }))
  }

  const completed = new Map<number, CheckpointLine>()
  let droppedPartialLine = false
  if (existsSync(windowsPath)) {
    const lines = readFileSync(windowsPath, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      let parsed: CheckpointLine
      try {
        parsed = decodeJson<CheckpointLine>(line)
      } catch (error) {
        const isLastNonEmpty = lines.slice(i + 1).every((rest) => rest.trim().length === 0)
        if (isLastNonEmpty) {
          droppedPartialLine = true
          break
        }
        giveBack()
        throw new Error(`Checkpoint ${windowsPath} is corrupt at line ${i + 1}: ${(error as Error).message}`)
      }
      completed.set(parsed.index, parsed)
    }
  }
  return { dir, windowsPath, runPath, resumePath, lockPath, fingerprint, completed, droppedPartialLine, lockReclaimed }
}

/** Append one finished window and refresh the resume marker. */
export function recordWindow(checkpoint: Checkpoint, window: CalendarWindow, step: WalkForwardResult | null): void {
  const line: CheckpointLine = {
    index: window.index,
    testStartDate: window.testStartDate,
    testEndDate: window.testEndDate,
    testRowCount: window.testRowCount,
    testNameCount: window.testNameCount,
    scored: step != null,
    trainSize: step?.trainSize ?? null,
    step,
    completedAt: new Date().toISOString(),
  }
  appendFileSync(checkpoint.windowsPath, encodeJson(line) + '\n')
  checkpoint.completed.set(window.index, line)
  // The marker is written to a temporary file and renamed into place so a
  // crash can never leave a half-written marker behind.
  const marker = {
    completedWindows: checkpoint.completed.size,
    lastCompletedIndex: window.index,
    lastTestEndDate: window.testEndDate,
    updatedAt: line.completedAt,
    note: 'windows.jsonl is the record; this file is a summary of it.',
  }
  const temporaryPath = `${checkpoint.resumePath}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(marker, null, 2))
  renameSync(temporaryPath, checkpoint.resumePath)
}

/* =========================================================================
   Warming the price history before the dataset build
   -------------------------------------------------------------------------
   The dataset builder fetches each name once and moves on when the fetch
   fails, so a proxy that is still warming up silently drops names from the
   universe. Two runs of the same command can then build different datasets,
   and a checkpoint written by the luckier run cannot be resumed by the other
   (the smoke test on 2026-09-16 lost eight names on a cold backend and four
   different ones on the retry). This fetches every name first, retrying a
   bounded number of times; the in-process cache never remembers an empty
   result, so a retry is a real second attempt, and the backend keeps what it
   fetched on disk for the builder's own pass.
   ========================================================================= */

export async function warmDailyBars(
  tickers: readonly string[],
  fetcher: (ticker: string) => Promise<ArrayLike<unknown>>,
  options: {
    attempts?: number
    pauseMs?: number
    onProgress?: (done: number, total: number, ticker: string) => void
  } = {},
): Promise<{ usable: string[]; failed: string[]; retries: number }> {
  const attempts = Math.max(1, options.attempts ?? 4)
  const pauseMs = options.pauseMs ?? 1500
  const usable: string[] = []
  const failed: string[] = []
  let retries = 0
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    let bars = 0
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        retries++
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
      try {
        bars = (await fetcher(ticker)).length
      } catch {
        bars = 0
      }
      if (bars > 0) break
    }
    ;(bars > 0 ? usable : failed).push(ticker)
    options.onProgress?.(i + 1, tickers.length, ticker)
  }
  return { usable, failed, retries }
}

/* =========================================================================
   One health probe before anything is fetched
   -------------------------------------------------------------------------
   Every price and fundamentals request goes through the backend on port
   8787. When it is down, each request waits out its own timeout before
   failing, and with four attempts per name a thousand-name universe burns
   more than an hour before the run can say so. One request to /health up
   front turns that into an immediate, plain answer.
   ========================================================================= */

export async function probeBackendHealth(
  base: string,
  options: { timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<{ ok: boolean; detail: string }> {
  const timeoutMs = options.timeoutMs ?? 5000
  const fetcher = options.fetcher ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(`${base}/health`, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) return { ok: false, detail: `${base}/health answered HTTP ${response.status}` }
    const body = (await response.json()) as { ok?: unknown; cacheDirectory?: unknown }
    if (body?.ok !== true) return { ok: false, detail: `${base}/health answered without ok: true` }
    return { ok: true, detail: `${base}/health ok${typeof body.cacheDirectory === 'string' ? ` · cache ${body.cacheDirectory}` : ''}` }
  } catch (error) {
    const reason = controller.signal.aborted ? `no answer within ${timeoutMs} ms` : (error as Error).message
    return { ok: false, detail: `${base}/health unreachable (${reason})` }
  } finally {
    clearTimeout(timer)
  }
}

/* =========================================================================
   Warming the SEC fundamentals before the dataset build
   -------------------------------------------------------------------------
   The dataset builder asks the backend for each name's filing history once.
   A request that times out and a company that files nothing used to look
   the same to it (no timeline either way), so a cold backend quietly built
   rows with no fundamentals for names that have them. The client now tells
   the two apart (see fetchFundamentalsTimeline in historicalBacktest.ts),
   and this warms every name first, retrying only the requests that failed;
   a successful timeline stays cached in the module for the builder's pass.
   The pre-registered run trains on price-only columns, so a name with no
   fundamentals still scores there; what this protects is the cost tier,
   the survivorship cohorts, and every other run that uses the fund_ columns.
   ========================================================================= */

export type FundamentalsWarmOutcome = 'timeline' | 'not-a-filer' | 'failed'

export async function warmFundamentals(
  tickers: readonly string[],
  fetcher: (ticker: string) => Promise<FundamentalsWarmOutcome>,
  options: {
    attempts?: number
    pauseMs?: number
    onProgress?: (done: number, total: number, ticker: string) => void
  } = {},
): Promise<{ withTimeline: string[]; notFilers: string[]; failed: string[]; retries: number }> {
  const attempts = Math.max(1, options.attempts ?? 4)
  const pauseMs = options.pauseMs ?? 1500
  const withTimeline: string[] = []
  const notFilers: string[] = []
  const failed: string[] = []
  let retries = 0
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    let outcome: FundamentalsWarmOutcome = 'failed'
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        retries++
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
      try {
        outcome = await fetcher(ticker)
      } catch {
        outcome = 'failed'
      }
      if (outcome !== 'failed') break
    }
    ;(outcome === 'timeline' ? withTimeline : outcome === 'not-a-filer' ? notFilers : failed).push(ticker)
    options.onProgress?.(i + 1, tickers.length, ticker)
  }
  return { withTimeline, notFilers, failed, retries }
}

/* =========================================================================
   How much memory the run will need
   -------------------------------------------------------------------------
   The in-process bar cache in marketData.ts keeps every name's 40-year
   history for the life of the process, the dataset holds every row twice
   (the full column set and the pruned copy), and every scored window keeps
   its per-row detail. None of that is released, so memory grows with the
   number of names. Two smoke runs on 2026-09-16 (40 years, 359 windows,
   price-only columns, per-row detail kept) peaked at 355 MB with 15 names
   and 446 MB with 25 names. The line through those two points gives a
   fixed cost and a cost per name; the projection below extends it to the
   requested universe, adds a quarter for headroom, and rounds up to a whole
   gigabyte for the node flag. It reads peak resident memory, which is a
   little more than the JavaScript heap the flag governs, so it errs high.
   ========================================================================= */

export const SMOKE_MEMORY_POINTS = [
  { names: 15, peakRssMb: 355 },
  { names: 25, peakRssMb: 446 },
] as const

export type HeapProjection = {
  perNameMb: number
  baseMb: number
  namesPlanned: number
  projectedMb: number
  heapCeilingMb: number
  /** The --max-old-space-size value to pass: projected need plus a quarter, rounded up to a whole gigabyte. */
  recommendedMb: number
  flag: string
  exceedsCeiling: boolean
}

export function projectHeapNeed(namesPlanned: number, heapCeilingMb: number): HeapProjection {
  const [low, high] = SMOKE_MEMORY_POINTS
  const perNameMb = (high.peakRssMb - low.peakRssMb) / (high.names - low.names)
  const baseMb = low.peakRssMb - low.names * perNameMb
  const projectedMb = Math.round(baseMb + namesPlanned * perNameMb)
  const recommendedMb = Math.max(1024, Math.ceil((projectedMb * 1.25) / 1024) * 1024)
  return {
    perNameMb,
    baseMb,
    namesPlanned,
    projectedMb,
    heapCeilingMb,
    recommendedMb,
    flag: `--max-old-space-size=${recommendedMb}`,
    exceedsCeiling: projectedMb > heapCeilingMb,
  }
}

/* =========================================================================
   The window loop
   ========================================================================= */

export type StepOptions = NonNullable<Parameters<typeof walkForwardStep>[2]>

export type WindowProgress = {
  window: CalendarWindow
  step: WalkForwardResult | null
  /** True when the window came from the checkpoint instead of being scored now. */
  replayed: boolean
  done: number
  total: number
  stepsSoFar: WalkForwardResult[]
}

/** Thrown by the loop when a test asks it to stop early, to stand in for a crash. */
export class WindowLoopStopped extends Error {
  readonly windowsComputed: number
  constructor(windowsComputed: number) {
    super(`window loop stopped on request after ${windowsComputed} freshly scored window(s)`)
    this.windowsComputed = windowsComputed
  }
}

/**
 * Score every window in order, exactly as runWalkForwardBacktest does,
 * writing each result to the checkpoint as it finishes and reusing any
 * window the checkpoint already holds. A replayed window must match the
 * freshly cut window on its dates, its test rows and names, and its
 * training-row count; a mismatch means the data changed since the
 * checkpoint was written, and the loop refuses rather than mixing the two.
 */
export function runCheckpointedWindows(args: {
  sorted: IndexedSample[]
  windows: CalendarWindow[]
  checkpoint: Checkpoint | null
  stepOptions: StepOptions
  onWindow?: (progress: WindowProgress) => void
  /** Test hook: throw WindowLoopStopped after this many freshly scored windows. */
  stopAfterFreshWindows?: number
}): { steps: WalkForwardResult[]; replayedWindows: number; computedWindows: number } {
  const steps: WalkForwardResult[] = []
  let replayedWindows = 0
  let computedWindows = 0
  for (const window of args.windows) {
    const stored = args.checkpoint?.completed.get(window.index)
    let step: WalkForwardResult | null
    let replayed = false
    if (stored) {
      const expectedTrainSize = stored.scored ? windowRows(args.sorted, window).train.length : null
      const mismatches: string[] = []
      if (stored.testStartDate !== window.testStartDate) mismatches.push(`start ${stored.testStartDate} vs ${window.testStartDate}`)
      if (stored.testEndDate !== window.testEndDate) mismatches.push(`end ${stored.testEndDate} vs ${window.testEndDate}`)
      if (stored.testRowCount !== window.testRowCount) mismatches.push(`test rows ${stored.testRowCount} vs ${window.testRowCount}`)
      if (stored.testNameCount !== window.testNameCount) mismatches.push(`names ${stored.testNameCount} vs ${window.testNameCount}`)
      if (stored.scored && stored.trainSize !== expectedTrainSize) mismatches.push(`training rows ${stored.trainSize} vs ${expectedTrainSize}`)
      if (mismatches.length > 0) {
        throw new Error(
          `Checkpoint window ${window.index} does not match the rebuilt dataset (${mismatches.join('; ')}). ` +
            'The data changed since the checkpoint was written; start a fresh --checkpoint directory.',
        )
      }
      step = stored.step
      replayed = true
      replayedWindows++
    } else {
      step = walkForwardStep(args.sorted, window, args.stepOptions)
      if (args.checkpoint) recordWindow(args.checkpoint, window, step)
      computedWindows++
    }
    if (step) steps.push(step)
    args.onWindow?.({ window, step, replayed, done: replayedWindows + computedWindows, total: args.windows.length, stepsSoFar: steps })
    if (!replayed && args.stopAfterFreshWindows != null && computedWindows >= args.stopAfterFreshWindows) {
      throw new WindowLoopStopped(computedWindows)
    }
  }
  return { steps, replayedWindows, computedWindows }
}

/* =========================================================================
   The served models, trained by the core's own recipe
   -------------------------------------------------------------------------
   After its window loop, runWalkForwardBacktest trains the models that ship
   (the 20-day scorer, its five-member bag, the horizon and interval models)
   on every row, plus two single-split diagnostics. None of that depends on
   the windows. To reuse that recipe unchanged without re-scoring the windows
   the checkpointed loop already scored, this asks the core for a single test
   window spanning every trading day after the burn-in. The core scores that
   one window (about the cost of one ordinary window) and then trains the
   served models exactly as it always does. Only the served models, the
   horizon bundles and the serving-consistency reading are taken from that
   result; every window-level number comes from the checkpointed loop.
   ========================================================================= */

/** Same rule as the core's private addYearsIso: whole years keep the month
 * and day, a fractional part is added as days. */
function addYearsIso(isoDate: string, years: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const wholeYears = Math.floor(years)
  const extraDays = Math.round((years - wholeYears) * 365.25)
  return new Date(Date.UTC(year + wholeYears, month - 1, day + extraDays)).toISOString().slice(0, 10)
}

export function trainFinalModelsWithCore(args: {
  samples: HistoricalSample[]
  rule: WindowRule
  tradingDates?: readonly string[]
  modelOptions: { numTrees: number; depth: number; learningRate: number }
  baselineMomentumFeatureIndex?: number
  momentumBaseline?: MomentumBaselineDefinition
  correlation?: CorrelationKind
}): FullBacktestResult {
  const dateSet = new Set<string>(args.tradingDates ?? [])
  let firstSampleDate: string | null = null
  for (const sample of args.samples) {
    dateSet.add(sample.asOf)
    if (firstSampleDate == null || sample.asOf < firstSampleDate) firstSampleDate = sample.asOf
  }
  if (firstSampleDate == null) throw new Error('No samples to train the served models on.')
  const dates = [...dateSet].sort()
  const start = dates.findIndex((date) => date >= addYearsIso(firstSampleDate, args.rule.burnInYears))
  if (start < 0) throw new Error('The burn-in reaches past the last trading day; no window can be cut.')
  const spanningWindowDays = dates.length - start
  const result = runWalkForwardBacktest(args.samples, {
    stepTradingDays: spanningWindowDays,
    burnInYears: args.rule.burnInYears,
    embargoTradingDays: args.rule.embargoTradingDays,
    tradingDates: args.tradingDates,
    modelOptions: args.modelOptions,
    baselineMomentumFeatureIndex: args.baselineMomentumFeatureIndex,
    momentumBaseline: args.momentumBaseline,
    correlation: args.correlation,
    captureTestDetails: false,
  })
  if (!result || result.windowSummary.windowsBuilt !== 1 || result.steps.length !== 1) {
    throw new Error(
      `Expected the core to cut exactly one spanning window of ${spanningWindowDays} trading days for the served models, ` +
        `got ${result ? `${result.windowSummary.windowsBuilt} built / ${result.steps.length} scored` : 'no result'}.`,
    )
  }
  return result
}

/* =========================================================================
   Putting the full result together from the checkpointed windows
   -------------------------------------------------------------------------
   This mirrors the tail of runWalkForwardBacktest line for line, so the
   numbers are the same ones the in-app worker would report. The test file
   checks that against the core on a fixture.
   ========================================================================= */

/** Same stream as the core's private deterministicRandom: xorshift32 seeded
 * from the measured series, so identical data gives identical intervals. */
function deterministicRandom(values: readonly number[], salt = 0): () => number {
  let state = (0x811c9dc5 ^ salt) >>> 0
  for (const value of values) {
    const token = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0x7fc00000
    state = Math.imul(state ^ token, 0x01000193) >>> 0
  }
  if (state === 0) state = 0x6d2b79f5
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/** Same moving-block bootstrap as the core's private blockBootstrapStat
 * (Kunsch 1989; Politis-Romano 1994). */
export function blockBootstrapStat(
  values: number[],
  statistic: (sample: number[]) => number,
  blockLen: number,
  iterations = 1000,
): ConfidenceInterval {
  const n = values.length
  if (n === 0) return { lower: 0, mean: 0, upper: 0 }
  const point = statistic(values)
  if (n <= blockLen) return { lower: point, mean: point, upper: point }
  const stats: number[] = []
  const random = deterministicRandom(values, iterations ^ blockLen)
  for (let it = 0; it < iterations; it++) {
    const resample: number[] = []
    while (resample.length < n) {
      const start = Math.floor(random() * (n - blockLen + 1))
      for (let k = 0; k < blockLen && resample.length < n; k++) {
        resample.push(values[start + k])
      }
    }
    stats.push(statistic(resample))
  }
  stats.sort((a, b) => a - b)
  return {
    lower: stats[Math.floor(0.025 * stats.length)],
    mean: point,
    upper: stats[Math.floor(0.975 * stats.length)],
  }
}

export function assembleFullResult(args: {
  sorted: IndexedSample[]
  windows: CalendarWindow[]
  rule: WindowRule
  steps: WalkForwardResult[]
  /** The core's result from trainFinalModelsWithCore: the served models come from here. */
  served: FullBacktestResult
  momentumBaseline: MomentumBaselineDefinition
  correlation: CorrelationKind
  horizonDays: number
  hyperparameterSelection: FullBacktestResult['hyperparameterSelection']
}): FullBacktestResult {
  const { steps, served, horizonDays } = args
  if (steps.length === 0) throw new Error('No scored windows to assemble a result from.')
  const windowSummary = summarizeCalendarWindows(args.sorted, args.windows, args.rule, steps.length)

  const mean = (key: keyof WalkForwardResult): number =>
    steps.reduce((sum, step) => sum + (step[key] as number), 0) / steps.length
  const meanFinite = (key: keyof WalkForwardResult): number => {
    const values = steps
      .map((step) => step[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return values.length === 0
      ? Number.NaN
      : values.reduce((sum, value) => sum + value, 0) / values.length
  }

  let runningCumReturn = 0
  let peak = 0
  let maxDD = 0
  for (const step of steps) {
    runningCumReturn += step.longShortReturnNet
    if (runningCumReturn > peak) peak = runningCumReturn
    const dd = peak - runningCumReturn
    if (dd > maxDD) maxDD = dd
  }

  const featureCount = steps[0]?.featureImportance.length ?? 0
  const meanFeatureImportance: number[] = new Array(featureCount).fill(0)
  for (const step of steps) {
    step.featureImportance.forEach((value, idx) => {
      meanFeatureImportance[idx] += value
    })
  }
  for (let f = 0; f < featureCount; f++) {
    meanFeatureImportance[f] /= steps.length
  }

  const stepNetReturns = steps.map((step) => step.longShortReturnNet)
  const meanOfArr = (s: number[]): number =>
    s.length === 0 ? 0 : s.reduce((a, b) => a + b, 0) / s.length
  const sharpeOf = (s: number[]): number => {
    if (s.length < 2) return 0
    const m = meanOfArr(s)
    const sd = Math.sqrt(s.reduce((a, v) => a + (v - m) ** 2, 0) / s.length)
    return sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR / horizonDays) : 0
  }
  const portfolioSharpe = sharpeOf(stepNetReturns)

  const evidenceBlockLength = measuredOverlapBlockLength(steps)
  const icCI = blockBootstrapStat(steps.map((step) => step.informationCoefficient), meanOfArr, evidenceBlockLength)
  const hitRateCI = blockBootstrapStat(steps.map((step) => step.hitRate), meanOfArr, evidenceBlockLength)
  const longShortReturnNetCI = blockBootstrapStat(stepNetReturns, meanOfArr, evidenceBlockLength)
  const longShortSharpeCI = blockBootstrapStat(stepNetReturns, sharpeOf, evidenceBlockLength)
  const coverageSteps = steps.filter((step) => step.intervalCoverage80 != null)
  const intervalCoverage80CI =
    coverageSteps.length > 0
      ? blockBootstrapStat(
          coverageSteps.map((step) => step.intervalCoverage80!),
          meanOfArr,
          measuredOverlapBlockLength(coverageSteps),
        )
      : undefined
  const intervalMeanWidthPct =
    coverageSteps.length > 0
      ? coverageSteps.reduce((sum, step) => sum + (step.intervalMeanWidthPct ?? 0), 0) /
        coverageSteps.length
      : undefined
  const baselineEvidence = computeBaselineEvidence(steps, 1000, {
    momentumBaseline: args.momentumBaseline,
    correlation: args.correlation,
  })

  return {
    steps,
    meanIC: mean('informationCoefficient'),
    meanSpearmanIC: mean('spearmanIc'),
    meanHitRate: mean('hitRate'),
    meanLongShortReturnGross: mean('longShortReturnGross'),
    meanLongShortReturnNet: mean('longShortReturnNet'),
    meanLongShortSharpe: portfolioSharpe,
    meanBaselineRandomIc: mean('baselineRandomIc'),
    meanBaselineMomentumIc: mean('baselineMomentumIc'),
    meanBaselineMomentum12to1Ic: meanFinite('baselineMomentum12to1Ic'),
    meanRidgeIc: meanFinite('ridgeIc'),
    meanBlendIc: meanFinite('blendIc'),
    gateMomentumBaseline: args.momentumBaseline,
    gateCorrelation: args.correlation,
    baselineEvidence,
    cumulativeReturn: runningCumReturn,
    maxDrawdown: maxDD,
    meanFeatureImportance,
    totalSamples: args.sorted.length,
    trainedModel: served.trainedModel,
    bag20: served.bag20,
    horizonBundles: served.horizonBundles,
    embargoDaysUsed: served.embargoDaysUsed,
    txCostBpsUsed: served.txCostBpsUsed,
    windowSummary,
    meanRealizedCostBps: mean('realizedCostBps'),
    icCI,
    hitRateCI,
    longShortReturnNetCI,
    longShortSharpeCI,
    intervalCoverage80CI,
    intervalMeanWidthPct,
    servingConsistentIC20d: served.servingConsistentIC20d,
    hyperparameters: served.hyperparameters,
    hyperparameterSelection: args.hyperparameterSelection,
  }
}

/* =========================================================================
   Required-windows arithmetic (docs/EVIDENCE_QUALITY.md, section 5)
   -------------------------------------------------------------------------
   The half-width of a bootstrap interval on a mean shrinks with the square
   root of the window count, so from a mean m, a half-width h and n windows,
   the lower bound reaches zero at n x (h / m)^2 windows. When the mean is
   not above zero no number of windows gets there, and the answer is "n/a".
   ========================================================================= */

export type RequiredWindows = {
  mean: number | null
  halfWidth: number | null
  windowsHave: number
  /** Whole windows needed for the lower bound to reach zero at the current
   * mean; null when the mean is not above zero or no interval exists. */
  windowsNeeded: number | null
  /** True when the lower bound is already above zero. */
  alreadyClear: boolean
}

export function requiredWindows(
  comparison: Pick<BaselineComparisonEvidence, 'ci95' | 'pairedStepCount'>,
): RequiredWindows {
  const ci = comparison.ci95
  if (!ci) {
    return { mean: null, halfWidth: null, windowsHave: comparison.pairedStepCount, windowsNeeded: null, alreadyClear: false }
  }
  const halfWidth = (ci.upper - ci.lower) / 2
  const alreadyClear = ci.lower > 0
  const windowsNeeded =
    ci.mean > 0 ? Math.ceil(comparison.pairedStepCount * (halfWidth / ci.mean) ** 2) : null
  return { mean: ci.mean, halfWidth, windowsHave: comparison.pairedStepCount, windowsNeeded, alreadyClear }
}

/* =========================================================================
   Holdout split (docs/EVIDENCE_QUALITY.md, section 4)
   -------------------------------------------------------------------------
   The saved artifact's samples start on 2012-07-20, so no feature screen or
   nested search has ever seen a window that starts earlier. Those earlier
   windows are the locked holdout; the gate intervals are reported on them
   alone and on every window.
   ========================================================================= */

export const HOLDOUT_CUTOFF_DATE = '2012-07-20'

export function holdoutWindows<T extends { testStartDate: string }>(steps: readonly T[]): T[] {
  return steps.filter((step) => step.testStartDate < HOLDOUT_CUTOFF_DATE)
}

/* =========================================================================
   Exchange-traded funds in the universe
   -------------------------------------------------------------------------
   The flag that says which names are funds lives in the Dart universe files
   (lib/src/data/expanded_symbol_universe.dart and default_symbol_universe.dart)
   as `isEtf: true` on a bucket of symbols. The backend's /decision/universe
   route re-exports it as assetType, but only for names that already have
   price history in its store, so it is not a dependable list. The CLI reads
   the flag straight from the two files when the repository is present. When
   it is not, it falls back to the two contiguous blocks of funds inside
   DEFAULT_BACKTEST_TICKERS (the eight index and sector funds after the REIT
   block, and the long catalog block from IVV through QAT). On 2026-09-16 the
   two sources agreed exactly: 286 names either way.
   ========================================================================= */

/** Every symbol inside a `DefaultSymbolBucket(... isEtf: true, symbols: [...])`. */
export function parseDartEtfSymbols(source: string): Set<string> {
  const symbols = new Set<string>()
  for (const bucket of source.split('DefaultSymbolBucket(').slice(1)) {
    if (!/isEtf:\s*true/.test(bucket)) continue
    const list = bucket.match(/symbols:\s*\[([^\]]*)\]/)
    if (!list) continue
    for (const quoted of list[1].matchAll(/'([^']+)'/g)) symbols.add(quoted[1].trim().toUpperCase())
  }
  return symbols
}

/** The two fund blocks inside DEFAULT_BACKTEST_TICKERS, located by their
 * first and last symbols. Throws if an anchor is missing, so a reordered
 * list can never silently produce an empty exclusion. */
export function etfBlocksInDefaultTickers(tickers: readonly string[] = DEFAULT_BACKTEST_TICKERS): string[] {
  const block = (first: string, last: string): string[] => {
    const start = tickers.indexOf(first)
    const end = tickers.indexOf(last)
    if (start < 0 || end < start) throw new Error(`ETF block anchors ${first}..${last} not found in the ticker list.`)
    return tickers.slice(start, end + 1)
  }
  return [...block('SPY', 'XLV'), ...block('IVV', 'QAT')]
}

export type EtfUniverse = {
  symbols: Set<string>
  source: 'dart-universe-isEtf-flag' | 'default-ticker-etf-blocks'
  /** Names flagged in the Dart files, before intersecting with any ticker list; null on fallback. */
  dartFlaggedCount: number | null
  blockCount: number
  /** Names the two sources disagree on, within DEFAULT_BACKTEST_TICKERS. Empty when they agree. */
  disagreements: string[]
}

export function resolveEtfUniverse(dartDataDir: string | null): EtfUniverse {
  const blocks = etfBlocksInDefaultTickers()
  const files = ['expanded_symbol_universe.dart', 'default_symbol_universe.dart']
  const dartFiles = dartDataDir == null ? [] : files.map((name) => join(dartDataDir, name)).filter((path) => existsSync(path))
  if (dartFiles.length !== files.length) {
    return {
      symbols: new Set(blocks),
      source: 'default-ticker-etf-blocks',
      dartFlaggedCount: null,
      blockCount: blocks.length,
      disagreements: [],
    }
  }
  const flagged = new Set<string>()
  for (const path of dartFiles) {
    for (const symbol of parseDartEtfSymbols(readFileSync(path, 'utf8'))) flagged.add(symbol)
  }
  const blockSet = new Set(blocks)
  const flaggedInDefault = DEFAULT_BACKTEST_TICKERS.filter((ticker) => flagged.has(ticker))
  const disagreements = [
    ...flaggedInDefault.filter((ticker) => !blockSet.has(ticker)),
    ...blocks.filter((ticker) => !flagged.has(ticker)),
  ]
  return {
    symbols: flagged,
    source: 'dart-universe-isEtf-flag',
    dartFlaggedCount: flagged.size,
    blockCount: blocks.length,
    disagreements,
  }
}

/* =========================================================================
   What the artifact records about the run
   -------------------------------------------------------------------------
   Written into datasetProvenance.preRegisteredRun by the CLI. Every field is
   optional on the artifact, so the serving validator (which checks named
   provenance keys only) accepts artifacts with or without it.
   ========================================================================= */

export type PreRegisteredRunProvenance = {
  schemaVersion: 1
  flags: Record<string, string | number | boolean>
  universe: {
    requested: number
    etfsExcluded: number
    etfSource: EtfUniverse['source']
    trained: number
  }
  windows: {
    rule: WindowRule
    built: number
    scored: number
    namesPerWindow: { min: number; median: number; max: number }
    firstTestDate: string | null
    lastTestDate: string | null
    measuredBlockLength: number | null
  }
  gate: { correlation: CorrelationKind; momentumBaseline: MomentumBaselineDefinition }
  requiredWindows: { random: RequiredWindows; momentum: RequiredWindows }
  holdout: {
    cutoffDate: string
    windowsBefore: number
    windowsAll: number
    random: BaselineComparisonEvidence | null
    momentum: BaselineComparisonEvidence | null
  }
  checkpoint: { dir: string; replayedWindows: number; computedWindows: number } | null
  /** What the run went without. Under the default (--allow-missing off) a
   * run aborts instead of recording anything here, so these lists are only
   * ever non-empty on a run that was told to proceed. */
  missing?: {
    allowMissing: boolean
    /** Names whose price history could not be fetched after the retries, in
     * the warm-up or in the dataset build. The universe narrowed by these. */
    droppedNames: string[]
    /** Names whose SEC fundamentals request failed (timed out or errored)
     * after the retries; their rows carry no fundamentals. Names the backend
     * says file nothing are not listed here. */
    fundamentalsFetchFailures: string[]
    /** True when SPY history was unavailable and every window was labeled
     * "unknown" in the regime table. */
    regimeHistoryMissing: boolean
  }
  /** The memory reading the run started with and the peak it reached. */
  memory?: { heapCeilingMb: number; projectedMb: number; recommendedFlag: string; peakRssMb: number }
}
