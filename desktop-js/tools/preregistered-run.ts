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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BACKTEST_TICKERS,
  computeBaselineEvidence,
  measuredOverlapBlockLength,
  planUniverseFetch,
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
  type UniverseAttrition,
  type WalkForwardResult,
  type WindowRule,
} from '../src/data/historicalBacktest'
import { normalizeYahooSymbol } from '../src/data/marketData'
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
                    the windows were cut from). A resume must match it. It
                    also holds the universe record (the rename map, the
                    excluded names with dates and reasons, the stubs the
                    warm-up found, the attrition sentence), written at run
                    start before any fetch, so the record survives a
                    --persist that a blocking gate refuses.
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
  const stored = readRunRecord(join(dir, 'run.json'))
  return (stored.fingerprint as CheckpointFingerprint | undefined) ?? null
}

/** Everything run.json holds, or an empty object when there is no file yet.
 * The file is small and rewritten whole, through a temporary file, so a
 * crash mid-write can never leave a half-written record behind. */
function readRunRecord(runPath: string): Record<string, unknown> {
  if (!existsSync(runPath)) return {}
  return decodeJson<Record<string, unknown>>(readFileSync(runPath, 'utf8'))
}

function writeRunRecord(runPath: string, record: Record<string, unknown>): void {
  const temporaryPath = `${runPath}.tmp`
  writeFileSync(temporaryPath, encodeJson(record))
  renameSync(temporaryPath, runPath)
}

/* =========================================================================
   The universe record in run.json
   -------------------------------------------------------------------------
   The rename map, the excluded names with their dates and reasons, the
   stubs the warm-up found and the attrition sentence used to exist only on
   stdout and in the persisted artifact. --persist is fail-closed (a blocking
   gate refuses it), so an overnight run could end with no durable record of
   which registered names were set aside or fetched under another symbol.
   The CLI writes this block into the checkpoint's run.json at run start,
   before any fetch, and again after the warm-up with the stubs filled in;
   openCheckpoint keeps it when it adds the fingerprint. It is a record, not
   part of the fingerprint: a resume is still checked on the tickers and the
   rows, and a resumed run rewrites the record with its own (identical)
   plan. It is written before the directory's lock is taken, which is safe
   because two runs on one directory with different plans cannot both get
   past openCheckpoint, and two with the same plan write the same record.
   ========================================================================= */

export type CheckpointUniverseRecord = {
  recordedAt: string
  /** The registered names in the run's order (the --limit prefix when one
   * was given): the names fetched plus the names set aside. */
  registered: string[]
  /** Registered names fetched under a successor symbol; the sample keeps
   * the original symbol. */
  renames: Array<{ original: string; fetchedAs: string; effectiveDate: string; note: string }>
  /** Registered names set aside before any fetch, each with its last
   * trading day, the reason, the evidence behind it, and (for a symbol
   * since handed to another company) who holds it now. */
  excluded: Array<{ ticker: string; delistingDate: string | null; reason: string; evidence: string; recycledBy?: string }>
  /** Names the warm-up found served as stubs (classifyStubSeries). Empty
   * until the warm-up has run; the CLI rewrites the record after it. */
  stubs: StubSeries[]
  /** The excluded names as a share of the registered names, in the words
   * the run prints and the artifact stores. */
  attrition: UniverseAttrition
  /** The identity check's outcome (checkIdentity against
   * tools/registered_identity.json): the one-line summary and every line
   * that was not a plain match. Absent until the warm-up has run. */
  identity?: { snapshotDate: string; ledgerSha256?: string; summary: string; lines: string[] }
}

/** Write (or rewrite) the universe record into <dir>/run.json, keeping
 * whatever else the file already holds (the fingerprint, on a resume). */
export function recordUniverseInCheckpoint(dir: string, universe: CheckpointUniverseRecord): void {
  mkdirSync(dir, { recursive: true })
  const runPath = join(dir, 'run.json')
  const existing = readRunRecord(runPath)
  writeRunRecord(runPath, { createdAt: new Date().toISOString(), ...existing, universe })
}

