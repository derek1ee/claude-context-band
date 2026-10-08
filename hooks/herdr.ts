import type { CacheInfo } from '../types'
import { FLASH_MS, TTL_MS, cacheLabel, isFlashing } from './layout'

/**
 * Herdr (herdr.dev), the terminal multiplexer for coding agents, lists each
 * agent in its sidebar. Inside a Herdr pane the band flashes this session's
 * entry there with its countdown, through the same stretch the label flashes,
 * by setting the entry's displayed name through Herdr's own CLI.
 */

/** This session's pane, and the Herdr binary that drives it. */
export type HerdrPane = { bin: string; pane: string }

/** Who Herdr records as setting the name, so a clear takes back only ours. */
export const HERDR_SOURCE = 'context-band'

/**
 * Herdr drops a name this long after it was set, so one is never left behind
 * when the band stops updating it (Claude Code quits, the plugin reloads).
 * Each beat replaces or clears it well inside that.
 */
export const HERDR_NAME_TTL_MS = 2000

/** How long `/context-band herdr preview` flashes, counting down from 5:00. */
export const PREVIEW_MS = 30_000

/** The pane Herdr runs this session in, from the variables it sets in every pane; null outside Herdr. */
export function herdrPane(env: { HERDR_ENV?: string; HERDR_PANE_ID?: string; HERDR_BIN_PATH?: string }): HerdrPane | null {
  if (env.HERDR_ENV !== '1' || env.HERDR_PANE_ID === undefined || env.HERDR_PANE_ID === '') return null
  return { bin: env.HERDR_BIN_PATH === undefined || env.HERDR_BIN_PATH === '' ? 'herdr' : env.HERDR_BIN_PATH, pane: env.HERDR_PANE_ID }
}

/** The entry's name for this second: on the label's flash beats, its own name and the countdown; else null, Herdr's own. */
export function flashName(base: string, cache: CacheInfo | null, now: number): string | null {
  const label = cacheLabel(cache, now)
  return label.inverse ? `${base} ⚠ ${label.text}` : null
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

export function setNameArgv(h: HerdrPane, name: string): string[] {
  // `--agent claude`: Herdr applies the name only while Claude is the pane's agent
  return [h.bin, 'pane', 'report-metadata', h.pane, '--source', HERDR_SOURCE, '--agent', 'claude', '--display-agent', name, '--ttl-ms', String(HERDR_NAME_TTL_MS)]
}

export function clearNameArgv(h: HerdrPane): string[] {
  return [h.bin, 'pane', 'report-metadata', h.pane, '--source', HERDR_SOURCE, '--clear-display-agent']
}
