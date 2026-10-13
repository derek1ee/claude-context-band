import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import {
  SETUP_ROWS,
  agentName,
  clearArgv,
  flashName,
  herdrConfigPath,
  herdrPane,
  laysOutAgents,
  previewCache,
  setArgv,
  showsToken,
  tokenValue,
  withSetup,
  withoutSetup,
} from '../hooks/herdr'

const MINUTE = 60_000
const T0 = Date.parse('2026-10-07T00:00:00.000Z')
const PANE = { bin: '/opt/homebrew/bin/herdr', pane: 'w1:p1', config: null }
const INSIDE = { HERDR_ENV: '1', HERDR_PANE_ID: PANE.pane, HERDR_BIN_PATH: PANE.bin }

describe('herdr helpers', () => {
  test('the pane comes from the variables Herdr sets; anywhere else there is none', () => {
    expect(herdrPane(INSIDE)).toEqual(PANE)
    expect(herdrPane({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })).toEqual({ bin: 'herdr', pane: 'w1:p1', config: null })
    expect(herdrPane({})).toBeNull()
    expect(herdrPane({ HERDR_ENV: '1' })).toBeNull()
    expect(herdrPane({ HERDR_ENV: '0', HERDR_PANE_ID: 'w1:p1' })).toBeNull()
  })

  test('the name flashes on the label\'s beats through a 1h entry\'s last five minutes, and never for 5m', () => {
    const at = 1_000_000
    const hour = { touchedAt: at, ttl: '1h' as const }
    expect(flashName('claude', hour, at + 54 * MINUTE)).toBeNull() // 6:00 left
    expect(flashName('claude', hour, at + 55 * MINUTE)).toBe('claude ⚠ 1h-cache 5:00')
    expect(flashName('claude', hour, at + 55 * MINUTE + 1000)).toBeNull()
    expect(flashName('reviewer', hour, at + 56 * MINUTE)).toBe('reviewer ⚠ 1h-cache 4:00')
    expect(flashName('claude', hour, at + 61 * MINUTE)).toBeNull() // expired
    expect(flashName('claude', { touchedAt: at, ttl: '5m' }, at + 4 * MINUTE)).toBeNull()
    expect(flashName('claude', previewCache(at), at)).toBe('claude ⚠ 1h-cache 5:00')
  })

  test('the token counts down through the flashing stretch, led by ⚠ on the beats; unreported otherwise', () => {
    const at = 1_000_000
    const hour = { touchedAt: at, ttl: '1h' as const }
    expect(tokenValue(hour, at + 54 * MINUTE)).toBeNull()
    expect(tokenValue(hour, at + 55 * MINUTE)).toBe('⚠ 1h-cache 5:00')
    expect(tokenValue(hour, at + 55 * MINUTE + 1000)).toBe('1h-cache 4:59')
    expect(tokenValue(hour, at + 61 * MINUTE)).toBeNull()
    expect(tokenValue({ touchedAt: at, ttl: '5m' }, at + 4 * MINUTE)).toBeNull()
  })

  test("Herdr's config file: HERDR_CONFIG_PATH, else the platform's default", () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: '/x/herdr.toml', HOME: '/Users/me' })).toBe('/x/herdr.toml')
    expect(herdrConfigPath({ HOME: '/Users/me' })).toBe('/Users/me/.config/herdr/config.toml')
    expect(herdrConfigPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe('C:\\Users\\me\\AppData\\Roaming\\herdr\\config.toml')
    expect(herdrConfigPath({})).toBeNull()
  })

  test('the config shows the token, or lays out the agent list itself; comments count for neither', () => {
    expect(showsToken(SETUP_ROWS)).toBe(true)
    expect(showsToken('[ui]\n# rows = [["$context_band"]]\n')).toBe(false)
    expect(laysOutAgents('[ui]\nagent_panel_sort = "spaces"\nsidebar_width = 30\n')).toBe(false)
    expect(laysOutAgents('[ui.sidebar.agents]\nrow_gap = 1\n')).toBe(true)
    expect(laysOutAgents('[ui.sidebar.agents.rows_by_agent]\ncodex = [["agent"]]\n')).toBe(true)
    expect(laysOutAgents('[ui]\nsidebar = { agents = { row_gap = 1 } }\n')).toBe(true)
    expect(laysOutAgents('# [ui.sidebar.agents]\n')).toBe(false)
  })

  test('setup adds its block at the end, and remove gives back the file it was added to', () => {
    for (const before of ['', 'onboarding = false\n', 'onboarding = false\n\n[ui]\nagent_panel_sort = "spaces"\n']) {
      const after = withSetup(before)
      expect(after.startsWith(before.trimEnd())).toBe(true)
      expect(after).toContain(SETUP_ROWS)
      expect(showsToken(after)).toBe(true)
      expect(withoutSetup(after)).toBe(before)
    }
    expect(withoutSetup('onboarding = false\n')).toBeNull()
  })

  test("the base name is the agent's Herdr name, else its kind", () => {
    expect(agentName('{"result":{"agent":{"agent":"claude","name":"reviewer"}}}')).toBe('reviewer')
    expect(agentName('{"result":{"agent":{"agent":"claude"}}}')).toBe('claude')
    expect(agentName('not json')).toBe('claude')
  })
})

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'Messages', tokens: 50_000, color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 150_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 50_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'auto',
  percentage: 25,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
}