/** The universe record a checkpoint holds, or null when none was written. */
export function readCheckpointUniverse(dir: string): CheckpointUniverseRecord | null {
  const stored = readRunRecord(join(dir, 'run.json'))
  return (stored.universe as CheckpointUniverseRecord | undefined) ?? null
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
  const stored = readStoredFingerprint(dir)
  if (stored != null) {
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
    // A run.json without a fingerprint holds only the universe record the
    // CLI wrote at run start; the fingerprint joins it and the record stays.
    writeRunRecord(runPath, { createdAt: new Date().toISOString(), ...readRunRecord(runPath), fingerprint })
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

   Stubs. Yahoo does not always answer 404 for a name that left the market.
   For some it answers HTTP 200 with a STUB in place of the history: a
   single bar dated at the delisting (EA, IAS, CPRX, NSA), a series that
   starts on 2026-07-17 (AVB, WBS, CRNX, EQR: a batch of departed names was
   collapsed to that day), or, after a bankruptcy that cancelled the old
   shares, only the new security's bars (WOLF, from 2025-09-29). A stub has
   "some bars", so it passed the has-bars test here, and it was then
   dropped in the dataset build as "below history threshold" without a
   name on the console and without being counted as attrition (EA did this
   in the 200-name smoke on 2026-09-16). classifyStubSeries catches it at
   the warm-up with two rules, and the CLI treats a stub like a fetch
   failure: the run stops with the names printed unless --allow-missing is
   given, in which case the stub is recorded with what else went missing.
   ========================================================================= */

/** A registered name whose series starts after this day is a stub. Every
 * company in DEFAULT_BACKTEST_TICKERS was listed before it: checked against
 * Alpha Vantage's listing dates on 2026-09-16, the youngest listing among
 * the registered companies is StandardAero (SARO) from 2024-10-02, and the
 * one later date, Wolfspeed's 2025-09-29, is the re-listing of new shares
 * after a bankruptcy that cancelled the registered ones (WOLF is in the
 * exclusion ledger for that reason). So a series that starts later under a
 * registered symbol is not that company's history. The rule applies only
 * to registered names: a caller-supplied --tickers-file may hold a
 * genuinely young listing, which the bar-count rule below still catches. */
export const STUB_FIRST_BAR_AFTER = '2025-01-01'

/** A max-range fetch that holds fewer bars than this (one trading year) is
 * a stub or a listing too young to score. The dataset builder needs 400
 * bars per name (a year of history plus the longest label horizon), so
 * nothing this short could have contributed a row; naming it here is what
 * keeps it from vanishing in the build. */
export const STUB_MIN_BARS_MAX_RANGE = 252

export type StubSeries = {
  ticker: string
  /** Date of the first bar the fetch returned, when the bars carry one. */
  firstBar: string | null
  bars: number
  rule: 'first-bar-after-listing-floor' | 'fewer-than-a-year-of-bars'
  /** The one-line form the CLI prints: "STUB: <ticker> first bar <date>, <n> bars". */
  line: string
}

/**
 * Decide whether a fetched series is a stub. `registered` says the name is
 * in DEFAULT_BACKTEST_TICKERS (so the listing-floor rule applies);
 * `maxRange` says the fetch asked for the whole history (so the bar-count
 * rule applies). An empty series is a fetch failure, not a stub, and is
 * left to the caller.
 */
export function classifyStubSeries(
  ticker: string,
  bars: ArrayLike<unknown>,
  options: { registered: boolean; maxRange: boolean },
): StubSeries | null {
  if (bars.length === 0) return null
  const first = bars[0] as { date?: unknown } | undefined
  const firstBar = typeof first?.date === 'string' ? first.date.slice(0, 10) : null
  const line = `STUB: ${ticker} first bar ${firstBar ?? 'unknown'}, ${bars.length} bar${bars.length === 1 ? '' : 's'}`
  if (options.registered && firstBar != null && firstBar > STUB_FIRST_BAR_AFTER) {
    return { ticker, firstBar, bars: bars.length, rule: 'first-bar-after-listing-floor', line: `${line} (a registered name listed before ${STUB_FIRST_BAR_AFTER}; this is not its history)` }
  }
  if (options.maxRange && bars.length < STUB_MIN_BARS_MAX_RANGE) {
    return { ticker, firstBar, bars: bars.length, rule: 'fewer-than-a-year-of-bars', line: `${line} (fewer than ${STUB_MIN_BARS_MAX_RANGE} bars on a full-history fetch)` }
  }
  return null
}

export async function warmDailyBars(
  tickers: readonly string[],
  fetcher: (ticker: string) => Promise<ArrayLike<unknown>>,
  options: {
    attempts?: number
    pauseMs?: number
    onProgress?: (done: number, total: number, ticker: string) => void
    /** Applied to the first non-empty answer; a stub is not retried (it is
     * a deterministic answer, not a cold cache) and is listed under
     * `stubs`, neither usable nor failed. */
    stubCheck?: (ticker: string, bars: ArrayLike<unknown>) => StubSeries | null
    /** Called as each stub is found, so it is printed at once. */
    onStub?: (stub: StubSeries) => void
    /** Called, and awaited, for each name that came back usable (bars, and
     * not a stub), before the next name is fetched. The CLI reads the same
     * chart's meta block here for the identity check, while the proxy
     * still holds the answer it just gave. */
    onUsable?: (ticker: string, bars: ArrayLike<unknown>) => void | Promise<void>
  } = {},
): Promise<{ usable: string[]; failed: string[]; stubs: StubSeries[]; retries: number }> {
  const attempts = Math.max(1, options.attempts ?? 4)
  const pauseMs = options.pauseMs ?? 1500
  const usable: string[] = []
  const failed: string[] = []
  const stubs: StubSeries[] = []
  let retries = 0
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    let bars: ArrayLike<unknown> = []
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        retries++
        if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
      }
      try {
        bars = await fetcher(ticker)
      } catch {
        bars = []
      }
      if (bars.length > 0) break
    }
    if (bars.length === 0) {
      failed.push(ticker)
    } else {
      const stub = options.stubCheck?.(ticker, bars) ?? null
      if (stub != null) {
        stubs.push(stub)
        options.onStub?.(stub)
      } else {
        usable.push(ticker)
        await options.onUsable?.(ticker, bars)
      }
    }
    options.onProgress?.(i + 1, tickers.length, ticker)
  }
  return { usable, failed, stubs, retries }
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
   The identity ledger: which company each registered name IS
   -------------------------------------------------------------------------
   The two ledgers beside DEFAULT_BACKTEST_TICKERS and the two stub rules
   above all judge a symbol by whether it answers and by the shape of its
   series. None of them can see the third way a symbol lies: it was handed
   to a DIFFERENT company after the registered one left the market, and the
   new holder's own chart is long enough to pass every rule. On 2026-09-16
   PARA (registered as Paramount Global) came back as Banzai International,
   listed 2021, and B (registered as Barnes Group) came back as Barrick
   Mining, listed 1985; both had passed the warm-up.

   The fix is to write down, once, which company each fetchable registered
   name is, and to compare every fetch against that record. The file
   tools/registered_identity.json (built 2026-09-16, see
   buildRegisteredIdentityLedger) holds for each name the SEC CIK and
   registrant name from the SEC's ticker map, and the long name, short name
   and first-trade date from the Yahoo chart's meta block, looked up under
   the symbol the name is fetched as (the successor for a renamed name).
   Funds get the Yahoo names only; so do foreign filers the SEC map does not
   list. The warm-up then asks the same two sources again (one fetch of the
   SEC map per run, and the Yahoo meta of the chart it has just fetched,
   which the proxy still holds) and checkIdentity applies three rules:

     (a) the SEC CIK differs: a different registrant, so a different
         company. RECYCLED, and the run stops. --allow-missing does not
         apply: a wrong company is not a missing one.
     (b) no CIK on either side (a fund, a foreign filer): the Yahoo meta
         decides. A first-trade date more than 30 days from the recorded
         one, or a long name that shares fewer than half its words with the
         recorded one, is RECYCLED, same stop.
     (c) the same CIK but a different name: the company renamed itself in
         place (Equity Residential to Vivmark). Allowed, printed as an
         IDENTITY NOTE, so the next ledger refresh can record it.

   A CIK on one side only means the SEC map gained or lost the symbol since
   the snapshot (a filer that delisted after it, or joined it); that alone
   does not say whose chart it is, so rule (b) decides and the note says
   what the SEC side did.
   ========================================================================= */

