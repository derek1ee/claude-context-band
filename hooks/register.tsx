import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentCache, CacheInfo, CacheTtl, CtxRow } from '../types'
import type { BandClientProps } from './band-client'
import type { HerdrPane, HerdrShow } from './herdr'
import {
  PREVIEW_MS,
  SETUP_ROWS,
  SETUP_TOKEN,
  agentName,
  clearArgv,
  flashName,
  herdrPane,
  laysOutAgents,
  previewCache,
  setArgv,
  showsToken,
  tokenValue,
  withSetup,
  withoutSetup,
} from './herdr'
import type { TurnPhase } from './layout'
import {
  LABEL_WIDTH,
  RESERVE,
  TTL_MS,
  addedLine,
  addedSince,
  agentContext,
  cacheLabel,
  configuredTtl,
  describeAdded,
  describeCache,
  describeRefresh,
  estimateTokens,
  SESSION_LIMIT_KEEP_MS,
  SESSION_LIMIT_PREFIX,
  formatTokens,
  isFlashing,
  isNewGlyph,
  layout,
  legendText,
  parseAutoRefresh,
  parseTail,
  refreshesLeft,
  shouldAutoRefresh,
  squaresFor,
  storedLimit,
  tipLeft,
} from './layout'

const ctx = atom({ plugin: 'context-band', key: 'ctx' } as const, null)
const cache = atom({ plugin: 'context-band', key: 'cache' } as const, null)
const now = atom({ plugin: 'context-band', key: 'now' } as const, 0)
const draft = atom({ plugin: 'context-band', key: 'draft' } as const, 0)
const refreshes = atom({ plugin: 'context-band', key: 'refreshes' } as const, 0)
const isRefreshing = atom({ plugin: 'context-band', key: 'isRefreshing' } as const, false)
const sessionLimit = atom({ plugin: 'context-band', key: 'sessionLimit' } as const, null)
const baseline = atom({ plugin: 'context-band', key: 'baseline' } as const, null)
const agents = atom({ plugin: 'context-band', key: 'agents' } as const, {})

/** Enough of the transcript's end to hold the last few responses. */
const TAIL_BYTES = 1024 * 1024

/** The one user message a keep-alive fork sends after the main thread's last request. */
const KEEP_WARM_PROMPT = 'This is an automatic prompt-cache keep-alive, not a request. Reply with only: OK'

/** At least this long between auto-refresh attempts, so a failing one cannot spend the count at once. */
const AUTO_RETRY_MS = 15_000

/**
 * While the TTL is unknown after a request, the transcript is read again this
 * often, for up to TTL_POLL_FOR_MS: Claude Code saves a response's row a moment
 * after the response, so a read when it lands can come too early.
 */
const TTL_POLL_MS = 2000
const TTL_POLL_FOR_MS = 60_000

let transcriptPath: string | undefined
let isMeasuring = false
let isMeasureDirty = false
/** How many squares the band last drew, for the legend command. */
let lastSquares = 50
/** The TTL the settings or environment pin, when they do; else only a response tells. */
let settingsTtl: CacheTtl | null = null
/** The `autoRefresh` option: the default count of keep-alive refreshes an idle stretch may spend. */
let autoLimit = 0
let lastAutoAttempt = 0
let lastTtlPoll = 0
/**
 * When the newest main-thread request began, until the transcript shows its
 * response: the TTL is read again until then, so a change (5m past the usage
 * limits, 1h again after) shows within seconds, whatever the turn's end does.
 */
let ttlPendingSince: number | null = null
let isWorking = false
/** The agent whose transcript is in view above the band, as its last draw said; undefined for the main conversation. */
let viewedAgent: string | undefined
/** When each agent's transcript was last read, so a draw or a tick reads it at most every TTL_POLL_MS. */
const agentReadAt = new Map<string, number>()
/** The agents the band keeps a cache for, the most recently active first; past this the oldest is dropped. */
const AGENTS_KEPT = 40
/** The `herdr` option: flash this session's entry in Herdr's agent list. */
let isHerdrOn = true
/** This session's Herdr pane, when it runs in one. */
let herdrFound: HerdrPane | null = null
/** When `/context-band herdr preview` began, while it runs. */
let previewFrom: number | null = null
/** What Herdr shows for the pane from us, null while it shows its own. */
let herdrShown: HerdrShow | null = null
/**
 * How the entry flashes, decided as each flashing stretch begins: the coloured
 * token when Herdr's config shows it, else the agent's own name renamed.
 */
