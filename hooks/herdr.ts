import type { CacheInfo } from '../types'
import { FLASH_MS, TTL_MS, cacheLabel, isFlashing } from './layout'

/**
 * Herdr (herdr.dev), the terminal multiplexer for coding agents, lists each
 * agent in its sidebar. Inside a Herdr pane the band flashes this session's
 * entry there with its countdown, through the same stretch the label flashes,
 * through Herdr's own CLI. With no setup it renames the entry on each beat.
 * Once Herdr's config shows the `$context_band` token (`/context-band herdr
 * setup` adds it), it reports the countdown there instead, coloured by the
 * config's rules.
 */

/** This session's pane, the Herdr binary that drives it, and Herdr's config file. */
export type HerdrPane = { bin: string; pane: string; config: string | null }

/** What the band shows in Herdr: a name in place of the agent's, or the token's value. */
export type HerdrShow = { kind: 'name' | 'token'; value: string }

/** Who Herdr records as setting the name, so a clear takes back only ours. */
export const HERDR_SOURCE = 'context-band'

/** The pane metadata the coloured countdown is reported as: `$context_band` in Herdr's config. */
export const HERDR_TOKEN = 'context_band'

/**
 * Herdr drops a name or value this long after it was set, so one is never left
 * behind when the band stops updating it (Claude Code quits, the plugin
 * reloads). Each beat replaces or clears it well inside that.
 */
export const HERDR_TTL_MS = 2000

/** How long `/context-band herdr preview` flashes, counting down from 5:00. */
export const PREVIEW_MS = 30_000

type HerdrEnv = {
  HERDR_ENV?: string
  HERDR_PANE_ID?: string
  HERDR_BIN_PATH?: string
  HERDR_CONFIG_PATH?: string
  HOME?: string
  APPDATA?: string
}

/** The pane Herdr runs this session in, from the variables it sets in every pane; null outside Herdr. */
export function herdrPane(env: HerdrEnv): HerdrPane | null {
  if (env.HERDR_ENV !== '1' || env.HERDR_PANE_ID === undefined || env.HERDR_PANE_ID === '') return null
  const bin = env.HERDR_BIN_PATH === undefined || env.HERDR_BIN_PATH === '' ? 'herdr' : env.HERDR_BIN_PATH
  return { bin, pane: env.HERDR_PANE_ID, config: herdrConfigPath(env) }
}

/** Herdr's config file: HERDR_CONFIG_PATH, else Herdr's default for the platform. */
export function herdrConfigPath(env: HerdrEnv): string | null {
  if (env.HERDR_CONFIG_PATH !== undefined && env.HERDR_CONFIG_PATH !== '') return env.HERDR_CONFIG_PATH
  if (env.HOME !== undefined && env.HOME !== '') return `${env.HOME}/.config/herdr/config.toml`
  if (env.APPDATA !== undefined && env.APPDATA !== '') return `${env.APPDATA}\\herdr\\config.toml`
  return null
}

/** The entry's name for this second: on the label's flash beats, its own name and the countdown; else null, Herdr's own. */
export function flashName(base: string, cache: CacheInfo | null, now: number): string | null {
  const label = cacheLabel(cache, now)
  return label.inverse ? `${base} ⚠ ${label.text}` : null
}

/**
 * The token's value for this second: the countdown through the flashing
 * stretch, led by ⚠ on the label's flash beats (the config's rule colours
 * those); else null, unreported, which Herdr hides.
 */
export function tokenValue(cache: CacheInfo | null, now: number): string | null {
  if (!isFlashing(cache, now)) return null
  const label = cacheLabel(cache, now)
  return label.inverse ? `⚠ ${label.text}` : label.text
}

/** A 1h entry that reads 5:00 left at `from`: what a preview flashes. */
export function previewCache(from: number): CacheInfo {
  return { touchedAt: from + FLASH_MS - TTL_MS['1h'], ttl: '1h' }
}

/** The name Herdr shows for the agent unless told otherwise: its Herdr name if it has one, else its kind. */
export function agentName(stdout: string): string {
  try {
    const agent: unknown = (JSON.parse(stdout) as { result?: { agent?: unknown } }).result?.agent
    if (typeof agent === 'object' && agent !== null) {
      const { name, agent: kind } = agent as { name?: unknown; agent?: unknown }
      if (typeof name === 'string' && name !== '') return name
      if (typeof kind === 'string' && kind !== '') return kind
    }
  } catch {
    // not JSON: an older or newer Herdr
  }
  return 'claude'
}

export function setArgv(h: HerdrPane, show: HerdrShow): string[] {
  const report = [h.bin, 'pane', 'report-metadata', h.pane, '--source', HERDR_SOURCE]
  const ttl = ['--ttl-ms', String(HERDR_TTL_MS)]
  // `--agent claude`: Herdr applies the name only while Claude is the pane's agent
  if (show.kind === 'name') return [...report, '--agent', 'claude', '--display-agent', show.value, ...ttl]
  return [...report, '--token', `${HERDR_TOKEN}=${show.value}`, ...ttl]
}

export function clearArgv(h: HerdrPane, kind: HerdrShow['kind']): string[] {
  const report = [h.bin, 'pane', 'report-metadata', h.pane, '--source', HERDR_SOURCE]
  return kind === 'name' ? [...report, '--clear-display-agent'] : [...report, '--clear-token', HERDR_TOKEN]
}

/** Herdr's config with its comment lines blanked, so a commented-out row counts for nothing. */
function liveConfig(config: string): string {
  return config
    .split('\n')
    .map(line => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n')
}

/** Whether Herdr's config shows the token somewhere: the band then reports the countdown there instead of renaming the entry. */
export function showsToken(config: string): boolean {
  return liveConfig(config).includes(`$${HERDR_TOKEN}`)
}

/**
 * Whether Herdr's config lays out its agent list itself. Setup then leaves the
 * file alone: Claude's row would replace that layout for Claude entries, and a
 * second `rows_by_agent` table would not parse.
 */
export function laysOutAgents(config: string): boolean {
  return /sidebar\.agents|rows_by_agent|^\s*\[ui\.sidebar\]|\bsidebar\s*=/m.test(liveConfig(config))
}

const SETUP_START = '# context-band: added by /context-band herdr setup; /context-band herdr setup remove takes it out.'
const SETUP_END = '# context-band: end'

/**
 * The countdown as a row entry: yellow, and red and bold on the flash beats.
 * The colours are the default theme's (Catppuccin Mocha); edit them freely.
 */
export const SETUP_TOKEN = `{ token = "$${HERDR_TOKEN}", fg = "#f9e2af", rules = [{ starts_with = "⚠", fg = "#f38ba8", bold = true }] }`

/** Claude entries' rows: Herdr's default two, with the countdown after the agent's name. */
export const SETUP_ROWS = `[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", ${SETUP_TOKEN}],
]`

/** Herdr's config with the setup block added at its end. */
export function withSetup(config: string): string {
  const head = config.trimEnd()
  return `${head === '' ? '' : `${head}\n\n`}${SETUP_START}\n${SETUP_ROWS}\n${SETUP_END}\n`
}

/** Herdr's config with the setup block taken out, as it was before; null when there is none. */
export function withoutSetup(config: string): string | null {
  const start = config.indexOf(SETUP_START)
  const end = config.indexOf(SETUP_END, start)
  if (start === -1 || end === -1) return null
  const head = config.slice(0, start).trimEnd()
  const tail = config.slice(end + SETUP_END.length).replace(/^\n+/, '')
  if (head === '') return tail
  return tail === '' ? `${head}\n` : `${head}\n\n${tail}`
}