export const REGISTERED_IDENTITY_SNAPSHOT_DATE = '2026-09-16'
export const REGISTERED_IDENTITY_FILE = 'registered_identity.json'
export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'

/** One registered name's identity, as pre-registered. */
export type RegisteredIdentity = {
  /** The registered symbol (the sample's identity). */
  ticker: string
  /** The symbol it is fetched under: the successor for a renamed name. */
  fetchSymbol: string
  /** True for an exchange-traded fund: no SEC lookup, Yahoo names only. */
  etf: boolean
  /** SEC registrant id from company_tickers.json; null for a fund or a
   * name the SEC map does not list (a foreign filer, usually). */
  cik: number | null
  secName: string | null
  yahooLongName: string | null
  yahooShortName: string | null
  /** The chart meta's firstTradeDate as an ISO day; null when Yahoo sends none. */
  yahooFirstTradeDate: string | null
  snapshotDate: string
}

export type RegisteredIdentityLedger = {
  /** Plain words for a reader opening the file: what it is and how it was built. */
  _comment: string[]
  snapshotDate: string
  sources: { sec: string; yahoo: string }
  counts: { entries: number; withCik: number; withoutCik: number; etfs: number }
  /** Sorted by ticker. */
  entries: RegisteredIdentity[]
}

/** Where the ledger lives: beside this file (and beside the bundled CLI). */
export function registeredIdentityPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), REGISTERED_IDENTITY_FILE)
}

/** Read and check the ledger. A malformed file is refused with the reason,
 * because a check against a half-read ledger would pass names it should not. */