let herdrLook: { kind: 'token' } | { kind: 'name'; base: string } | null = null
let isHerdrSending = false

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
    if (ttlPendingSince !== null && at !== null && at >= ttlPendingSince) ttlPendingSince = null
    await update($, cache, c => {
      if (c !== null) return { touchedAt: c.touchedAt, ttl: ttl ?? c.ttl }
      return at === null ? null : { touchedAt: at, ttl }
    })
  } catch {
    // no transcript to read here (a remote host, a test); the countdown runs on without it
  }
}

/** Changes one agent's entry; past AGENTS_KEPT, the one least recently active goes. */
async function setAgent($: EngineInterface, id: string, change: (a: AgentCache | undefined) => AgentCache): Promise<void> {
  await update($, agents, all => {
    const next: Record<string, AgentCache> = { ...all, [id]: change(all[id]) }
    const ids = Object.keys(next)
    if (ids.length > AGENTS_KEPT) {
      const oldest = ids.filter(other => other !== id).sort((a, b) => (next[a]?.cache?.touchedAt ?? 0) - (next[b]?.cache?.touchedAt ?? 0))[0]
      if (oldest !== undefined) delete next[oldest]
    }
    return next
  })
}

/**
 * Reads an agent's own transcript (beside the session's, under `subagents/`)
 * for the TTL its requests write with, and, for an agent first seen here (one
 * that began before a reload), when it last answered and how big its context is.
 */
async function readAgentTranscript($: EngineInterface, id: string): Promise<void> {
  agentReadAt.set(id, await $.clock.now())
  try {
    if (transcriptPath === undefined || transcriptPath === '') transcriptPath = await findTranscript($)
    if (transcriptPath === undefined) return
    const text = await transcriptTail($, `${transcriptPath.replace(/\.jsonl$/, '')}/subagents/agent-${id}.jsonl`)
    if (text === undefined) return
    const { ttl, at, tokens } = parseTail(text, true)
    await setAgent($, id, a => ({
      cache: a?.cache ? { touchedAt: a.cache.touchedAt, ttl: ttl ?? a.cache.ttl } : at === null ? null : { touchedAt: at, ttl },
      tokens: a?.tokens ?? tokens,
    }))
  } catch {
    // no transcript for it (a workflow's agent, a fork): the band shows what its requests told
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
    const which = isAuto ? `Cache auto-refreshed (${used} of ${(await limitNow($)).limit})` : 'Cache refreshed'
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

/** The auto-refresh count in force: this session's own when it set one, else the default. */
async function limitNow($: EngineInterface): Promise<{ limit: number; isSession: boolean }> {
  const own = await read($, sessionLimit)
  return own === null ? { limit: autoLimit, isSession: false } : { limit: own, isSession: true }
}

/**
 * Sets this session's own count (null follows the default again) and keeps it
 * in the store under the session's id, so `--resume` and `--continue`, which
 * keep the id, bring it back. A new count starts a fresh allowance.
 */
async function setSessionLimit($: EngineInterface, limit: number | null, sessionId?: string): Promise<void> {
  await update($, sessionLimit, () => limit)
  await update($, refreshes, () => 0)
  await saveSessionLimit($, limit, sessionId)
}

async function saveSessionLimit($: EngineInterface, limit: number | null, sessionId?: string): Promise<void> {
  try {
    const key = `${SESSION_LIMIT_PREFIX}${sessionId ?? (await $.session.id())}`
    if (limit === null) await $.store.delete(key)
    else await $.store.set(key, { limit, savedAt: await $.clock.now() })
  } catch {
    // kept for this window only
  }
}

/** Takes up the count a session saved, when it is resumed; drops counts left untouched for a month. */
async function loadSessionLimit($: EngineInterface, sessionId?: string): Promise<void> {
  try {
    const id = sessionId ?? (await $.session.id())
    const saved = storedLimit(await $.store.get(`${SESSION_LIMIT_PREFIX}${id}`))
    await update($, sessionLimit, () => saved?.limit ?? null)

    const t = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SESSION_LIMIT_PREFIX)) continue
      const old = storedLimit(await $.store.get(key))
      if (old === null || t - old.savedAt > SESSION_LIMIT_KEEP_MS) await $.store.delete(key)
    }
  } catch {
    // no store here: the session follows the default
  }
}

