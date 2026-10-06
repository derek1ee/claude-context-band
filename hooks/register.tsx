import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheTtl, CtxRow } from '../types'
import {
  LABEL_WIDTH,
  RESERVE,
  TTL_MS,
  cacheLabel,
  configuredTtl,
  describeCache,
  describeRefresh,
  describeRun,
  estimateTokens,
  formatTokens,
  layout,
  legendText,
  parseCount,
  parseTail,
  refreshesLeft,
  shouldAutoRefresh,
  squaresFor,
  tipLeft,
} from './layout'

const ctx = atom({ plugin: 'context-band', key: 'ctx' } as const, null)
const cache = atom({ plugin: 'context-band', key: 'cache' } as const, null)
const now = atom({ plugin: 'context-band', key: 'now' } as const, 0)
const draft = atom({ plugin: 'context-band', key: 'draft' } as const, 0)
const refreshes = atom({ plugin: 'context-band', key: 'refreshes' } as const, 0)
const isRefreshing = atom({ plugin: 'context-band', key: 'isRefreshing' } as const, false)

/** Enough of the transcript's end to hold the last few responses. */
const TAIL_BYTES = 1024 * 1024

/** The one user message a keep-alive fork sends after the main thread's last request. */
const KEEP_WARM_PROMPT = 'This is an automatic prompt-cache keep-alive, not a request. Reply with only: OK'

/** At least this long between auto-refresh attempts, so a failing one cannot spend the count at once. */
const AUTO_RETRY_MS = 15_000

let transcriptPath: string | undefined
let isMeasuring = false
let isMeasureDirty = false
/** How many squares the band last drew, for the legend command. */
let lastSquares = 50
/** The TTL the settings or environment pin, when they do; else only a response tells. */
let settingsTtl: CacheTtl | null = null
/** The `autoRefresh` option: how many keep-alive refreshes an idle stretch may spend. */
let autoLimit = 0
let lastAutoAttempt = 0
let isWorking = false

/** Re-reads /context's breakdown (local estimates, no API calls) into `ctx`; a failed read keeps the last. */
async function refreshContext($: EngineInterface): Promise<void> {
  if (isMeasuring) {
    isMeasureDirty = true
    return
  }
  isMeasuring = true
  try {
    do {
      isMeasureDirty = false
      const { context } = await $.session.usage({ breakdown: 'summary' })
      const breakdown = context.breakdown
      if (breakdown === undefined) return
      const rows: CtxRow[] = []
      for (const c of breakdown.categories) {
        if (c.kind === 'deferred' || c.tokens <= 0) continue
        rows.push({ name: c.name, color: c.color, tokens: c.tokens, kind: c.kind })
      }
      await update($, ctx, () => ({ window: breakdown.rawMaxTokens, rows }))
    } while (isMeasureDirty)
  } catch {
    // the band keeps drawing the last breakdown
  } finally {
    isMeasuring = false
  }
}

/** The transcript's last megabyte: `tail` where the host runs commands, else a whole read. */
async function transcriptTail($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
    if (exitCode === 0) return stdout
  } catch {
    // no host commands here; fall through to the filesystem
  }
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text.slice(-TAIL_BYTES) : undefined
  } catch {
    return undefined // over the 4 MiB a read allows, or gone
  }
}

/**
 * The session's transcript, for when no classic hook has named it yet (a hot
 * reload mid-session): `<config>/projects/<project dir, dashed>/<session id>.jsonl`,
 * else whichever project folder holds that id.
 */