export function readRegisteredIdentityLedger(path: string = registeredIdentityPath()): RegisteredIdentityLedger {
  if (!existsSync(path)) {
    throw new Error(`The identity ledger ${path} is missing; build it with buildRegisteredIdentityLedger (tools/build-registered-identity.ts) before running.`)
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegisteredIdentityLedger>
  if (!Array.isArray(parsed.entries) || typeof parsed.snapshotDate !== 'string') {
    throw new Error(`The identity ledger ${path} has no entries array or snapshot date.`)
  }
  const counts = parsed.counts
  if (counts == null || [counts.entries, counts.withCik, counts.withoutCik, counts.etfs].some((value) => typeof value !== 'number') || counts.entries !== parsed.entries.length) {
    throw new Error(`The identity ledger ${path} has no counts block, or its entry count does not match its entries.`)
  }
  const seen = new Set<string>()
  for (const entry of parsed.entries) {
    const bad =
      typeof entry?.ticker !== 'string' ||
      typeof entry.fetchSymbol !== 'string' ||
      typeof entry.etf !== 'boolean' ||
      !(entry.cik === null || (typeof entry.cik === 'number' && Number.isInteger(entry.cik) && entry.cik > 0)) ||
      !(entry.secName === null || typeof entry.secName === 'string') ||
      !(entry.yahooLongName === null || typeof entry.yahooLongName === 'string') ||
      !(entry.yahooShortName === null || typeof entry.yahooShortName === 'string') ||
      !(entry.yahooFirstTradeDate === null || /^\d{4}-\d{2}-\d{2}$/.test(String(entry.yahooFirstTradeDate))) ||
      typeof entry.snapshotDate !== 'string'
    if (bad) throw new Error(`The identity ledger ${path} has a malformed entry: ${JSON.stringify(entry)}`)
    if (seen.has(entry.ticker)) throw new Error(`The identity ledger ${path} lists ${entry.ticker} twice.`)
    seen.add(entry.ticker)
  }
  return parsed as RegisteredIdentityLedger
}

/** The SHA-256 of the ledger file's bytes. The run records it, so a later
 * reader can tell exactly which version of the ledger the run was checked
 * against, and a ledger edited after the fact cannot pass as the one used. */
export function hashRegisteredIdentityLedger(path: string = registeredIdentityPath()): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function identityByTicker(ledger: Pick<RegisteredIdentityLedger, 'entries'>): Map<string, RegisteredIdentity> {
  return new Map(ledger.entries.map((entry) => [entry.ticker.trim().toUpperCase(), entry]))
}

/* -------------------------------------------------------------------------
   The Yahoo chart meta
   -------------------------------------------------------------------------
   The chart response the warm-up already fetches carries a meta block with
   the instrument's names and first-trade date. marketData.fetchDailyBars
   keeps only the bars, so this asks for the same URL again and keeps only
   the meta. The URL is built exactly as fetchDailyBars builds it (a 40-year
   window ending at the next UTC midnight), so the proxy answers from the
   copy it cached for the bars; the test file checks the two URLs agree.
   ------------------------------------------------------------------------- */

export type YahooChartMeta = {
  symbol: string
  longName: string | null
  shortName: string | null
  /** ISO day of the meta's firstTradeDate (epoch seconds), or null. */
  firstTradeDate: string | null
  exchange: string | null
  instrumentType: string | null
}

const YAHOO_MAX_RANGE_YEARS = 40

/** The chart URL for a full-history fetch, byte for byte what
 * marketData.fetchDailyBars(symbol, 'max') requests. */
export function yahooChartUrl(symbol: string, nowMs: number = Date.now()): string {
  const period2 = Math.ceil(nowMs / 86_400_000) * 86_400
  const period1 = period2 - Math.round(YAHOO_MAX_RANGE_YEARS * 365.25 * 86_400)
  return (
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizeYahooSymbol(symbol))}` +
    `?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false&events=div,splits`
  )
}

function proxiedUrl(base: string, externalUrl: string): string {
  return `${base}/proxy?url=${encodeURIComponent(externalUrl)}`
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The meta block of a chart payload, or null when there is none. */
export function parseYahooChartMeta(payload: unknown, symbol: string): YahooChartMeta | null {
  const result = (payload as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } })?.chart?.result?.[0]
  const meta = result?.meta
  if (meta == null || typeof meta !== 'object') return null
  const text = (key: string): string | null => (typeof meta[key] === 'string' && (meta[key] as string).trim().length > 0 ? (meta[key] as string).trim() : null)
  const firstTrade = typeof meta.firstTradeDate === 'number' && Number.isFinite(meta.firstTradeDate) ? new Date(meta.firstTradeDate * 1000).toISOString().slice(0, 10) : null
  return {
    symbol: text('symbol') ?? normalizeYahooSymbol(symbol),
    longName: text('longName'),
    shortName: text('shortName'),
    firstTradeDate: firstTrade,
    exchange: text('fullExchangeName') ?? text('exchangeName'),
    instrumentType: text('instrumentType'),
  }
}

export async function fetchYahooChartMeta(
  symbol: string,
  options: { base: string; fetcher?: typeof fetch; timeoutMs?: number; nowMs?: number },
): Promise<YahooChartMeta | null> {
  const payload = await fetchJsonWithTimeout(proxiedUrl(options.base, yahooChartUrl(symbol, options.nowMs)), options.timeoutMs ?? 15_000, options.fetcher ?? fetch)
  return parseYahooChartMeta(payload, symbol)
}

/* -------------------------------------------------------------------------
   The SEC ticker map
   -------------------------------------------------------------------------
   company_tickers.json maps every listed symbol to its registrant's CIK and
   name. One fetch per run through the proxy, which adds the User-Agent the
   SEC requires and keeps the file for a day. Class shares use a dash there
   (BRK-B), as Yahoo does, so lookups go through normalizeYahooSymbol.
   ------------------------------------------------------------------------- */

export type SecTickerRow = { cik: number; name: string }

/** The key a symbol has in the parsed SEC map: the SEC writes class shares
 * with a dash, as Yahoo does, so the same normalization serves both. */
export function normalizeSecSymbol(symbol: string): string {
  return normalizeYahooSymbol(symbol)
}

export function parseSecTickerMap(payload: unknown): Map<string, SecTickerRow> {
  const map = new Map<string, SecTickerRow>()
  if (payload == null || typeof payload !== 'object') return map
  const rows = Array.isArray(payload) ? payload : Object.values(payload as Record<string, unknown>)
  for (const row of rows) {
    const record = row as { cik_str?: unknown; ticker?: unknown; title?: unknown }
    const cik = typeof record?.cik_str === 'number' ? record.cik_str : Number(record?.cik_str)
    if (typeof record?.ticker !== 'string' || !Number.isInteger(cik) || cik <= 0) continue
    map.set(normalizeYahooSymbol(record.ticker), { cik, name: typeof record.title === 'string' ? record.title.trim() : '' })
  }
  return map
}

/** The SEC map through the proxy, or null when it could not be fetched or
 * came back empty (an empty map would read as "no CIK for anyone"). */
export async function fetchSecTickerMap(options: { base: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<Map<string, SecTickerRow> | null> {
  const payload = await fetchJsonWithTimeout(proxiedUrl(options.base, SEC_COMPANY_TICKERS_URL), options.timeoutMs ?? 30_000, options.fetcher ?? fetch)
  const map = parseSecTickerMap(payload)
  return map.size > 0 ? map : null
}

/* -------------------------------------------------------------------------
   Comparing names
   -------------------------------------------------------------------------
   Names are compared as bags of words with the corporate furniture removed
   ("Inc", "Corp", "Class A" and so on), so "Bank of New York Mellon Corp"
   and "The Bank of New York Mellon Corporation" are the same name, while
   "Paramount Global" and "Banzai International, Inc." share nothing. The
   overlap is the share of the SHORTER name's words found in the other, so
   a name that gained a word ("JBT" to "JBT Marel") still overlaps fully.
   ------------------------------------------------------------------------- */

const NAME_STOP_WORDS = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies', 'ltd', 'limited', 'plc', 'llc', 'lp', 'sa', 'se', 'nv', 'ag', 'ab', 'asa', 'spa',
  'the', 'and', 'of', 'class', 'a', 'b', 'c', 'common', 'stock', 'shares', 'ordinary', 'new', 'de',
])

/** How a dot inside a name is read. The SEC and Yahoo disagree on it both
 * ways: "AMAZON COM INC" against "Amazon.com, Inc." wants the dot to break
 * the word, "FNB CORP" against "F.N.B. Corporation" wants it to vanish. So
 * every comparison is made under both readings and the better one counts.
 * An apostrophe is always spelling ("MOODYS" against "Moody's"). */
type DotReading = 'break' | 'join'
const DOT_READINGS: readonly DotReading[] = ['break', 'join']

export function nameTokens(name: string | null | undefined, dots: DotReading = 'break'): string[] {
  if (name == null) return []
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\./g, dots === 'join' ? '' : ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !NAME_STOP_WORDS.has(word))
}

function overlapUnder(left: string | null | undefined, right: string | null | undefined, dots: DotReading): number {
  const a = new Set(nameTokens(left, dots))
  const b = new Set(nameTokens(right, dots))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  return shared / Math.min(a.size, b.size)
}

/** Share of the shorter name's words present in the other, 0 to 1, under
 * the better reading of dots. Zero when either side has no words left to
 * compare. */
export function nameOverlap(left: string | null | undefined, right: string | null | undefined): number {
  return Math.max(...DOT_READINGS.map((dots) => overlapUnder(left, right, dots)))
}

/** True when the two names are the same words in the same order once the
 * corporate furniture is gone ("Inc." against "Inc" is not a change),
 * under either reading of dots. */
export function sameName(left: string | null | undefined, right: string | null | undefined): boolean {
  return DOT_READINGS.some((dots) => nameTokens(left, dots).join(' ') === nameTokens(right, dots).join(' '))
}

/** Rule (b): fewer than half the words in common is a different company. */
export const IDENTITY_NAME_OVERLAP_THRESHOLD = 0.5
/** Rule (b): a first-trade date this far from the recorded one is a
 * different listing. Yahoo moves the date by a day or two now and then
 * (data corrections); a month is well clear of that and well short of any
 * two listings a recycled symbol could join. */
export const IDENTITY_FIRST_TRADE_TOLERANCE_DAYS = 30

function daysBetween(left: string, right: string): number {
  return Math.abs((Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000)
}

/* -------------------------------------------------------------------------
   The check
   ------------------------------------------------------------------------- */

/** What the run found for one name today. */
export type LiveIdentity = {
  /** From the SEC map under the fetch symbol; null when the map does not list it. */
  cik: number | null
  secName: string | null
  /** From the chart just fetched; null when the meta could not be read. */
  meta: YahooChartMeta | null
}

export type IdentityStatus = 'matched' | 'renamed-in-place' | 'recycled' | 'unverified' | 'unregistered'

export type IdentityCheck = {
  ticker: string
  fetchSymbol: string
  status: IdentityStatus
  /** What was compared and what was found, in one sentence. */
  detail: string
  /** The console line for anything but a plain match; null for a match. */
  line: string | null
}

/** The best name a side offers: the long name, else the short name. */
function bestYahooName(longName: string | null | undefined, shortName: string | null | undefined): string | null {
  return longName ?? shortName ?? null
}

export function checkIdentity(ticker: string, fetchSymbol: string, registered: RegisteredIdentity | undefined, live: LiveIdentity): IdentityCheck {
  const name = ticker.trim().toUpperCase()
  const symbol = fetchSymbol.trim().toUpperCase()
  if (registered == null) {
    return { ticker: name, fetchSymbol: symbol, status: 'unregistered', detail: 'not in the identity ledger, so nothing to compare against', line: `IDENTITY UNREGISTERED: ${name} is not in the identity ledger; its company was not checked` }
  }
  // A chart that answers under a different symbol from the one asked for
  // is a provider redirect: whatever it describes, it is not evidence
  // about this name, so nothing below may read it as a match.
  if (live.meta?.symbol != null && normalizeYahooSymbol(live.meta.symbol).toUpperCase() !== normalizeYahooSymbol(symbol).toUpperCase()) {
    return {
      ticker: name,
      fetchSymbol: symbol,
      status: 'unverified',
      detail: `asked for ${symbol} but the chart answered as ${live.meta.symbol} (a provider redirect), so nothing it says is about this name`,
      line: `IDENTITY UNVERIFIED: ${name} asked for ${symbol} but the chart answered as ${live.meta.symbol} (a provider redirect), so its company could not be checked`,
    }
  }
  const registeredName = registered.secName ?? bestYahooName(registered.yahooLongName, registered.yahooShortName) ?? name
  const liveYahooName = bestYahooName(live.meta?.longName, live.meta?.shortName)
  const liveName = liveYahooName ?? live.secName ?? symbol
  const recycled = (why: string): IdentityCheck => ({
    ticker: name,
    fetchSymbol: symbol,
    status: 'recycled',
    detail: why,
    line: `RECYCLED: ${name}${symbol !== name ? ` (fetched as ${symbol})` : ''} is now ${liveName}${live.cik != null ? ` (SEC CIK ${live.cik})` : ''}; the run is registered against ${registeredName}${registered.cik != null ? ` (SEC CIK ${registered.cik})` : ''}: ${why}`,
  })

  // Rule (a): a CIK on both sides. The SEC's registrant id is the company
  // itself; a different id is a different company, whatever the names say.
  if (registered.cik != null && live.cik != null) {
    if (registered.cik !== live.cik) {
      return recycled(`the SEC map now lists ${symbol} under CIK ${live.cik} (${live.secName ?? 'unnamed'}), not the registered CIK ${registered.cik} (${registered.secName ?? 'unnamed'})`)
    }
    // The SEC's ticker map can lag a symbol reassignment by weeks: it may
    // still list the old registrant under a symbol whose chart Yahoo has
    // already handed to the new holder. A matching CIK alone would wave
    // that through, so the chart's first-trade date is read here too. The
    // same company's listing keeps its first-trade date; a date that moved
    // by more than the tolerance is a different listing, whatever the map
    // says. (If Yahoo merely extended a series backwards, the run stops
    // with the name printed and the ledger is refreshed on purpose.)
    if (registered.yahooFirstTradeDate != null && live.meta?.firstTradeDate != null) {
      const gap = daysBetween(registered.yahooFirstTradeDate, live.meta.firstTradeDate)
      if (gap > IDENTITY_FIRST_TRADE_TOLERANCE_DAYS) {
        return recycled(
          `same SEC CIK ${live.cik} but the chart is a different listing: its first-trade date moved from ${registered.yahooFirstTradeDate} to ${live.meta.firstTradeDate} ` +
            `(${Math.round(gap)} days; more than ${IDENTITY_FIRST_TRADE_TOLERANCE_DAYS}), which is what a symbol reassignment the SEC map has not caught up with looks like`,
        )
      }
    }
    // Rule (c): same company, new name. Compare the Yahoo long names (the
    // SEC name is spelled loosely) and fall back to the SEC name when
    // Yahoo sends none. The note names whichever field was compared, so
    // the reader sees what actually changed.
    const comparedYahoo = liveYahooName != null && registered.yahooLongName != null
    const changed = comparedYahoo ? !sameName(liveYahooName, registered.yahooLongName) : !sameName(live.secName, registered.secName)
    if (changed) {
      const wasName = comparedYahoo ? registered.yahooLongName : registeredName
      return {
        ticker: name,
        fetchSymbol: symbol,
        status: 'renamed-in-place',
        detail: `same SEC CIK ${live.cik}; the name changed from ${wasName} to ${liveName}`,
        line: `IDENTITY NOTE: ${name} now ${liveName} (was ${wasName}; same SEC CIK ${live.cik}, so the same company; refresh the identity ledger)`,
      }
    }
    return { ticker: name, fetchSymbol: symbol, status: 'matched', detail: `same SEC CIK ${live.cik} and the same name`, line: null }
  }

  // Rule (b), and the one-sided case: the Yahoo meta decides. Without it
  // there is nothing to decide with.
  if (live.meta == null) {
    return { ticker: name, fetchSymbol: symbol, status: 'unverified', detail: 'the chart meta could not be read and no CIK was available on both sides', line: `IDENTITY UNVERIFIED: ${name} has no readable chart meta and no CIK on both sides, so its company could not be checked` }
  }
  const secSideNote =
    registered.cik != null && live.cik == null
      ? ` (the SEC map no longer lists ${symbol}; it was CIK ${registered.cik} at the snapshot)`
      : registered.cik == null && live.cik != null
        ? ` (the SEC map now lists ${symbol} as CIK ${live.cik}, ${live.secName ?? 'unnamed'}; it had no CIK at the snapshot)`
        : ''
  if (registered.yahooFirstTradeDate != null && live.meta.firstTradeDate != null) {
    const gap = daysBetween(registered.yahooFirstTradeDate, live.meta.firstTradeDate)
    if (gap > IDENTITY_FIRST_TRADE_TOLERANCE_DAYS) {
      return recycled(`the chart's first-trade date moved from ${registered.yahooFirstTradeDate} to ${live.meta.firstTradeDate} (${Math.round(gap)} days; more than ${IDENTITY_FIRST_TRADE_TOLERANCE_DAYS} is a different listing)${secSideNote}`)
    }
  }
  const registeredYahooName = bestYahooName(registered.yahooLongName, registered.yahooShortName)
  if (registeredYahooName != null && liveYahooName != null) {
    // Take the best pairing of long and short names on the two sides, so a
    // label error on one field (Yahoo's VMRK long name reads AvalonBay while
    // its short name reads Vivmark) does not condemn a matching name.
    const overlap = Math.max(
      nameOverlap(registered.yahooLongName, live.meta.longName),
      nameOverlap(registered.yahooLongName, live.meta.shortName),
      nameOverlap(registered.yahooShortName, live.meta.longName),
      nameOverlap(registered.yahooShortName, live.meta.shortName),
    )
    if (overlap < IDENTITY_NAME_OVERLAP_THRESHOLD) {
      return recycled(`the chart's name shares ${(overlap * 100).toFixed(0)}% of its words with the recorded ${registeredYahooName} (below ${IDENTITY_NAME_OVERLAP_THRESHOLD * 100}%)${secSideNote}`)
    }
    if (!sameName(liveYahooName, registeredYahooName)) {
      return {
        ticker: name,
        fetchSymbol: symbol,
        status: 'renamed-in-place',
        detail: `no CIK on both sides; first-trade date and most words agree, the name changed from ${registeredYahooName} to ${liveYahooName}${secSideNote}`,
        line: `IDENTITY NOTE: ${name} now ${liveYahooName} (was ${registeredYahooName}; same first-trade date${secSideNote}; refresh the identity ledger)`,
      }
    }
  } else if (registered.yahooFirstTradeDate == null || live.meta.firstTradeDate == null) {
    return { ticker: name, fetchSymbol: symbol, status: 'unverified', detail: 'no CIK on both sides, and neither a name nor a first-trade date on both sides to compare', line: `IDENTITY UNVERIFIED: ${name} offers neither a CIK, nor a name, nor a first-trade date on both sides, so its company could not be checked` }
  } else {
    // A first-trade date within tolerance on its own is not an identity:
    // it says when a listing began, not whose it is. With a name on only
    // one side the name test never ran, and that has to be said.
    const side = liveYahooName == null ? 'the chart sent no name' : 'the record holds no name'
    return { ticker: name, fetchSymbol: symbol, status: 'unverified', detail: `no CIK on both sides and ${side}, so only the first-trade date could be compared, which is not enough${secSideNote}`, line: `IDENTITY UNVERIFIED: ${name} has no CIK on both sides and ${side}; only its first-trade date could be compared, which is not enough to say whose listing it is${secSideNote}` }
  }
  if (secSideNote.length > 0) {
    return { ticker: name, fetchSymbol: symbol, status: 'matched', detail: `the chart's name and first-trade date match the record${secSideNote}`, line: `IDENTITY NOTE: ${name} still ${liveName}${secSideNote}` }
  }
  return { ticker: name, fetchSymbol: symbol, status: 'matched', detail: 'no CIK on either side; the chart\'s name and first-trade date match the record', line: null }
}

