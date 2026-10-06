import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CtxRow } from '../types'
import {
  LABEL_WIDTH,
  RESERVE,
  cacheLabel,
  describeCache,
  describeRun,
  estimateTokens,
  layout,
  legendText,
  parseTail,
  squaresFor,
  tipLeft,
} from './layout'

const ctx = atom({ plugin: 'context-band', key: 'ctx' } as const, null)
const cache = atom({ plugin: 'context-band', key: 'cache' } as const, null)
const now = atom({ plugin: 'context-band', key: 'now' } as const, 0)
const draft = atom({ plugin: 'context-band', key: 'draft' } as const, 0)

/** Enough of the transcript's end to hold the last few responses. */
const TAIL_BYTES = 1024 * 1024

let transcriptPath: string | undefined
let isRefreshing = false
let isDirty = false
/** How many squares the band last drew, for the legend command. */
let lastSquares = 50

/** Re-reads /context's breakdown (local estimates, no API calls) into `ctx`; a failed read keeps the last. */
async function refreshContext($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    isDirty = true
    return
  }
  isRefreshing = true
  try {
    do {
      isDirty = false
      const { context } = await $.session.usage({ breakdown: 'summary' })
      const breakdown = context.breakdown
      if (breakdown === undefined) return
      const rows: CtxRow[] = []
      for (const c of breakdown.categories) {
        if (c.kind === 'deferred' || c.tokens <= 0) continue
        rows.push({ name: c.name, color: c.color, tokens: c.tokens, kind: c.kind })
      }
      await update($, ctx, () => ({ window: breakdown.rawMaxTokens, rows }))
    } while (isDirty)
  } catch {
    // the band keeps drawing the last breakdown
  } finally {
    isRefreshing = false
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

async function touch($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  await update($, cache, c => ({ touchedAt: t, ttl: c?.ttl ?? null }))
  await update($, now, () => t)
}

/** Writes the draft's estimate only when it moves, so most keystrokes redraw nothing. */
async function setDraft($: EngineInterface, text: string): Promise<void> {
  const tokens = estimateTokens(text)
  if ((await read($, draft)) !== tokens) await update($, draft, () => tokens)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // Checks every second; redraws only when the label's text would change:
    // each second while warm, each minute or hour once expired.
    $.clock.every(1000, () => {
      void (async () => {
        const c = await read($, cache)
        if (c === null) return
        const t = await $.clock.now()
        if (cacheLabel(c, t).text !== cacheLabel(c, await read($, now)).text) await update($, now, () => t)
      })()
    })

    await refreshContext($)
    void readTranscript($)
    await $.command.register({
      name: 'context-band',
      description: "Explains the context band's squares: each category's colour, tokens and share",
    })
    return started
  })

  on('command.run', { command: 'context-band' }, async $ => {
    const c = await read($, ctx)
    if (c === null) return { text: 'Context band: no breakdown yet.' }
    const info = await read($, cache)
    const cacheLine = info === null || info.ttl === null ? 'Prompt cache: TTL not seen yet' : `Prompt cache: ${describeCache(info, await $.clock.now())}`
    return { text: `${legendText(c, lastSquares, await read($, draft))}\n\n${cacheLine}` }
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

  on('prompt.submit', async ($, e, next) => {
    void setDraft($, '')
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
    const { Box, Text } = $.ui.resolve(e)

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
    const cacheTip = info !== null && label.text !== '' ? ` ${describeCache(info, t)} ` : undefined

    // Tooltips reach no further right than the last square's glyph.
    const limit = n * 2 - 1

    // Each square and its tooltip share a hover scope. The tooltips are drawn
    // last, after every square, so the one revealed paints over its neighbours;
    // they stay on the band's row, which the band's site clips to.
    return (
      <Box flexDirection="row" justifyContent="space-between" width={columns} marginTop={1}>
        <Box flexDirection="row">
          {squares.map(({ run, glyph }, i) => (
            <Box key={`sq-${i}`} hover={{ scope: `sq-${i}` }}>
              {run.kind === 'free' ? <Text dimColor>{`${glyph} `}</Text> : <Text color={run.color}>{`${glyph} `}</Text>}
            </Box>
          ))}
        </Box>
        <Box key="cache" hover={{ scope: 'cache' }} flexDirection="row" justifyContent="flex-end" width={LABEL_WIDTH}>
          <Text color={label.color}>{label.text}</Text>
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
        {cacheTip === undefined ? null : (
          <Box
            key="tip-cache"
            position="absolute"
            top={0}
            left={Math.max(0, columns - LABEL_WIDTH - cacheTip.length)}
            display="none"
            hover={{ display: 'flex', scope: 'cache' }}
          >
            <Text color={label.color} inverse>
              {cacheTip}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