async function describeRefreshNow($: EngineInterface, info: CacheInfo, t: number, working: boolean): Promise<string> {
  const { limit, isSession } = await limitNow($)
  return describeRefresh(info, t, limit, await read($, refreshes), working, isSession)
}

function describeLimit(limit: number): string {
  return limit === 0 ? 'off' : `up to ${limit} keep-alive refreshes while idle`
}

/**
 * `/context-band auto-refresh …`: `<n>` for this session, `reset` back to the
 * default, `default <n>` for every session, nothing to show both.
 */
async function autoRefreshCommand($: EngineInterface, words: readonly string[]): Promise<string> {
  const command = parseAutoRefresh(words)
  const own = await read($, sessionLimit)
  switch (command.kind) {
    case 'show':
      return own === null
        ? `Auto-refresh: ${describeLimit(autoLimit)} (the default). /context-band auto-refresh <n> sets this session's own.`
        : `Auto-refresh for this session: ${describeLimit(own)}. The default is ${describeLimit(autoLimit)}; /context-band auto-refresh reset follows it again.`
    case 'session':
      await setSessionLimit($, command.count)
      return command.count === 0
        ? 'Auto-refresh off for this session.'
        : `Auto-refresh for this session: ${describeLimit(command.count)}, each just before the cache expires, counted again from each prompt you send. Other sessions keep the default (${autoLimit === 0 ? 'off' : autoLimit}).`
    case 'reset':
      await setSessionLimit($, null)
      return `This session follows the default again: auto-refresh ${describeLimit(autoLimit)}.`
    case 'default': {
      const result = await $.config.set({ key: 'context-band.autoRefresh', value: command.count })
      if (result.deny !== undefined) return `Default unchanged: ${result.deny}`
      const note = own === null ? '' : ` This session keeps its own (${own}) until /context-band auto-refresh reset.`
      return `Default auto-refresh for every session: ${describeLimit(command.count)}.${note}`
    }
    case 'invalid':
      return 'Usage: /context-band auto-refresh [<n> | reset | default <n>], n from 0 (off) to 99.'
  }
}

/** Notes the Herdr pane this session runs in, from the variables Herdr sets in each pane. */
async function findHerdr($: EngineInterface): Promise<void> {
  try {
    herdrFound = herdrPane({
      HERDR_ENV: await $.env.get('HERDR_ENV'),
      HERDR_PANE_ID: await $.env.get('HERDR_PANE_ID'),
      HERDR_BIN_PATH: await $.env.get('HERDR_BIN_PATH'),
      HERDR_CONFIG_PATH: await $.env.get('HERDR_CONFIG_PATH'),
      HOME: await $.env.get('HOME'),
      APPDATA: await $.env.get('APPDATA'),
    })
  } catch {
    herdrFound = null // no environment to read here
  }
}

/** Brings what Herdr shows for the pane to `want` (null: its own), one call at a time; a failed call is tried again next beat. */
async function showHerdr($: EngineInterface, h: HerdrPane, want: HerdrShow | null): Promise<void> {
  const shown = herdrShown
  const isSame = want !== null && shown !== null && want.kind === shown.kind && want.value === shown.value
  const argv = want !== null ? setArgv(h, want) : shown !== null ? clearArgv(h, shown.kind) : null
  if (isHerdrSending || isSame || argv === null) return
  isHerdrSending = true
  try {
    const { exitCode } = await $.process.run(argv, { timeoutMs: 3000 })
    if (exitCode === 0) herdrShown = want
  } catch {
    // no host commands here, or Herdr is gone; its TTL clears what was left set
  } finally {
    isHerdrSending = false
  }
}

async function readHerdrBase($: EngineInterface, h: HerdrPane): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run([h.bin, 'agent', 'get', h.pane], { timeoutMs: 3000 })
    if (exitCode === 0) return agentName(stdout)
  } catch {
    // keep the default
  }
  return 'claude'
}

/** Herdr's config as text: empty when there is no file yet, null when it can't be read. */
async function readHerdrConfig($: EngineInterface, h: HerdrPane): Promise<string | null> {
  if (h.config === null) return null
  try {
    const text = await $.fs.read(h.config)
    return typeof text === 'string' ? text : null
  } catch {
    try {
      return (await $.fs.exists(h.config)) ? null : ''
    } catch {
      return null
    }
  }
}