export type IdentitySummary = {
  checked: number
  matched: number
  renamedInPlace: number
  recycled: number
  unverified: number
  unregistered: number
  /** 'identity: N checked, N matched, N renamed-in-place, N recycled' (+ the two rarer counts when non-zero). */
  line: string
}

export function summarizeIdentityChecks(checks: readonly IdentityCheck[]): IdentitySummary {
  const count = (status: IdentityStatus) => checks.filter((check) => check.status === status).length
  const summary = {
    checked: checks.length,
    matched: count('matched'),
    renamedInPlace: count('renamed-in-place'),
    recycled: count('recycled'),
    unverified: count('unverified'),
    unregistered: count('unregistered'),
  }
  const extra = [summary.unverified > 0 ? `${summary.unverified} unverified` : '', summary.unregistered > 0 ? `${summary.unregistered} not in the ledger` : ''].filter((part) => part.length > 0)
  return {
    ...summary,
    line: `identity: ${summary.checked} checked, ${summary.matched} matched, ${summary.renamedInPlace} renamed-in-place, ${summary.recycled} recycled${extra.length ? `, ${extra.join(', ')}` : ''}`,
  }
}

/* -------------------------------------------------------------------------
   Building the ledger (once)
   -------------------------------------------------------------------------
   For every registered name the fetch plan keeps (funds included, excluded
   names left out), one SEC map lookup under the fetch symbol (funds
   skipped) and one Yahoo meta fetch. Entries are sorted by ticker and
   written with fixed keys, so two builds from the same answers give the
   same bytes. A company whose SEC name and Yahoo name share fewer than
   half their words is returned for a human to look at.
   ------------------------------------------------------------------------- */

