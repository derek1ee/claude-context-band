import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import { agentName, clearNameArgv, flashName, herdrPane, previewCache, setNameArgv } from '../hooks/herdr'

const MINUTE = 60_000
const T0 = Date.parse('2026-10-07T00:00:00.000Z')
const PANE = { bin: '/opt/homebrew/bin/herdr', pane: 'w1:p1' }
const INSIDE = { HERDR_ENV: '1', HERDR_PANE_ID: PANE.pane, HERDR_BIN_PATH: PANE.bin }

describe('herdr helpers', () => {
  test('the pane comes from the variables Herdr sets; anywhere else there is none', () => {
    expect(herdrPane(INSIDE)).toEqual(PANE)
    expect(herdrPane({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })).toEqual({ bin: 'herdr', pane: 'w1:p1' })
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

/** The engine beneath the plugin, with a 1h TTL pinned in settings; returns each herdr command run, in order. */
function engine(on: On) {
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
  on('process.run', ($, e) => {
    if (e.argv[0] !== PANE.bin) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push([...e.argv])
    const stdout = e.argv[1] === 'agent' ? '{"result":{"agent":{"agent":"claude"}}}' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, configSet }
}

async function request($: Engine, turnId: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'context-band', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 103 } })

const AGENT_GET = [PANE.bin, 'agent', 'get', PANE.pane]
const set = (name: string) => setNameArgv(PANE, name)
const CLEAR = clearNameArgv(PANE)

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
  expect((await run($, 'herdr bogus')).text).toBe('Usage: /context-band herdr [preview | on | off]')
})