async function readHerdrLook($: EngineInterface, h: HerdrPane): Promise<NonNullable<typeof herdrLook>> {
  const config = await readHerdrConfig($, h)
  if (config !== null && showsToken(config)) return { kind: 'token' }
  return { kind: 'name', base: await readHerdrBase($, h) }
}

/**
 * Called each second with the cache the band counts down: outside the flashing
 * stretch it hands the entry back to Herdr (a call only when ours is showing);
 * inside, it shows the coloured countdown, or the renamed entry on the beats.
 */
async function flashHerdr($: EngineInterface, h: HerdrPane, info: CacheInfo | null, t: number): Promise<void> {
  if (!isFlashing(info, t)) {
    herdrLook = null
    return showHerdr($, h, null)
  }
  herdrLook ??= await readHerdrLook($, h)
  const value = herdrLook.kind === 'token' ? tokenValue(info, t) : flashName(herdrLook.base, info, t)
  return showHerdr($, h, value === null ? null : { kind: herdrLook.kind, value })
}

/**
 * Saves Herdr's config as `after`, has Herdr check it, putting `before` back
 * when Herdr rejects it, then has the running server reload it. Resolves
 * Herdr's complaint when it rejected the file, else whether the reload took.
 */
async function saveHerdrConfig(
  $: EngineInterface,
  h: HerdrPane,
  path: string,
  before: string,
  after: string,
): Promise<{ rejected: string } | { isReloaded: boolean }> {
  await $.fs.write(path, after)
  const check = await $.process.run([h.bin, 'config', 'check'], { timeoutMs: 10_000 })
  if (check.exitCode !== 0) {
    await $.fs.write(path, before)
    return { rejected: `${check.stdout}${check.stderr}`.trim() }
  }
  const reload = await $.process.run([h.bin, 'server', 'reload-config'], { timeoutMs: 10_000 })
  return { isReloaded: reload.exitCode === 0 }
}

/**
 * `/context-band herdr setup [remove]`: adds the coloured countdown to Herdr's
 * config for Claude entries, or takes it out. A config that already lays out
 * the agent list is left alone, with the lines to add by hand.
 */
async function herdrSetup($: EngineInterface, h: HerdrPane, isRemove: boolean): Promise<string> {
  const path = h.config
  if (path === null) return "Herdr setup: can't tell where Herdr's config is (neither HERDR_CONFIG_PATH nor HOME is set). Nothing changed."
  const before = await readHerdrConfig($, h)
  if (before === null) return `Herdr setup: couldn't read ${path}. Nothing changed.`
  const reloadNote = (isReloaded: boolean) => (isReloaded ? ' and reloaded Herdr' : '; run herdr server reload-config to apply it')

  try {
    if (isRemove) {
      const after = withoutSetup(before)
      if (after === null) return `Herdr setup: ${path} has no context-band rows to remove.`
      const saved = await saveHerdrConfig($, h, path, before, after)
      if ('rejected' in saved) return `Herdr setup: Herdr rejected the change, so ${path} is back as it was.\n${saved.rejected}`
      herdrLook = null
      return `Took the countdown rows out of ${path}${reloadNote(saved.isReloaded)}. The entry goes back to flashing its name.`
    }

    if (showsToken(before)) return `Herdr setup: ${path} already shows $context_band, so the countdown flashes there in colour. /context-band herdr preview shows it.`
    if (laysOutAgents(before)) {
      return [
        `Herdr setup: ${path} already lays out Herdr's agent list, so setup leaves it to you rather than replace your rows. Add the countdown to the row you want, after "agent" for example:`,
        `  ${SETUP_TOKEN}`,
        `Or, for Claude entries only, Herdr's default rows with it:`,
        SETUP_ROWS,
        'Then run: herdr server reload-config',
      ].join('\n\n')
    }

    const backup = `${path}.context-band-backup`
    if (before !== '') await $.fs.write(backup, before)
    const saved = await saveHerdrConfig($, h, path, before, withSetup(before))
    if ('rejected' in saved) return `Herdr setup: Herdr rejected the change, so ${path} is back as it was.\n${saved.rejected}`
    herdrLook = null
    const kept = before === '' ? '' : ` (the old file is at ${backup})`
    return `Added the countdown rows for Claude entries to ${path}${kept}${reloadNote(saved.isReloaded)}. Through a 1h cache's last 5 minutes, the entry shows the countdown after its name, yellow, flashing red. /context-band herdr preview shows it; /context-band herdr setup remove takes it out.`
  } catch (error) {
    return `Herdr setup: couldn't change ${path} (${error instanceof Error ? error.message : String(error)}).`
  }
}