export async function buildRegisteredIdentityLedger(args: {
  tickers: readonly string[]
  etfSymbols: ReadonlySet<string>
  secMap: ReadonlyMap<string, SecTickerRow>
  fetchMeta: (fetchSymbol: string) => Promise<YahooChartMeta | null>
  snapshotDate?: string
  ledger?: Parameters<typeof planUniverseFetch>[1]
  onProgress?: (done: number, total: number, ticker: string) => void
}): Promise<{ ledger: RegisteredIdentityLedger; disagreements: Array<{ ticker: string; secName: string; yahooName: string; overlap: number }>; metaMissing: string[] }> {
  const snapshotDate = args.snapshotDate ?? REGISTERED_IDENTITY_SNAPSHOT_DATE
  const plan = planUniverseFetch(args.tickers, args.ledger)
  const entries: RegisteredIdentity[] = []
  const disagreements: Array<{ ticker: string; secName: string; yahooName: string; overlap: number }> = []
  const metaMissing: string[] = []
  for (let i = 0; i < plan.fetch.length; i++) {
    const { ticker, fetchedAs } = plan.fetch[i]
    const etf = args.etfSymbols.has(ticker)
    const sec = etf ? undefined : args.secMap.get(normalizeYahooSymbol(fetchedAs))
    const meta = await args.fetchMeta(fetchedAs)
    if (meta == null) metaMissing.push(ticker)
    const entry: RegisteredIdentity = {
      ticker,
      fetchSymbol: fetchedAs,
      etf,
      cik: sec?.cik ?? null,
      secName: sec?.name ?? null,
      yahooLongName: meta?.longName ?? null,
      yahooShortName: meta?.shortName ?? null,
      yahooFirstTradeDate: meta?.firstTradeDate ?? null,
      snapshotDate,
    }
    entries.push(entry)
    const yahooName = bestYahooName(entry.yahooLongName, entry.yahooShortName)
    if (entry.secName != null && yahooName != null) {
      const overlap = Math.max(nameOverlap(entry.secName, entry.yahooLongName), nameOverlap(entry.secName, entry.yahooShortName))
      if (overlap < IDENTITY_NAME_OVERLAP_THRESHOLD) disagreements.push({ ticker, secName: entry.secName, yahooName, overlap })
    }
    args.onProgress?.(i + 1, plan.fetch.length, ticker)
  }
  entries.sort((left, right) => (left.ticker < right.ticker ? -1 : left.ticker > right.ticker ? 1 : 0))
  const withCik = entries.filter((entry) => entry.cik != null).length
  const ledger: RegisteredIdentityLedger = {
    _comment: [
      'The pre-registered identity ledger of the walk-forward run (tools/backtest-cli.ts).',
      'For every name in DEFAULT_BACKTEST_TICKERS that is not in EXCLUDED_UNFETCHABLE, this records WHICH COMPANY the name was on the snapshot date:',
      'the SEC registrant id (cik) and name from the SEC ticker map, looked up under the symbol the name is fetched as (fetchSymbol; the successor for a renamed name),',
      'and the long name, short name and first-trade date from the Yahoo chart meta under that symbol.',
      'Funds (etf: true) and names the SEC map does not list (foreign filers) carry the Yahoo names only, with cik null.',
      'At every warm-up the runner compares each name\'s live SEC CIK and Yahoo meta with this record (checkIdentity in tools/preregistered-run.ts):',
      'a different CIK, a first-trade date more than 30 days away, or a name sharing fewer than half its words means the symbol now belongs to another company, and the run stops;',
      'a new name under the same CIK is printed as an IDENTITY NOTE and allowed.',
      'Built once by buildRegisteredIdentityLedger (tools/build-registered-identity.ts) from one fetch of the SEC map and one Yahoo chart meta fetch per name, through the local proxy. Entries are sorted by ticker.',
    ],
    snapshotDate,
    sources: { sec: SEC_COMPANY_TICKERS_URL, yahoo: 'https://query1.finance.yahoo.com/v8/finance/chart/<symbol> meta block (40-year window, interval=1d)' },
    counts: { entries: entries.length, withCik, withoutCik: entries.length - withCik, etfs: entries.filter((entry) => entry.etf).length },
    entries,
  }
  return { ledger, disagreements, metaMissing }
}

