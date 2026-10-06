import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import { cacheLabel, configuredTtl, parseAutoRefresh, parseCount, shouldAutoRefresh } from '../hooks/layout'

const MINUTE = 60_000

describe('flashing', () => {
  const at = 1_000_000
  test('a 1h entry flashes through its last five minutes, a second on, a second off', () => {
    expect(cacheLabel({ touchedAt: at, ttl: '1h' }, at + 54 * MINUTE).inverse).toBe(false) // 6:00 left
    expect(cacheLabel({ touchedAt: at, ttl: '1h' }, at + 56 * MINUTE)).toMatchObject({ text: '1h-cache 4:00', inverse: true })
    expect(cacheLabel({ touchedAt: at, ttl: '1h' }, at + 56 * MINUTE + 1000)).toMatchObject({ text: '1h-cache 3:59', inverse: false })
  })

  test('a 5m entry never flashes', () => {
    expect(cacheLabel({ touchedAt: at, ttl: '5m' }, at + 4 * MINUTE).inverse).toBe(false)
    expect(cacheLabel({ touchedAt: at, ttl: '5m' }, at + 4 * MINUTE + 1000).inverse).toBe(false)
  })
})

describe('auto-refresh rules', () => {
  const at = 1_000_000
  const warm = { touchedAt: at, ttl: '1h' as const }
  test('fires inside the lead before expiry, with refreshes left', () => {
    expect(shouldAutoRefresh(warm, at + 57 * MINUTE, 3, 0)).toBe(false) // 3m left: before the 2m lead
    expect(shouldAutoRefresh(warm, at + 58 * MINUTE + 1000, 3, 0)).toBe(true)
    expect(shouldAutoRefresh(warm, at + 58 * MINUTE + 1000, 3, 3)).toBe(false) // count spent
    expect(shouldAutoRefresh(warm, at + 58 * MINUTE + 1000, 0, 0)).toBe(false) // off
    expect(shouldAutoRefresh(warm, at + 61 * MINUTE, 3, 0)).toBe(false) // already expired
    expect(shouldAutoRefresh({ touchedAt: at, ttl: '5m' }, at + 4 * MINUTE + 31_000, 3, 0)).toBe(true) // 29s left
    expect(shouldAutoRefresh({ touchedAt: at, ttl: null }, at + 4 * MINUTE + 31_000, 3, 0)).toBe(false)
  })

  test('the TTL the settings pin, in Claude Code order', () => {
    expect(configuredTtl('1', '1h', '1h')).toBe('5m')
    expect(configuredTtl(undefined, '1h', '5m')).toBe('1h')
    expect(configuredTtl(undefined, undefined, '5m')).toBe('5m')
    expect(configuredTtl('0', undefined, undefined)).toBeNull()
    expect(configuredTtl(undefined, 'bogus', 7)).toBeNull()
  })

  test('auto-refresh takes <n>, reset, or default <n>', () => {
    expect(parseAutoRefresh([])).toEqual({ kind: 'show' })
    expect(parseAutoRefresh(['3'])).toEqual({ kind: 'session', count: 3 })
    expect(parseAutoRefresh(['0'])).toEqual({ kind: 'session', count: 0 })
    expect(parseAutoRefresh(['reset'])).toEqual({ kind: 'reset' })
    expect(parseAutoRefresh(['default', '2'])).toEqual({ kind: 'default', count: 2 })
    for (const bad of [['default'], ['default', 'x'], ['3', '4'], ['reset', '1'], ['-1'], ['100']]) {
      expect(parseAutoRefresh(bad)).toEqual({ kind: 'invalid' })
    }
  })

  test('the command takes a whole count from 0 to 99', () => {
    expect(parseCount('3')).toBe(3)
    expect(parseCount(' 0 ')).toBe(0)
    expect(parseCount('-1')).toBeNull()
    expect(parseCount('100')).toBeNull()
    expect(parseCount('two')).toBeNull()
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

const BAND = {
  plugin: 'context-band',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 103, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const T0 = Date.parse('2026-10-06T00:00:00.000Z')

/** The engine beneath the plugin: a TTL pinned in settings, and forks that read 150k from the cache. */
function engine(on: On, ttl: '5m' | '1h' | null) {
  const state = { forks: 0, toasts: [] as string[], configSet: [] as { key: string; value: unknown }[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: BREAKDOWN }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: ttl === null ? {} : { promptCacheTtl: ttl } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('config.set', ($, e) => {
    state.configSet.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('model.fork', () => {
    state.forks += 1
    return {
      value: {
        isAnswered: true as const,
        text: 'OK',
        usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  return state
}

async function request($: Engine, turnId: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}

// These pin a 5m TTL so the mocked clock ticks through minutes, not hours; the
// 1h rules (its 2-minute lead, flashing) are the unit tests' above.
test('auto-refresh keeps an idle cache warm up to its count, and starts over on a prompt', { options: { autoRefresh: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const world = engine(on, '5m')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')

  // the settings pin the TTL, so the label shows from the first request
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '5m-cache 5:00' })).toBeDefined()
  // the button counts the auto-refreshes left; each hover target has its own tooltip
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (2)')
  expect(await ui.find({ type: 'Text', text: ' Refresh cache now · auto-refresh: 2 of 2 left, next in 4m ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 5m TTL · last request \d\d:\d\d:\d\d · expires \d\d:\d\d:\d\d $/ })).toBeDefined()

  // 30 seconds before expiry the idle session refreshes; the countdown starts over
  await clock.advance(4 * MINUTE + 31_000)
  expect(world.forks).toBe(1)
  expect(world.toasts.at(-1)).toBe('Cache auto-refreshed (1 of 2): 150k tokens read from the cache.')
  // it fired at 0:30 left, a tick ago: the countdown restarted from 5:00
  expect(await ui.find({ type: 'Text', text: '5m-cache 4:59' })).toBeDefined()

  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (1)')

  await clock.advance(4 * MINUTE + 31_000)
  expect(world.forks).toBe(2)
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (0)')
  expect(await ui.find({ type: 'Text', text: ' Refresh cache now · auto-refresh: 0 of 2 left until your next prompt ' })).toBeDefined()

  // the count is spent: the cache lapses
  await clock.advance(6 * MINUTE)
  expect(world.forks).toBe(2)
  expect(await ui.find({ type: 'Text', text: /^cache expired/ })).toBeDefined()

  // a prompt starts the count over, and its request warms the cache again
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await request($, 't2')
  await clock.advance(4 * MINUTE + 31_000)
  expect(world.forks).toBe(3)
  expect(world.toasts.at(-1)).toBe('Cache auto-refreshed (1 of 2): 150k tokens read from the cache.')
  await ui.unmount()
})

test('auto-refresh is off by default; the button and the command refresh by hand', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const world = engine(on, '5m')

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')
  await clock.advance(4 * MINUTE + 45_000)
  expect(world.forks).toBe(0)

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (0)')
  expect(await ui.find({ type: 'Text', text: ' Refresh cache now · auto-refresh off ' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(world.forks).toBe(1)
  expect(world.toasts.at(-1)).toBe('Cache refreshed: 150k tokens read from the cache.')
  expect(await ui.find({ type: 'Text', text: '5m-cache 5:00' })).toBeDefined()

  expect((await run($, 'refresh')).text).toBe('Cache refreshed: 150k tokens read from the cache.')
  expect(world.forks).toBe(2)

  // once expired there is nothing to keep warm: no button
  await clock.advance(6 * MINUTE)
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeUndefined()
  await ui.unmount()
})

/** `$.store` from a Map the test can read, in place of mock.store's hidden one. */
function memoryStore(on: On, entries: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map(Object.entries(entries))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'context-band', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 103 } })

test('auto-refresh <n> is this session\'s own; reset follows the default; default <n> sets it for all', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, {})
  const store = memoryStore(on)
  const world = engine(on, '1h')
  on('session.id', () => ({ value: 'session-a' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')

  expect((await run($, 'auto-refresh')).text).toBe(
    "Auto-refresh: off (the default). /context-band auto-refresh <n> sets this session's own.",
  )

  // this session only: no settings write, kept in the store under the session id
  expect((await run($, 'auto-refresh 3')).text).toMatch(/^Auto-refresh for this session: up to 3 .* Other sessions keep the default \(off\)\.$/)
  expect(world.configSet).toEqual([])
  expect(store.get('session-limit:session-a')).toEqual({ limit: 3, savedAt: T0 })

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (3)')
  expect(await ui.find({ type: 'Text', text: /^ Refresh cache now · auto-refresh \(this session\): 3 of 3 left/ })).toBeDefined()

  expect((await run($, 'auto-refresh')).text).toMatch(/^Auto-refresh for this session: up to 3 .* The default is off;/)

  // back to the default, and the stored count is gone
  expect((await run($, 'auto-refresh reset')).text).toBe('This session follows the default again: auto-refresh off.')
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (0)')
  expect(store.has('session-limit:session-a')).toBe(false)

  // the default for every session goes to settings
  expect((await run($, 'auto-refresh default 2')).text).toBe('Default auto-refresh for every session: up to 2 keep-alive refreshes while idle.')
  expect(world.configSet).toEqual([{ key: 'context-band.autoRefresh', value: 2 }])

  for (const bad of ['auto-refresh lots', 'auto-refresh default', 'auto-refresh 3 4', 'auto-refresh reset 3', 'bogus']) {
    expect((await run($, bad)).text).toMatch(/^Usage/)
  }
  await ui.unmount()
})

test('a resumed session takes up its own count; month-old counts are dropped', { options: { autoRefresh: 1 } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, {})
  const store = memoryStore(on, {
    'session-limit:session-b': { limit: 4, savedAt: T0 - 1000 },
    'session-limit:session-old': { limit: 2, savedAt: T0 - 31 * 24 * 60 * MINUTE },
    unrelated: 'kept',
  })
  engine(on, '1h')
  on('session.id', () => ({ value: 'session-b' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await request($, 't1')

  const ui = await $.ui.mount(BAND)
  // its own 4 over the default 1
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻ (4)')
  expect(store.has('session-limit:session-old')).toBe(false)
  expect(store.get('session-limit:session-b')).toEqual({ limit: 4, savedAt: T0 - 1000 })
  expect(store.get('unrelated')).toBe('kept')
  await ui.unmount()
})

test('the TTL shows a moment after the first response, once Claude Code has saved it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, {})
  const world = engine(on, null) // automatic TTL: only a response tells
  let tail = ''
  on('process.run', () => ({ value: { exitCode: 0, stdout: tail, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('classic.SessionStart', () => ({}))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/tmp/fresh.jsonl' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'no cache yet' })).toBeDefined()

  // the first request: the response's row is not saved yet
  await request($, 't1')
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'cache …' })).toBeDefined()

  // saved a moment later, with no further event: the next poll finds it
  tail = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(T0).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 0 } } },
  })
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: '1h-cache 59:57' })).toBeDefined()
  expect(world.forks).toBe(0)
  await ui.unmount()
})