const HERDR_USAGE = 'Usage: /context-band herdr [preview | setup [remove] | on | off]'

/** `/context-band herdr …`: nothing to show where it stands, `preview` to see it, `setup` for colour, `on` or `off`. */
async function herdrCommand($: EngineInterface, words: readonly string[]): Promise<string> {
  const [word = '', ...rest] = words
  const isSetup = word === 'setup' && (rest.length === 0 || (rest.length === 1 && rest[0] === 'remove'))
  if (!isSetup && (rest.length > 0 || !['', 'preview', 'on', 'off'].includes(word))) return HERDR_USAGE
  if (word === 'on' || word === 'off') {
    const result = await $.config.set({ key: 'context-band.herdr', value: word === 'on' })
    if (result.deny !== undefined) return `Herdr setting unchanged: ${result.deny}`
    return word === 'on'
      ? "Herdr: on. Inside Herdr, this session's entry in the agent list flashes through a 1h cache's last 5 minutes."
      : "Herdr: off. The band leaves Herdr's agent list alone."
  }
  if (herdrFound === null) {
    return "Herdr: this session isn't running inside Herdr, so there's nothing to flash. In a Herdr pane, the session's entry in Herdr's agent list flashes through a 1h cache's last 5 minutes."
  }
  if (isSetup) return herdrSetup($, herdrFound, rest[0] === 'remove')
  if (!isHerdrOn) return "Herdr: off. /context-band herdr on flashes this session's entry in Herdr's agent list through a 1h cache's last 5 minutes."
  if (word === 'preview') {
    const t = await $.clock.now()
    previewFrom = t
    await flashHerdr($, herdrFound, previewCache(t), t)
    return `Herdr preview: for ${PREVIEW_MS / 1000} seconds, this session's entry in Herdr's agent list flashes as it will through a 1h cache's last 5 minutes, counting down from 5:00.`
  }
  const config = await readHerdrConfig($, herdrFound)
  const look =
    config !== null && showsToken(config)
      ? 'shows the countdown after its name, yellow, flashing red (your Herdr config shows $context_band)'
      : 'flashes its name with the countdown; /context-band herdr setup adds a coloured countdown instead'
  return `Herdr: on (pane ${herdrFound.pane}). Through a 1h cache's last 5 minutes, this session's entry in Herdr's agent list ${look}. /context-band herdr preview shows it for ${PREVIEW_MS / 1000} seconds; /context-band herdr off turns it off.`
}

/**
 * Keeps each category's tokens as a turn begins: what the band compares
 * against to draw that turn's growth solid, while it runs and until the next.
 */
async function snapshotBaseline($: EngineInterface): Promise<void> {
  const c = await read($, ctx)
  const snapshot: Record<string, number> = {}
  for (const row of c?.rows ?? []) if (row.kind === 'used') snapshot[row.name] = row.tokens
  await update($, baseline, () => (c === null ? null : snapshot))
}

/** Writes the draft's estimate only when it moves, so most keystrokes redraw nothing. */
async function setDraft($: EngineInterface, text: string): Promise<void> {
  const tokens = estimateTokens(text)
  if ((await read($, draft)) !== tokens) await update($, draft, () => tokens)
}