/** The ledger as the file holds it: two-space JSON, keys in declaration
 * order, a trailing newline. Byte-stable across builds from the same answers. */
export function serializeRegisteredIdentityLedger(ledger: RegisteredIdentityLedger): string {
  return JSON.stringify(ledger, null, 2) + '\n'
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
   fixed cost and a cost per name (about 219 MB plus 9.1 MB per name).

   That line describes the WINDOW LOOP only, because the CLI sampled its
   resident memory after each window and nowhere else. The 200-name smoke
   on 2026-09-16 showed what that misses: the line projected 2,039 MB, the
   CLI's own sampling peaked at 1,741 MB, and the operating system's peak
   working set for the process was 2,864 MB. The extra came after the loop,
   in the served-model training (every row at once, five bagged models and
   the horizon models), the regime labelling and the gate report, none of
   which was sampled. 2,864 / 2,039 = 1.40, so the projection below
   multiplies the loop line by POST_LOOP_MEMORY_FACTOR = 1.4 to cover the
   post-loop phase, adds a quarter for headroom, and rounds up to a whole
   gigabyte for the node flag. The CLI now samples the post-loop phase too
   (after the served models, the regime step and the report), so the next
   full run can replace the factor with a measurement.

   The flag only raises the ceiling node allows itself; the memory has to
   exist. The run reads the machine's free memory as well as its total and
   stops when free memory is below the recommended heap, because a run that
   pages to disk for hours is no better than one that dies at once.
   ========================================================================= */

export const SMOKE_MEMORY_POINTS = [
  { names: 15, peakRssMb: 355 },
  { names: 25, peakRssMb: 446 },
] as const

/** The 200-name smoke of 2026-09-16: what the loop line projected, what
 * the CLI's per-window sampling saw, and what the operating system saw. */
export const POST_LOOP_MEMORY_POINT = { names: 200, loopProjectedMb: 2039, cliSampledPeakRssMb: 1741, osPeakWorkingSetMb: 2864 } as const

/** osPeakWorkingSetMb / loopProjectedMb of that smoke, rounded: the
 * unsampled post-loop phase over the sampled loop line. */
export const POST_LOOP_MEMORY_FACTOR = 1.4

/** A quarter of headroom on top of the projection before rounding up to a
 * whole gigabyte for --max-old-space-size. */
export const HEAP_HEADROOM_FACTOR = 1.25

export type HeapProjection = {
  perNameMb: number
  baseMb: number
  namesPlanned: number
  /** The window-loop line alone: base + names x per name. */
  loopProjectedMb: number
  postLoopFactor: number
  /** The loop line times the post-loop factor: the peak the whole run should reach. */
  projectedMb: number
  heapCeilingMb: number
  /** The --max-old-space-size value to pass: projected need plus a quarter, rounded up to a whole gigabyte. */
  recommendedMb: number
  flag: string
  exceedsCeiling: boolean
  /** The machine's free memory when the run started; null when not read. */
  freeMemoryMb: number | null
  /** How far free memory falls short of the recommended heap; 0 when it does not, or was not read. */
  freeMemoryShortfallMb: number
  belowFreeMemory: boolean
}

export function projectHeapNeed(namesPlanned: number, heapCeilingMb: number, freeMemoryMb: number | null = null): HeapProjection {
  const [low, high] = SMOKE_MEMORY_POINTS
  const perNameMb = (high.peakRssMb - low.peakRssMb) / (high.names - low.names)
  const baseMb = low.peakRssMb - low.names * perNameMb
  const loopProjectedMb = Math.round(baseMb + namesPlanned * perNameMb)
  const projectedMb = Math.round(loopProjectedMb * POST_LOOP_MEMORY_FACTOR)
  const recommendedMb = Math.max(1024, Math.ceil((projectedMb * HEAP_HEADROOM_FACTOR) / 1024) * 1024)
  const freeKnown = freeMemoryMb != null && Number.isFinite(freeMemoryMb)
  const freeMemoryShortfallMb = freeKnown ? Math.max(0, recommendedMb - Math.round(freeMemoryMb)) : 0
  return {
    perNameMb,
    baseMb,
    namesPlanned,
    loopProjectedMb,
    postLoopFactor: POST_LOOP_MEMORY_FACTOR,
    projectedMb,
    heapCeilingMb,
    recommendedMb,
    flag: `--max-old-space-size=${recommendedMb}`,
    exceedsCeiling: projectedMb > heapCeilingMb,
    freeMemoryMb: freeKnown ? Math.round(freeMemoryMb) : null,
    freeMemoryShortfallMb,
    belowFreeMemory: freeMemoryShortfallMb > 0,
  }
}

export type MemoryGuardVerdict = {
  /** True when the run should stop before fetching anything. */
  abort: boolean
  /** Each problem found, in plain words; empty when there is none. */
  problems: string[]
  /** What to do about each problem. */
  advice: string[]
}

/** The two memory rules, as a verdict the CLI prints and acts on: the heap
 * ceiling must cover the projection, and free memory must cover the
 * recommended heap. --allow-low-heap turns either problem into a warning. */
export function memoryGuardVerdict(projection: HeapProjection, allowLowHeap: boolean): MemoryGuardVerdict {
  const problems: string[] = []
  const advice: string[] = []
  if (projection.exceedsCeiling) {
    problems.push(`the heap ceiling (${projection.heapCeilingMb} MB) is below the projected need (${projection.projectedMb} MB for ${projection.namesPlanned} names)`)
    advice.push(`restart with node ${projection.flag} (V8 slows sharply near its ceiling and a run of hours can still die part-way through)`)
  }
  if (projection.belowFreeMemory) {
    problems.push(
      `only ${projection.freeMemoryMb} MB of memory is free, ${projection.freeMemoryShortfallMb} MB short of the recommended heap (${projection.recommendedMb} MB for ${projection.namesPlanned} names)`,
    )
    advice.push('close other applications until that much memory is free, or use --limit to run fewer names (a run that pages to disk for hours is no better than one that dies)')
  }
  return { abort: problems.length > 0 && !allowLowHeap, problems, advice }
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
   The registered universe of a --limit run
   -------------------------------------------------------------------------
   --limit N keeps the first N names that will actually be fetched, so
   "--limit 25" still means 25 scored companies. The run's registered
   universe is then the shortest prefix of the list that holds those N
   names, which keeps any excluded name inside that prefix on the record
   (and in the excluded share). Without a limit, or when fewer than N names
   are fetchable, the whole list is the registered universe.
   ========================================================================= */

export function registeredPrefixForLimit(
  tickers: readonly string[],
  limit: number,
  ledger?: Parameters<typeof planUniverseFetch>[1],
): string[] {
  const fetchable = planUniverseFetch(tickers, ledger).fetch.map((entry) => entry.ticker)
  if (!(limit > 0) || fetchable.length <= limit) return [...tickers]
  const last = fetchable[limit - 1]
  const lastIndex = tickers.findIndex((ticker) => ticker.trim().toUpperCase() === last)
  return tickers.slice(0, lastIndex + 1)
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
    /** Names the run registered after the fund exclusion (and inside the
     * --limit prefix when one was given): the ones fetched plus the ones
     * set aside. */
    registered: number
    /** Registered names set aside before any fetch because they left the
     * market and no free source serves their history (EXCLUDED_UNFETCHABLE),
     * each with its last trading day and the reason. */
    registeredButExcluded: number
    excludedNames: Array<{ ticker: string; delistingDate: string | null; reason: string; recycledBy?: string }>
    /** Registered names fetched under a successor symbol (TICKER_RENAMES);
     * the sample keeps the original symbol as its identity. */
    renamed: number
    renames: Array<{ original: string; fetchedAs: string }>
    /** Names the warm-up found served as stubs (classifyStubSeries). A run
     * without --allow-missing aborts on them instead, so this is only ever
     * non-empty on a run that was told to proceed. Absent on older artifacts. */
    stubs?: StubSeries[]
    /** The identity check (checkIdentity against tools/registered_identity.json):
     * how many names were checked and how each came out, plus every
     * IDENTITY NOTE. A recycled name aborts the run, so `recycled` is
     * always 0 on a persisted artifact. Absent on older artifacts. */
    identity?: { snapshotDate: string; checked: number; matched: number; renamedInPlace: number; recycled: number; unverified: number; unregistered: number; notes: string[] }
    /** The excluded names as a share of the registered names, in the words
     * the survivorship diagnostics print. */
    attrition: UniverseAttrition
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
  /** The memory reading the run started with and the peaks it reached: the
   * window loop (sampled after each window) and the post-loop phase
   * (sampled after the served models, the regime step and the report),
   * so the post-loop factor can be re-measured from a real run. */
  memory?: {
    heapCeilingMb: number
    projectedMb: number
    recommendedFlag: string
    peakRssMb: number
    totalMemoryMb?: number
    freeMemoryMb?: number
    loopProjectedMb?: number
    postLoopFactor?: number
    loopPeakRssMb?: number
    postLoopPeakRssMb?: number
  }
}
