import type { CacheInfo, CacheTtl, Ctx, CtxRow } from '../types'

/** What a square stands for: a /context category's kind, or the draft not yet sent. */
export type SquareKind = CtxRow['kind'] | 'pending'

/**
 * /context's own glyphs: a full square, a category's last square when under
 * 70% full, free space (drawn dim), the compaction buffer. The draft borrows
 * the free square, drawn in the messages colour: room about to be taken.
 * Squares the current or last turn added are the solid forms of the same two.
 */
export const GLYPH = { full: '⛁', partial: '⛀', newFull: '⛃', newPartial: '⛂', free: '⛶', buffer: '⛝' } as const

/** Whether a square is one the current or last turn added (drawn solid). */
export function isNewGlyph(glyph: string): boolean {
  return glyph === GLYPH.newFull || glyph === GLYPH.newPartial
}

/** Growth under this many tokens is estimate noise, not a turn's work: no square is marked for it. */
export const ADDED_MIN_TOKENS = 100

/** Each category's growth since `baseline` (a turn's start), by name; categories that shrank or held are left out. */
export function addedSince(ctx: Ctx, baseline: Readonly<Record<string, number>> | null): Record<string, number> {
  const added: Record<string, number> = {}
  if (baseline === null) return added
  for (const row of ctx.rows) {
    if (row.kind !== 'used') continue
    const growth = row.tokens - (baseline[row.name] ?? 0)
    if (growth >= ADDED_MIN_TOKENS) added[row.name] = growth
  }
  return added
}

export const KIND_GLYPH: Record<SquareKind, string> = {
  used: GLYPH.full,
  pending: GLYPH.free,
  free: GLYPH.free,
  buffer: GLYPH.buffer,
}

/** The widest cache label: `cache expired 59m ago`. */
export const LABEL_WIDTH = 21

/** Columns kept at the right end of the band: the label and a gap before it. */
export const RESERVE = LABEL_WIDTH + 2

export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/** A stretch of neighbouring squares of one category: its tokens, and the squares as /context draws them. */
export type Run = {
  kind: SquareKind
  name: string
  color: string
  tokens: number
  /** Tokens the current or last turn added to this category; 0 when none. */
  added: number
  count: number
  /** Each square's glyph, in order. */
  glyphs: string[]
  /** The squares as text, each glyph followed by its space. */
  text: string
}

/** Claude Code's own rough rule for text it has not counted: four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Where the tooltip of square `index` starts, in columns from the band's left
 * edge, each square being two columns (glyph, space): on the next square when
 * `width` fits by `limit` (the last square's glyph, so the cache label stays
 * clear), else ending on the previous square, else as near the end as fits.
 */
export function tipLeft(index: number, width: number, limit: number): number {
  const after = (index + 1) * 2
  if (after + width <= limit) return after
  const before = index * 2 - width
  if (before >= 0) return before
  return Math.max(0, limit - width)
}

/** Squares that fit in `columns`: each is a glyph and a space, the last needs no space. */
export function squaresFor(columns: number): number {
  return Math.max(1, Math.floor((columns + 1) / 2))
}

/**
 * Splits the window into `n` squares the way /context does, `n` being what
 * fits the width: each category takes round(its share of `n`) squares, at
 * least one, its last square `⛀` when under 70% full; used categories first
 * in /context's order, the compaction buffer at the right end, free space
 * between.
 *
 * `draft` tokens (typed, not yet sent) take the squares right after the used
 * ones, at least one while anything is typed, in the colour of the last used
 * category, which in /context's order is the messages.
 *
 * `added` (a category's growth this turn or last, by name) turns the last of
 * that category's squares solid: round(growth / square) of them, at least one,
 * since growth lands at the end of what the category holds.
 */