export const register: Register = (on, options) => {
  autoLimit = typeof options.autoRefresh === 'number' ? Math.max(0, Math.floor(options.autoRefresh)) : 0
  isHerdrOn = options.herdr !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await findHerdr($)

    // Checks every second; redraws only when the label's text would change:
    // each second while warm, each minute or hour once expired. Inside Herdr,
    // the agent list's entry flashes in step with the label. While idle, an
    // auto-refresh fires just before expiry, as many times as the option allows.
    $.clock.every(1000, () => {
      void (async () => {
        const c = await read($, cache)
        const t = await $.clock.now()
        if (herdrFound !== null && isHerdrOn) {
          if (previewFrom !== null && t - previewFrom >= PREVIEW_MS) previewFrom = null
          void flashHerdr($, herdrFound, previewFrom === null ? c : previewCache(previewFrom), t)
        }
        // the label redraws when its text would change: the main thread's, or the agent's in view
        const seen = viewedAgent === undefined ? undefined : (await read($, agents))[viewedAgent]
        const shown = await read($, now)
        const isTicking = (info: CacheInfo | null | undefined) => info != null && cacheLabel(info, t).text !== cacheLabel(info, shown).text
        if (isTicking(c) || isTicking(seen?.cache)) await update($, now, () => t)
        if (viewedAgent !== undefined && (seen?.cache?.ttl ?? null) === null && t - (agentReadAt.get(viewedAgent) ?? 0) >= TTL_POLL_MS) {
          void readAgentTranscript($, viewedAgent)
        }
        if (c === null) return
        // a request's response tells its TTL once Claude Code has saved it: read until it shows, for up to a minute
        const waitingSince = ttlPendingSince ?? (c.ttl === null ? c.touchedAt : null)
        if (waitingSince !== null && t - waitingSince < TTL_POLL_FOR_MS && t - lastTtlPoll >= TTL_POLL_MS) {
          lastTtlPoll = t
          void readTranscript($)
        }
        if (isWorking || t - lastAutoAttempt < AUTO_RETRY_MS) return
        if (!shouldAutoRefresh(c, t, (await limitNow($)).limit, await read($, refreshes))) return
        lastAutoAttempt = t
        $.ui.toast(await refreshCache($, true))
      })()
    })

    await readSettingsTtl($)
    await loadSessionLimit($)
    await refreshContext($)
    void readTranscript($)
    await $.command.register({
      name: 'context-band',
      description: "Explains the context band's squares, refreshes the prompt cache, or sets auto-refresh",
      argumentHint: '[refresh | auto-refresh [<n> | reset | default <n>] | herdr [preview | setup [remove] | on | off]]',
    })
    return started
  })

  on('command.run', { command: 'context-band' }, async ($, e) => {
    const [sub = '', ...words] = e.args.trim().split(/\s+/).filter(word => word !== '')
    if (sub === 'auto-refresh') return { text: await autoRefreshCommand($, words) }
    if (sub === 'refresh' && words.length === 0) return { text: await refreshCache($, false) }
    if (sub === 'herdr') return { text: await herdrCommand($, words) }
    if (sub !== '') return { text: 'Usage: /context-band [refresh | auto-refresh [<n> | reset | default <n>] | herdr [preview | setup [remove] | on | off]]' }

    const c = await read($, ctx)
    if (c === null) return { text: 'Context band: no breakdown yet.' }
    const info = await read($, cache)
    const t = await $.clock.now()
    const cacheLine =
      info === null || info.ttl === null
        ? describeCache(info, t)
        : `Prompt cache: ${describeCache(info, t)}\nRefresh: ${await describeRefreshNow($, info, t, isWorking)}`
    const base = await read($, baseline)
    const turnLine = base === null ? '' : `\n${addedLine(addedSince(c, base), isWorking ? 'this' : 'last')}`
    return { text: `${legendText(c, lastSquares, await read($, draft))}${turnLine}\n\n${cacheLine}` }
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    await snapshotBaseline($)
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
      if (e.source === 'clear' || e.source === 'resume') await update($, baseline, () => null)
      if (e.source === 'clear' || e.source === 'resume') await update($, agents, () => ({}))
      // /clear keeps this window's own count under the new id; /resume takes up the resumed one's
      if (e.source === 'clear') await saveSessionLimit($, await read($, sessionLimit), e.session_id)
      if (e.source === 'resume') await loadSessionLimit($, e.session_id)
      await readTranscript($)
      await refreshContext($)
    })()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, cache, () => null)
    if (e.reason === 'clear') await update($, baseline, () => null)
    if (herdrFound !== null && herdrShown !== null) await showHerdr($, herdrFound, null)
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

  // Every request reads (and so re-arms) its loop's cached prefix: the main
  // thread's, or an agent's own, which the band shows while that agent is in view.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    if (e.agentId !== undefined) {
      const id = e.agentId
      await setAgent($, id, a => ({ cache: { touchedAt: startedAt, ttl: a?.cache?.ttl ?? null }, tokens: a?.tokens ?? null }))
      const result = yield* next(e)
      const usage = result.usage
      if (usage !== null) {
        const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
        await setAgent($, id, a => ({ cache: a?.cache ?? null, tokens }))
      }
      if (id === viewedAgent) void readAgentTranscript($, id)
      return result
    }
    await touch($, startedAt)
    ttlPendingSince = startedAt
    const result = yield* next(e)
    void readTranscript($)
    return result
  })

  on('classic.Stop', async ($, e, next) => {
    if (e.transcript_path !== '') transcriptPath = e.transcript_path
    void readTranscript($)
    return next(e)
  })

  // The band's refresh button lives in its Client, which posts here when pressed.
  on('ui.message', async ($, e, next) => {
    const data: unknown = e.data
    if (e.element === 'band' && typeof data === 'object' && data !== null && (data as { refresh?: unknown }).refresh === true) {
      void refreshCache($, false).then(message => $.ui.toast(message))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // The row is a Client, which the terminal and the desktop draw.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const c = await read($, ctx)
    if (c === null) return next(e)

    const t = await read($, now)
    // the transcript in view: the main conversation's, or one agent's, opened from the tasks list
    const viewing = e.props.view.agentId
    // the next tick reads an agent's transcript once it's in view
    viewedAgent = viewing
    const agent = viewing === undefined ? undefined : (await read($, agents))[viewing]
    const isAgentUnread = viewing !== undefined && (agent?.cache ?? null) === null
    const info = viewing === undefined ? await read($, cache) : (agent?.cache ?? null)
    const shown = viewing === undefined ? c : agentContext(c, agent?.tokens ?? null)
    const typed = await read($, draft)
    const grown = viewing === undefined ? addedSince(c, await read($, baseline)) : {}
    const phase: TurnPhase = e.props.isWorking ? 'this' : 'last'
    const used = await read($, refreshes)
    const { limit: autoNow, isSession } = await limitNow($)
    const refreshing = await read($, isRefreshing)
    const { Client } = $.ui.resolve(e)

    const columns = e.props.bodyColumns
    const n = squaresFor(columns - RESERVE)
    lastSquares = n
    const runs = layout(shown, n, typed, grown)
    const label = isAgentUnread ? { text: 'cache …', color: 'inactive', inverse: false } : cacheLabel(info, t)

    // Tooltip texts, each kept once; squares and the label point at theirs.
    const tips: BandClientProps['tips'] = []
    const tipIndex = new Map<string, number>()
    const tipOf = (text: string, color: string): number => {
      const key = `${color} ${text}`
      const known = tipIndex.get(key)
      if (known !== undefined) return known
      tips.push({ text, color })
      tipIndex.set(key, tips.length - 1)
      return tips.length - 1
    }

    // Square tooltips reach no further right than the last square's glyph. A
    // square the turn added says so first, and names the solid glyph so it can be learned.
    const limit = n * 2 - 1
    const squares: BandClientProps['squares'] = []
    for (const run of runs) {
      for (const glyph of run.glyphs) {
        const text = ` ${describeAdded(run, shown.window, phase, isNewGlyph(glyph))} `
        squares.push({ tip: tipOf(text, run.color), x: tipLeft(squares.length, text.length, limit) })
      }
    }

    // The label's and the button's tooltips end where the label area begins.
    const tipBefore = (text: string) => Math.max(0, columns - LABEL_WIDTH - text.length)
    const cacheTip = isAgentUnread ? " This agent's prompt cache: reading its transcript " : ` ${describeCache(info, t)} `
    // The button shows only while there is a warm entry to keep alive, and only the main thread's: a refresh forks it.
    const isWarm = viewing === undefined && info !== null && info.ttl !== null && info.touchedAt + TTL_MS[info.ttl] > t
    const refreshTip = info !== null && isWarm ? ` ${describeRefresh(info, t, autoNow, used, e.props.isWorking, isSession)} ` : null

    const band: BandClientProps = {
      columns,
      labelWidth: LABEL_WIDTH,
      runs: runs.map(run => ({ text: run.text, color: run.color, dim: run.kind === 'free' })),
      squares,
      tips,
      label: { ...label, tip: tipOf(cacheTip, label.color), x: tipBefore(cacheTip) },
      button:
        refreshTip === null
          ? null
          : { text: `${refreshing ? '…' : '↻'} (${refreshesLeft(autoNow, used)})`, tip: tipOf(refreshTip, 'text'), x: tipBefore(refreshTip) },
    }

    // The Client follows the pointer by column, so a tooltip never stands
    // between the pointer and the square under it.
    return <Client key="band" module="./band-client.tsx" props={band} width={columns} height={1} />
  })
}
