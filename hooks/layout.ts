import type { CacheInfo, CacheTtl, Ctx, CtxRow } from '../types'

/** What a square stands for: a /context category's kind, or the draft not yet sent. */
export type SquareKind = CtxRow['kind'] | 'pending'

/**
 * /context's own glyphs: a full square, a category's last square when under
 * 70% full, free space (drawn dim), the compaction buffer. The draft borrows
 * the free square, drawn in the messages colour: room about to be taken.
 */
export const GLYPH = { full: '⛁', partial: '⛀', free: '⛶', buffer: '⛝' } as const

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
 */
export function layout(ctx: Ctx, n: number, draft = 0): Run[] {
  const share = (tokens: number) => (tokens / ctx.window) * n
  const used = ctx.rows.filter(r => r.kind === 'used')
  const free = ctx.rows.find(r => r.kind === 'free')
  const buffer = ctx.rows.find(r => r.kind === 'buffer')
  const bufferCount = buffer === undefined ? 0 : Math.max(1, Math.round(share(buffer.tokens)))

  const runs: Run[] = []
  let drawn = 0
  const push = (kind: SquareKind, name: string, color: string, tokens: number, glyph: string) => {
    drawn += 1
    const last = runs.at(-1)
    if (last !== undefined && last.kind === kind && last.name === name) {
      last.count += 1
      last.glyphs.push(glyph)
      last.text += `${glyph} `
    } else {
      runs.push({ kind, name, color, tokens, count: 1, glyphs: [glyph], text: `${glyph} ` })
    }
  }

  for (const row of used) {
    const exact = share(row.tokens)
    const whole = Math.floor(exact)
    const count = Math.max(1, Math.round(exact))
    for (let i = 0; i < count && drawn < n; i++) {
      const fullness = i === whole && exact > whole ? exact - whole : 1
      push('used', row.name, row.color, row.tokens, fullness >= 0.7 ? GLYPH.full : GLYPH.partial)
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

/**
 * The right-hand label: the time left while warm, how long ago it lapsed once
 * expired. Empty until a response in the transcript shows which TTL bucket
 * the session writes to, so it never counts down against a guess.
 */
export function cacheLabel(cache: CacheInfo | null, now: number): { text: string; color: string } {
  if (cache === null || cache.ttl === null) return { text: '', color: 'inactive' }

  const expiry = cache.touchedAt + TTL_MS[cache.ttl]
  const remaining = expiry - Math.max(now, cache.touchedAt)

  if (remaining <= 0) return { text: `cache expired ${ago(-remaining)} ago`, color: 'error' }

  const color = remaining <= TTL_MS[cache.ttl] * 0.2 ? 'warning' : 'success'
  return { text: `cache ${cache.ttl} ${clock(remaining)}`, color }
}

function timeOfDay(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':')
}

/** The cache label's tooltip, one line: the TTL, and the times the countdown runs between. */
export function describeCache(cache: CacheInfo, now: number): string {
  const ttl = cache.ttl ?? '5m'
  const expiry = cache.touchedAt + TTL_MS[ttl]
  return `${ttl} TTL · last request ${timeOfDay(cache.touchedAt)} · ${expiry > now ? 'expires' : 'expired'} ${timeOfDay(expiry)}`
}

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