export function layout(ctx: Ctx, n: number, draft = 0, added: Readonly<Record<string, number>> = {}): Run[] {
  const share = (tokens: number) => (tokens / ctx.window) * n
  const used = ctx.rows.filter(r => r.kind === 'used')
  const free = ctx.rows.find(r => r.kind === 'free')
  const buffer = ctx.rows.find(r => r.kind === 'buffer')
  const bufferCount = buffer === undefined ? 0 : Math.max(1, Math.round(share(buffer.tokens)))

  const runs: Run[] = []
  let drawn = 0
  const push = (kind: SquareKind, name: string, color: string, tokens: number, glyph: string, grew = 0) => {
    drawn += 1
    const last = runs.at(-1)
    if (last !== undefined && last.kind === kind && last.name === name) {
      last.count += 1
      last.glyphs.push(glyph)
      last.text += `${glyph} `
    } else {
      runs.push({ kind, name, color, tokens, added: grew, count: 1, glyphs: [glyph], text: `${glyph} ` })
    }
  }

  for (const row of used) {
    const exact = share(row.tokens)
    const whole = Math.floor(exact)
    const count = Math.max(1, Math.round(exact))
    const grew = added[row.name] ?? 0
    const newFrom = grew > 0 ? count - Math.min(count, Math.max(1, Math.round(share(grew)))) : count
    for (let i = 0; i < count && drawn < n; i++) {
      const isFull = (i === whole && exact > whole ? exact - whole : 1) >= 0.7
      const glyph = i >= newFrom ? (isFull ? GLYPH.newFull : GLYPH.newPartial) : isFull ? GLYPH.full : GLYPH.partial
      push('used', row.name, row.color, row.tokens, glyph, grew)
    }
  }

  if (draft > 0) {
    const color = used.at(-1)?.color ?? 'text'
    const count = Math.max(1, Math.round(share(draft)))
    for (let i = 0; i < count && drawn < n - bufferCount; i++) {
      push('pending', 'Prompt draft', color, draft, GLYPH.free)
    }
  }

  while (drawn < n - bufferCount) {
    push('free', free?.name ?? 'Free space', free?.color ?? 'promptBorder', free?.tokens ?? 0, GLYPH.free)
  }

  while (drawn < n && buffer !== undefined) {
    push('buffer', buffer.name, buffer.color, buffer.tokens, GLYPH.buffer)
  }

  return runs
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

function percent(part: number, whole: number): string {
  const p = (part / whole) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

/** What one square stands for at this width. */
export function squareSize(window: number, n: number): string {
  return `1 square ≈ ${formatTokens(Math.round(window / n))} (${percent(1, n)})`
}

/** The tooltip of a run, one line: what its squares are, its tokens, its share of the window. */
export function describeRun(run: Run, window: number): string {
  const name =
    run.kind === 'pending' ? `${run.name} (typed, not sent)` : run.kind === 'buffer' ? `${run.name} (kept for /compact)` : run.name
  const tokens = `${run.kind === 'pending' ? '~' : ''}${formatTokens(run.tokens)} tokens`
  return `${name} · ${tokens} · ${percent(run.tokens, window)} of ${formatTokens(window)}`
}

/** Which turn the solid squares are: the one running, or the one before the prompt being typed. */
export type TurnPhase = 'this' | 'last'

/**
 * The tooltip of a run's solid squares: what the turn added, the glyph it is
 * drawn with, then the category as a whole. Its other squares say the growth
 * at the end of the usual line.
 */
export function describeAdded(run: Run, window: number, phase: TurnPhase, isNewSquare: boolean): string {
  const base = describeRun(run, window)
  if (run.added <= 0) return base
  const growth = `+${formatTokens(run.added)}`
  if (!isNewSquare) return `${base} · ${growth} ${phase} turn (${GLYPH.newFull})`
  return `${GLYPH.newFull} added ${phase} turn: ${run.name} ${growth} · now ${formatTokens(run.tokens)} tokens, ${percent(run.tokens, window)} of ${formatTokens(window)}`
}

/** The legend's line for a turn's growth: `Last turn: Messages +6.2k · MCP tools +1.4k`. */
export function addedLine(added: Readonly<Record<string, number>>, phase: TurnPhase): string {
  const parts = Object.entries(added).map(([name, tokens]) => `${name} +${formatTokens(tokens)}`)
  const label = phase === 'this' ? 'This turn' : 'Last turn'
  return parts.length === 0 ? `${label}: no growth` : `${label} (${GLYPH.newFull}): ${parts.join(' · ')}`
}

/** Plain words for the theme keys /context paints its categories in. */
const COLOR_WORDS: Record<string, string> = {
  promptBorder: 'light grey',
  inactive: 'grey',
  cyan_FOR_SUBAGENTS_ONLY: 'cyan',
  permission: 'blue',
  claude: 'orange',
  warning: 'yellow',
  purple_FOR_SUBAGENTS_ONLY: 'purple',
}

export function colorWord(key: string): string {
  return COLOR_WORDS[key] ?? key
}

/** The legend as text, for the slash command: every category, its colour, its share. */
export function legendText(ctx: Ctx, n: number, draft: number): string {
  const lines = [`Context band: ${formatTokens(ctx.window)} window, ${squareSize(ctx.window, n)}`]
  for (const row of ctx.rows) {
    lines.push(`${KIND_GLYPH[row.kind]} ${row.name} (${colorWord(row.color)}): ${formatTokens(row.tokens)}, ${percent(row.tokens, ctx.window)}`)
  }
  if (draft > 0) lines.push(`${GLYPH.free} Prompt draft (messages colour): ~${formatTokens(draft)}`)
  return lines.join('\n')
}

function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A rough age: under a minute, minutes, hours, then days. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** How long before a 1h entry expires the label starts flashing. 5m entries never flash. */
export const FLASH_MS = 5 * 60_000

/**
 * The right-hand label: the time left while warm, how long ago it lapsed once
 * expired. Before the first request it says so, and while the TTL is not yet
 * known (a response in the transcript, or the settings, tell it) it waits
 * rather than count down against a guess. A 1h entry flashes, reversing each
 * second, through its last five minutes.
 */
export function cacheLabel(cache: CacheInfo | null, now: number): { text: string; color: string; inverse: boolean } {
  if (cache === null) return { text: 'no cache yet', color: 'inactive', inverse: false }
  if (cache.ttl === null) return { text: 'cache …', color: 'inactive', inverse: false }

  const expiry = cache.touchedAt + TTL_MS[cache.ttl]
  const remaining = expiry - Math.max(now, cache.touchedAt)

  if (remaining <= 0) return { text: `cache expired ${ago(-remaining)} ago`, color: 'error', inverse: false }

  const color = remaining <= TTL_MS[cache.ttl] * 0.2 ? 'warning' : 'success'
  const isFlashing = cache.ttl === '1h' && remaining <= FLASH_MS
  return { text: `${cache.ttl}-cache ${clock(remaining)}`, color, inverse: isFlashing && Math.ceil(remaining / 1000) % 2 === 0 }
}

/** How long before expiry an auto-refresh fires: room for the request to land. */
export const REFRESH_LEAD_MS: Record<CacheTtl, number> = { '5m': 30_000, '1h': 2 * 60_000 }

/**
 * Whether an idle session should refresh its cache now: auto-refresh is on with
 * refreshes left, the TTL is known, and the entry is warm but inside the lead.
 */
export function shouldAutoRefresh(cache: CacheInfo | null, now: number, limit: number, used: number): boolean {
  if (limit <= 0 || used >= limit || cache === null || cache.ttl === null) return false
  const remaining = cache.touchedAt + TTL_MS[cache.ttl] - now
  return remaining > 0 && remaining <= REFRESH_LEAD_MS[cache.ttl]
}

/**
 * The main conversation's TTL as Claude Code settles it, when it is set
 * explicitly: FORCE_PROMPT_CACHING_5M, then CLAUDE_CODE_PROMPT_CACHE_TTL, then
 * the `promptCacheTtl` setting. Unset means automatic, which only a response shows.
 */
export function configuredTtl(force5m: string | undefined, env: string | undefined, setting: unknown): CacheTtl | null {
  if (force5m !== undefined && force5m !== '' && force5m !== '0' && force5m.toLowerCase() !== 'false') return '5m'
  if (env === '5m' || env === '1h') return env
  if (setting === '5m' || setting === '1h') return setting
  return null
}

/** A count for `/context-band auto-refresh <n>`: a whole number from 0 to 99, else null. */
export function parseCount(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null
  return Number(text.trim())
}

function timeOfDay(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':')
}

/** The cache label's tooltip, one line: the TTL, and the times the countdown runs between. */
export function describeCache(cache: CacheInfo | null, now: number): string {
  if (cache === null) return 'Prompt cache: the countdown starts with your first prompt'
  if (cache.ttl === null) return `Prompt cache: last request ${timeOfDay(cache.touchedAt)} · TTL shows once the response is saved`
  const expiry = cache.touchedAt + TTL_MS[cache.ttl]
  return `${cache.ttl} TTL · last request ${timeOfDay(cache.touchedAt)} · ${expiry > now ? 'expires' : 'expired'} ${timeOfDay(expiry)}`
}

/** Auto-refreshes left in this idle stretch: 0 when off or spent. The button shows it as `↻ (n)`. */
export function refreshesLeft(limit: number, used: number): number {
  return limit > 0 ? Math.max(0, limit - used) : 0
}

/** The refresh button's tooltip, one line: what a press does, and where auto-refresh stands. */
export function describeRefresh(
  cache: CacheInfo,
  now: number,
  limit: number,
  used: number,
  isWorking: boolean,
  isSessionLimit = false,
): string {
  const auto = isSessionLimit ? 'auto-refresh (this session)' : 'auto-refresh'
  if (limit <= 0) return `Refresh cache now · ${auto} off`
  const left = refreshesLeft(limit, used)
  if (left === 0) return `Refresh cache now · ${auto}: 0 of ${limit} left until your next prompt`
  const ttl = cache.ttl ?? '5m'
  const nextAt = cache.touchedAt + TTL_MS[ttl] - REFRESH_LEAD_MS[ttl]
  const when = isWorking ? 'next once idle' : nextAt > now ? `next in ${ago(nextAt - now)}` : 'next now'
  return `Refresh cache now · ${auto}: ${left} of ${limit} left, ${when}`
}

/** What `/context-band auto-refresh …` asks for. */
export type AutoRefreshCommand =
  | { kind: 'show' }
  | { kind: 'session'; count: number }
  | { kind: 'reset' }
  | { kind: 'default'; count: number }
  | { kind: 'invalid' }

/**
 * Reads the words after `auto-refresh`: nothing shows the values, `<n>` sets
 * this session's count, `reset` returns this session to the default, and
 * `default <n>` sets the default every session follows.
 */
export function parseAutoRefresh(words: readonly string[]): AutoRefreshCommand {
  const [first, second, ...rest] = words
  if (first === undefined) return { kind: 'show' }
  if (rest.length > 0) return { kind: 'invalid' }
  if (first === 'reset' && second === undefined) return { kind: 'reset' }
  if (first === 'default') {
    const count = second === undefined ? null : parseCount(second)
    return count === null ? { kind: 'invalid' } : { kind: 'default', count }
  }
  const count = second === undefined ? parseCount(first) : null
  return count === null ? { kind: 'invalid' } : { kind: 'session', count }
}

/** Where a session's own count is kept in the plugin's store, by session id, so `--resume` finds it. */
export const SESSION_LIMIT_PREFIX = 'session-limit:'

/** A stored session count, as `$.store` hands it back: anything else reads as none. */
export function storedLimit(value: unknown): { limit: number; savedAt: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const { limit, savedAt } = value as { limit?: unknown; savedAt?: unknown }
  if (typeof limit !== 'number' || typeof savedAt !== 'number') return null
  return { limit, savedAt }
}

/** Session counts not touched for this long are dropped: that conversation is unlikely to be resumed. */
export const SESSION_LIMIT_KEEP_MS = 30 * 24 * 60 * 60_000

type TranscriptRow = {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  message?: {
    model?: string
    usage?: {
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null
    }
  }
}

/**
 * Reads the tail of a session transcript (JSONL) from the end: the time of the
 * newest main-thread response, and the TTL the newest response that wrote to
 * the cache wrote with. Where one response wrote to both buckets the shorter
 * wins, since that is when the conversation's own prefix lapses.
 */
export function parseTail(text: string): { ttl: CacheTtl | null; at: number | null } {
  const lines = text.split('\n')
  let at: number | null = null

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || !line.includes('"assistant"')) continue

    let row: TranscriptRow
    try {
      row = JSON.parse(line) as TranscriptRow
    } catch {
      continue // the first line of a tail is usually cut
    }
    if (row.type !== 'assistant' || row.isSidechain === true || row.message?.model === '<synthetic>') continue

    if (at === null && row.timestamp !== undefined) {
      const parsed = Date.parse(row.timestamp)
      if (!Number.isNaN(parsed)) at = parsed
    }

    const written = row.message?.usage?.cache_creation
    if (written === undefined || written === null) continue
    if ((written.ephemeral_5m_input_tokens ?? 0) > 0) return { ttl: '5m', at }
    if ((written.ephemeral_1h_input_tokens ?? 0) > 0) return { ttl: '1h', at }
  }

  return { ttl: null, at }
}