/**
 * The engine beneath the plugin, with a 1h TTL pinned in settings and a file
 * system of `files`; returns each herdr command run, in order, and the files.
 */
function engine(on: On, { files = new Map<string, string>(), checkExit = 0 } = {}) {
  const runs: string[][] = []
  const configSet: { key: string; value: unknown }[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: BREAKDOWN }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: { promptCacheTtl: '1h' } }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('config.set', ($, e) => {
    configSet.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const result = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] !== PANE.bin) return result(1)
    runs.push([...e.argv])
    if (e.argv[1] === 'agent') return result(0, '{"result":{"agent":{"agent":"claude"}}}')
    if (e.argv[1] === 'config') return result(checkExit, checkExit === 0 ? 'config: ok' : 'config: issues found')
    return result(0)
  })
  return { runs, configSet, files }
}

async function request($: Engine, turnId: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'context-band', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 103 } })

const AGENT_GET = [PANE.bin, 'agent', 'get', PANE.pane]
const set = (name: string) => setArgv(PANE, { kind: 'name', value: name })
const CLEAR = clearArgv(PANE, 'name')

test("inside Herdr, the agent list's entry flashes with the countdown through a 1h cache's last five minutes", async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, INSIDE)
  const { runs } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')

  // nothing reaches Herdr until the last five minutes
  await clock.advance(55 * MINUTE - 1000)
  expect(runs).toEqual([])

  // 5:00 left: read the agent's own name once, then show it with the countdown
  await clock.advance(1000)
  expect(runs).toEqual([AGENT_GET, set('claude ⚠ 1h-cache 5:00')])
  // the off beat hands the name back; the next on beat shows it again
  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(CLEAR)
  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(set('claude ⚠ 1h-cache 4:58'))
  expect(set('x')).toContain('--ttl-ms') // a name left behind clears itself

  // once expired, the name is Herdr's own and nothing more is sent
  await clock.advance(5 * MINUTE)
  expect(runs.at(-1)).toEqual(CLEAR)
  expect(runs.filter(argv => argv[1] === 'agent')).toHaveLength(1)
  const sent = runs.length
  await clock.advance(10 * MINUTE)
  expect(runs).toHaveLength(sent)
})

test('a request inside the last five minutes stops the flash: the countdown starts over', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, INSIDE)
  const { runs } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')
  await clock.advance(55 * MINUTE)
  expect(runs.at(-1)).toEqual(set('claude ⚠ 1h-cache 5:00'))

  await request($, 't2')
  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(CLEAR)
  const sent = runs.length
  await clock.advance(10 * MINUTE)
  expect(runs).toHaveLength(sent)
})

test('outside Herdr nothing is sent, and the command says why', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const { runs } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')
  await clock.advance(58 * MINUTE)
  expect(runs).toEqual([])
  expect((await run($, 'herdr')).text).toMatch(/^Herdr: this session isn't running inside Herdr/)
  expect((await run($, 'herdr preview')).text).toMatch(/^Herdr: this session isn't running inside Herdr/)
  expect(runs).toEqual([])
})

test('with the herdr option off, nothing is sent inside Herdr either', { options: { herdr: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, INSIDE)
  const { runs } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')
  await clock.advance(58 * MINUTE)
  expect(runs).toEqual([])
  expect((await run($, 'herdr')).text).toMatch(/^Herdr: off\./)
})

test('herdr preview flashes for 30 seconds from 5:00, even before the first prompt', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, INSIDE)
  const { runs } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await run($, 'herdr')).text).toMatch(/^Herdr: on \(pane w1:p1\)\./)
  expect((await run($, 'herdr preview')).text).toMatch(/^Herdr preview: for 30 seconds/)
  expect(runs).toEqual([AGENT_GET, set('claude ⚠ 1h-cache 5:00')])

  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(CLEAR)
  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(set('claude ⚠ 1h-cache 4:58'))

  await clock.advance(30_000)
  expect(runs.at(-1)).toEqual(CLEAR)
  const sent = runs.length
  await clock.advance(MINUTE)
  expect(runs).toHaveLength(sent)
})

test('herdr on and off set the option', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, INSIDE)
  const { configSet } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await run($, 'herdr off')).text).toBe("Herdr: off. The band leaves Herdr's agent list alone.")
  expect((await run($, 'herdr on')).text).toMatch(/^Herdr: on\. Inside Herdr/)
  expect(configSet).toEqual([
    { key: 'context-band.herdr', value: false },
    { key: 'context-band.herdr', value: true },
  ])
  expect((await run($, 'herdr bogus')).text).toBe('Usage: /context-band herdr [preview | setup [remove] | on | off]')
  expect((await run($, 'herdr setup bogus')).text).toBe('Usage: /context-band herdr [preview | setup [remove] | on | off]')
})