async function findTranscript($: EngineInterface): Promise<string | undefined> {
  const id = await $.session.id()
  const home = await $.env.get('HOME')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
  if (config === undefined) return undefined
  const projects = `${config}/projects`

  for (const dir of [await $.session.root(), await $.session.cwd()]) {
    const path = `${projects}/${dir.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
    if (await $.fs.exists(path)) return path
  }
  try {
    for (const entry of await $.fs.list(projects)) {
      const path = `${projects}/${entry.name}/${id}.jsonl`
      if (entry.kind === 'dir' && (await $.fs.exists(path))) return path
    }
  } catch {
    // no projects folder
  }
  return undefined
}

/**
 * Learns the TTL from the transcript's usage rows. A stamp from `turn.step`
 * (request time) is kept over the transcript's (response time); the
 * transcript's stands in only after a resume, before this process sent one.
 */
async function readTranscript($: EngineInterface): Promise<void> {
  try {
    if (transcriptPath === undefined || transcriptPath === '') transcriptPath = await findTranscript($)
    if (transcriptPath === undefined) return
    const text = await transcriptTail($, transcriptPath)
    if (text === undefined) return
    const { ttl, at } = parseTail(text)
    await update($, cache, c => {
      if (c !== null) return { touchedAt: c.touchedAt, ttl: ttl ?? c.ttl }
      return at === null ? null : { touchedAt: at, ttl }
    })
  } catch {
    // no transcript to read here (a remote host, a test); the countdown runs on without it
  }
}

/** Restarts the countdown from `at`, when a request that read or wrote the cached prefix began. */
async function touch($: EngineInterface, at?: number): Promise<void> {
  const t = at ?? (await $.clock.now())
  await update($, cache, c => ({ touchedAt: t, ttl: c?.ttl ?? settingsTtl }))
  await update($, now, () => t)
}

/** Reads the TTL the settings pin: FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, `promptCacheTtl`. */
async function readSettingsTtl($: EngineInterface): Promise<void> {
  try {
    const settings: Record<string, unknown> = await $.settings.read()
    settingsTtl = configuredTtl(
      await $.env.get('FORCE_PROMPT_CACHING_5M'),
      await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      settings.promptCacheTtl,
    )
    if (settingsTtl !== null) await update($, cache, c => (c === null ? null : { ...c, ttl: c.ttl ?? settingsTtl }))
  } catch {
    settingsTtl = null
  }
}

/**
 * Keeps the prompt cache warm with one fork of the main thread's last request:
 * same model, system prompt, tools and messages, so the API serves the whole
 * prefix from the cache and restarts its timer, plus a one-line question whose
 * tail is never cached. Nothing joins the conversation. Resolves what happened.
 */
async function refreshCache($: EngineInterface, isAuto: boolean): Promise<string> {
  if (await read($, isRefreshing)) return 'A cache refresh is already running.'
  await update($, isRefreshing, () => true)
  try {
    const used = isAuto ? await update($, refreshes, n => n + 1) : 0
    const startedAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
    const which = isAuto ? `Cache auto-refreshed (${used} of ${autoLimit})` : 'Cache refreshed'
    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') return 'Nothing is cached yet: the session has no response to refresh.'
    const usage = 'usage' in reply ? reply.usage : undefined
    const hit = usage?.cache_read_input_tokens ?? 0
    const written = usage?.cache_creation_input_tokens ?? 0
    if (hit + written > 0) await touch($, startedAt)
    if (hit > 0) return `${which}: ${formatTokens(hit)} tokens read from the cache.`
    if (written > 0) return `${which}: it had already lapsed, so ${formatTokens(written)} tokens were cached again.`
    return `Cache refresh failed${reply.isAnswered ? '' : ` (${reply.reason})`}.`
  } catch {
    return 'Cache refresh failed.'
  } finally {
    await update($, isRefreshing, () => false)
  }
}

/** The `/context-band auto-refresh <n>` answer: sets the one option, 0 for off. */
async function setAutoRefresh($: EngineInterface, value: string | undefined): Promise<string> {
  if (value === undefined) {
    return autoLimit > 0
      ? `Auto-refresh is on: up to ${autoLimit} keep-alive refreshes while idle, counted again from each prompt you send. /context-band auto-refresh 0 turns it off.`
      : 'Auto-refresh is off. /context-band auto-refresh <n> keeps the cache warm up to n times while idle.'
  }
  const count = parseCount(value)
  if (count === null) return 'Usage: /context-band auto-refresh <n>, where n is 0 (off) to 99.'
  const result = await $.config.set({ key: 'context-band.autoRefresh', value: count })
  if (result.deny !== undefined) return `Auto-refresh unchanged: ${result.deny}`
  return count === 0
    ? 'Auto-refresh off.'
    : `Auto-refresh on: up to ${count} keep-alive refreshes while idle, each just before the cache expires, counted again from each prompt you send.`
}

/** Writes the draft's estimate only when it moves, so most keystrokes redraw nothing. */
async function setDraft($: EngineInterface, text: string): Promise<void> {
  const tokens = estimateTokens(text)
  if ((await read($, draft)) !== tokens) await update($, draft, () => tokens)
}

export const register: Register = (on, options) => {
  autoLimit = typeof options.autoRefresh === 'number' ? Math.max(0, Math.floor(options.autoRefresh)) : 0

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Checks every second; redraws only when the label's text would change:
    // each second while warm, each minute or hour once expired. While idle,
    // an auto-refresh fires just before expiry, as many times as the option allows.
    $.clock.every(1000, () => {
      void (async () => {
        const c = await read($, cache)
        if (c === null) return
        const t = await $.clock.now()
        if (cacheLabel(c, t).text !== cacheLabel(c, await read($, now)).text) await update($, now, () => t)
        if (isWorking || t - lastAutoAttempt < AUTO_RETRY_MS) return
        if (!shouldAutoRefresh(c, t, autoLimit, await read($, refreshes))) return
        lastAutoAttempt = t
        $.ui.toast(await refreshCache($, true))
      })()
    })

    await readSettingsTtl($)
    await refreshContext($)
    void readTranscript($)
    await $.command.register({
      name: 'context-band',
      description: "Explains the context band's squares, refreshes the prompt cache, or sets auto-refresh",
      argumentHint: '[refresh | auto-refresh <n>]',
    })
    return started
  })

  on('command.run', { command: 'context-band' }, async ($, e) => {
    const [sub = '', value] = e.args.trim().split(/\s+/)
    if (sub === 'auto-refresh') return { text: await setAutoRefresh($, value) }
    if (sub === 'refresh') return { text: await refreshCache($, false) }
    if (sub !== '') return { text: 'Usage: /context-band [refresh | auto-refresh <n>]' }

    const c = await read($, ctx)
    if (c === null) return { text: 'Context band: no breakdown yet.' }
    const info = await read($, cache)
    const t = await $.clock.now()
    const cacheLine =
      info === null || info.ttl === null
        ? 'Prompt cache: TTL not seen yet'
        : `Prompt cache: ${describeCache(info, t)}\nRefresh: ${describeRefresh(info, t, autoLimit, await read($, refreshes), isWorking)}`
    return { text: `${legendText(c, lastSquares, await read($, draft))}\n\n${cacheLine}` }
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) isWorking = false
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path !== '') transcriptPath = e.transcript_path
    void (async () => {
      if (e.source === 'clear') await update($, cache, () => null)
      await readTranscript($)
      await refreshContext($)
    })()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, cache, () => null)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      void refreshContext($)
      // a response just landed: the first one tells which TTL bucket this session writes to
      if ((await read($, cache))?.ttl === null) void readTranscript($)
    }
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    void setDraft($, box.text)
    return box
  })

  on('prompt.fill', async ($, e, next) => {
    const filled = await next(e)
    void $.prompt.read().then(
      box => setDraft($, box.text),
      () => undefined, // no composer to read
    )
    return filled
  })

  // Sending a prompt is activity: the draft empties and the auto-refresh count starts over.
  on('prompt.submit', async ($, e, next) => {
    void setDraft($, '')
    void update($, refreshes, () => 0)
    return next(e)
  })

  // Every main-loop request reads (and so re-arms) the cached prefix.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await touch($)
    const result = yield* next(e)
    if ((await read($, cache))?.ttl === null) void readTranscript($)
    return result
  })

  on('classic.Stop', async ($, e, next) => {
    if (e.transcript_path !== '') transcriptPath = e.transcript_path
    void readTranscript($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const c = await read($, ctx)
    if (c === null) return next(e)

    const info = await read($, cache)
    const t = await read($, now)
    const typed = await read($, draft)
    const used = await read($, refreshes)
    const refreshing = await read($, isRefreshing)
    const { Box, Button, Text } = $.ui.resolve(e)

    const columns = e.props.bodyColumns
    const n = squaresFor(columns - RESERVE)
    lastSquares = n
    const runs = layout(c, n, typed)
    const label = cacheLabel(info, t)

    // One entry per square: the run it belongs to and its tooltip.
    const squares = runs.flatMap(run => {
      const text = ` ${describeRun(run, c.window)} `
      return run.glyphs.map(glyph => ({ run, glyph, text }))
    })
    // The label and the refresh button show while the TTL is known; the
    // button only while there is a warm entry to keep alive.
    const isWarm = info !== null && info.ttl !== null && info.touchedAt + TTL_MS[info.ttl] > t
    const cacheTip = info !== null && label.text !== '' ? ` ${describeCache(info, t)} ` : undefined
    const refreshTip = info !== null && isWarm ? ` ${describeRefresh(info, t, autoLimit, used, e.props.isWorking)} ` : undefined

    // Tooltips reach no further right than the last square's glyph.
    const limit = n * 2 - 1

    // Each square and its tooltip share a hover scope. The tooltips are drawn
    // last, after every square, so the one revealed paints over its neighbours;
    // they stay on the band's row, which the band's site clips to.
    return (
      <Box flexDirection="row" justifyContent="space-between" width={columns}>
        <Box flexDirection="row">
          {squares.map(({ run, glyph }, i) => (
            <Box key={`sq-${i}`} hover={{ scope: `sq-${i}` }}>
              {run.kind === 'free' ? <Text dimColor>{`${glyph} `}</Text> : <Text color={run.color}>{`${glyph} `}</Text>}
            </Box>
          ))}
        </Box>
        <Box key="cache" flexDirection="row" justifyContent="flex-end" gap={1} width={LABEL_WIDTH}>
          <Box key="cache-label" hover={{ scope: 'cache' }}>
            <Text color={label.color} inverse={label.inverse}>
              {label.text}
            </Text>
          </Box>
          {isWarm ? (
            <Box key="refresh-button" hover={{ scope: 'refresh' }}>
              <Button
                key="refresh"
                label={`${refreshing ? '…' : '↻'} (${refreshesLeft(autoLimit, used)})`}
                plain
                dimColor
                onPress={() => {
                  void refreshCache($, false).then(message => $.ui.toast(message))
                }}
              />
            </Box>
          ) : null}
        </Box>
        {squares.map(({ run, text }, i) => (
          <Box
            key={`tip-${i}`}
            position="absolute"
            top={0}
            left={tipLeft(i, text.length, limit)}
            display="none"
            hover={{ display: 'flex', scope: `sq-${i}` }}
          >
            <Text color={run.color} inverse>
              {text}
            </Text>
          </Box>
        ))}
        {[
          { key: 'tip-cache', scope: 'cache', text: cacheTip, color: label.color },
          { key: 'tip-refresh', scope: 'refresh', text: refreshTip, color: 'text' },
        ].map(tip =>
          tip.text === undefined ? null : (
            // ends where the cache area begins, over the right end of the squares
            <Box
              key={tip.key}
              position="absolute"
              top={0}
              left={Math.max(0, columns - LABEL_WIDTH - tip.text.length)}
              display="none"
              hover={{ display: 'flex', scope: tip.scope }}
            >
              <Text color={tip.color} inverse>
                {tip.text}
              </Text>
            </Box>
          ),
        )}
      </Box>
    )
  })
}