const CONFIG = '/Users/me/.config/herdr/config.toml'
const INSIDE_HOME = { ...INSIDE, HOME: '/Users/me' }
const TPANE = { ...PANE, config: CONFIG }
const setToken = (value: string) => setArgv(TPANE, { kind: 'token', value })
const CLEAR_TOKEN = clearArgv(TPANE, 'token')
const CHECK = [PANE.bin, 'config', 'check']
const RELOAD = [PANE.bin, 'server', 'reload-config']

test("with $context_band in Herdr's config, the countdown flashes there in colour instead of the name", async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, INSIDE_HOME)
  const { runs } = engine(on, { files: new Map([[CONFIG, withSetup('')]]) })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')
  await clock.advance(55 * MINUTE)
  // no name to read: the token sits beside it
  expect(runs).toEqual([setToken('⚠ 1h-cache 5:00')])
  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(setToken('1h-cache 4:59'))
  await clock.advance(1000)
  expect(runs.at(-1)).toEqual(setToken('⚠ 1h-cache 4:58'))

  await clock.advance(5 * MINUTE)
  expect(runs.at(-1)).toEqual(CLEAR_TOKEN)
  const sent = runs.length
  await clock.advance(10 * MINUTE)
  expect(runs).toHaveLength(sent)
})

test("herdr setup adds the rows, has Herdr check and reload them; remove takes them out", async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, INSIDE_HOME)
  const before = 'onboarding = false\n\n[ui]\nagent_panel_sort = "spaces"\n'
  const { runs, files } = engine(on, { files: new Map([[CONFIG, before]]) })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await run($, 'herdr')).text).toMatch(/flashes its name with the countdown; \/context-band herdr setup adds/)

  expect((await run($, 'herdr setup')).text).toBe(
    `Added the countdown rows for Claude entries to ${CONFIG} (the old file is at ${CONFIG}.context-band-backup) and reloaded Herdr. Through a 1h cache's last 5 minutes, the entry shows the countdown after its name, yellow, flashing red. /context-band herdr preview shows it; /context-band herdr setup remove takes it out.`,
  )
  expect(files.get(CONFIG)).toBe(withSetup(before))
  expect(files.get(`${CONFIG}.context-band-backup`)).toBe(before)
  expect(runs).toEqual([CHECK, RELOAD])
  expect((await run($, 'herdr')).text).toMatch(/shows the countdown after its name, yellow, flashing red/)
  expect((await run($, 'herdr setup')).text).toMatch(/already shows \$context_band/)

  // the preview now flashes the token
  await run($, 'herdr preview')
  expect(runs.at(-1)).toEqual(setToken('⚠ 1h-cache 5:00'))

  expect((await run($, 'herdr setup remove')).text).toMatch(/^Took the countdown rows out of .* and reloaded Herdr\. The entry goes back to flashing its name\.$/)
  expect(files.get(CONFIG)).toBe(before)
  expect((await run($, 'herdr setup remove')).text).toMatch(/has no context-band rows to remove/)
})

test('herdr setup creates the config when Herdr has none yet', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, INSIDE_HOME)
  const { files } = engine(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await run($, 'herdr setup')).text).toMatch(new RegExp(`^Added the countdown rows for Claude entries to ${CONFIG} and reloaded Herdr\\.`))
  expect(files.get(CONFIG)).toBe(withSetup(''))
  expect(files.has(`${CONFIG}.context-band-backup`)).toBe(false)
})

test('herdr setup leaves a config that lays out the agent list alone, and says what to add', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, INSIDE_HOME)
  const before = '[ui.sidebar.agents]\nrows = [["state_icon", "agent"]]\n'
  const { runs, files } = engine(on, { files: new Map([[CONFIG, before]]) })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const { text } = await run($, 'herdr setup')
  expect(text).toMatch(/already lays out Herdr's agent list, so setup leaves it to you/)
  expect(text).toContain('{ token = "$context_band"')
  expect(text).toContain('herdr server reload-config')
  expect(files.get(CONFIG)).toBe(before)
  expect(runs).toEqual([])
})

test('when Herdr rejects the change, setup puts the config back', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, INSIDE_HOME)
  const before = 'onboarding = false\n'
  const { runs, files } = engine(on, { files: new Map([[CONFIG, before]]), checkExit: 1 })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect((await run($, 'herdr setup')).text).toBe(`Herdr setup: Herdr rejected the change, so ${CONFIG} is back as it was.\nconfig: issues found`)
  expect(files.get(CONFIG)).toBe(before)
  expect(runs).toEqual([CHECK])
})
