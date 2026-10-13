import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown } from 'claude-code'

import { agentContext, parseTail } from '../hooks/layout'
import type { CacheTtl } from '../types'

const T0 = Date.parse('2026-10-13T04:00:00.000Z')
const MAIN = '/tmp/s.jsonl'
const AGENT_ID = 'aff6c46aa48a052d9'
const AGENT = `/tmp/s/subagents/agent-${AGENT_ID}.jsonl`

/** One transcript row: a response at `at` whose cache writes went to `ttl`, `tokens` of context. */
function row(at: number, ttl: CacheTtl, { isSidechain = false, tokens = 0 } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain,
    timestamp: new Date(at).toISOString(),
    message: {
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: tokens,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? 100 : 0, ephemeral_1h_input_tokens: ttl === '1h' ? 100 : 0 },
      },
    },
  })
}

describe('transcripts', () => {
  test("the main transcript leaves its subagents' rows out; an agent's own is all sidechain rows", () => {
    const text = [row(T0, '1h'), row(T0 + 1000, '5m', { isSidechain: true, tokens: 50_000 })].join('\n')
    expect(parseTail(text)).toEqual({ ttl: '1h', at: T0, tokens: 100 })
    expect(parseTail(text, true)).toEqual({ ttl: '5m', at: T0 + 1000, tokens: 50_100 })
  })

  test("an agent's squares: its context in the messages colour, then free space", () => {
    const main = {
      window: 200_000,
      rows: [
        { name: 'Messages', color: 'claude', tokens: 40_000, kind: 'used' as const },
        { name: 'Free space', color: 'inactive', tokens: 160_000, kind: 'free' as const },
      ],
    }
    expect(agentContext(main, 50_000).rows).toEqual([
      { name: 'Agent context', color: 'claude', tokens: 50_000, kind: 'used' },
      { name: 'Free space', color: 'inactive', tokens: 150_000, kind: 'free' },
    ])
    expect(agentContext(main, null).rows).toEqual([{ name: 'Free space', color: 'inactive', tokens: 200_000, kind: 'free' }])
  })
})

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 40_000, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 107_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 60_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'auto',
  percentage: 30,
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

/**
 * The engine beneath the plugin, with no TTL pinned and no classic Stop ever
 * raised; `tail` reads `files`. An agent's requests report 50k of context.
 */
function engine(on: On, files: Map<string, string>) {
  const tails: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: BREAKDOWN }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* ($, e) {
    const usage =
      e.agentId === undefined
        ? null
        : { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 48_000, cache_creation_input_tokens: 500, model: 'claude-opus-5-5' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('process.run', ($, e) => {
    const path = e.argv[0] === 'tail' ? e.argv[3] : undefined
    const text = path === undefined ? undefined : files.get(path)
    if (path !== undefined) tails.push(path)
    return { value: { exitCode: text === undefined ? 1 : 0, stdout: text ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', ($, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  return { tails }
}

async function request($: Engine, turnId: string, agentId?: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })) {
    // drain
  }
}

type Drawn = {
  findAll: (q: { type?: string; text?: string | RegExp; in?: string }) => Promise<{ text: string }[]>
  find: (q: { type?: string; key?: string; text?: string | RegExp; in?: string }) => Promise<{ text: string; props: Record<string, unknown> } | undefined>
  pointer: (e: { type: 'move'; x: number; y: number; in?: string }) => Promise<void>
}

async function squaresOf(ui: Drawn) {
  const runs = await ui.findAll({ type: 'Text', text: /^([⛁⛀⛃⛂⛶⛝] )+$/, in: 'band' })
  return runs
    .map(t => t.text)
    .join('')
    .replaceAll(' ', '')
}

async function labelOf(ui: Drawn) {
  return (await ui.find({ type: 'Text', text: /cache/, in: 'band' }))?.text
}

test('a TTL back from 5m to 1h shows a moment after the next response is saved, with no Stop', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([[MAIN, row(T0 - 60_000, '5m')]])
  const { tails } = engine(on, files)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', transcript_path: MAIN })
  await clock.settle()
  const ui = await $.ui.mount(BAND)

  // past the usage limits the session wrote to 5m; the next request arms the countdown
  await request($, 't1')
  await clock.advance(1000)
  expect(await labelOf(ui)).toBe('5m-cache 4:59')

  // its response, back at 1h, is saved a moment later: the band reads it on its next pass
  files.set(MAIN, `${files.get(MAIN)}\n${row(T0 + 2_500, '1h')}`)
  await clock.advance(2000)
  expect(await labelOf(ui)).toBe('1h-cache 59:57')

  // the response seen, it stops reading
  const reads = tails.length
  await clock.advance(30_000)
  expect(tails).toHaveLength(reads)
  await ui.unmount()
})

test("an agent's transcript in view: the band shows its context and its own cache, without the refresh button", async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([
    [MAIN, row(T0, '1h')],
    [AGENT, row(T0 + 1_500, '5m', { isSidechain: true, tokens: 50_000 })],
  ])
  engine(on, files)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', transcript_path: MAIN })
  await request($, 't1')
  await clock.advance(1000)
  await request($, 'a1', AGENT_ID)
  await clock.advance(1000)

  const main = await $.ui.mount(BAND)
  // the main thread: its categories, its 1h cache, its refresh button
  expect(await squaresOf(main)).toBe('⛁'.repeat(12) + '⛶'.repeat(21) + '⛝'.repeat(7))
  expect(await labelOf(main)).toBe('1h-cache 59:58')
  expect(await main.find({ type: 'Button', key: 'refresh', in: 'band' })).toBeDefined()
  await main.unmount()

  const agent = await $.ui.mount({ ...BAND, props: { ...BAND.props, view: { agentId: AGENT_ID } } })
  // 50k of 200k in 5k squares, from its request: 10 used, 30 free
  expect(await squaresOf(agent)).toBe('⛁'.repeat(10) + '⛶'.repeat(30))
  // its TTL is in its own transcript, which the next tick reads: its 5m cache, from its request at T0 + 1s
  expect(await labelOf(agent)).toBe('cache …')
  await clock.advance(1000)
  expect(await labelOf(agent)).toBe('5m-cache 4:58')
  expect(await agent.find({ type: 'Button', key: 'refresh', in: 'band' })).toBeUndefined()
  await agent.pointer({ type: 'move', x: 1, y: 0, in: 'band' })
  expect((await agent.find({ type: 'Box', key: 'tip', in: 'band' }))?.text).toBe(' Agent context · 50k tokens · 25% of 200k ')

  // its countdown runs while it's in view, though the main thread's is the same each second
  await clock.advance(60_000)
  expect(await labelOf(agent)).toBe('5m-cache 3:58')
  await agent.unmount()
})

test('an agent first seen in view (begun before a reload) is read from its transcript', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([
    [MAIN, row(T0, '1h')],
    [AGENT, row(T0 - 30_000, '5m', { isSidechain: true, tokens: 20_000 })],
  ])
  engine(on, files)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', transcript_path: MAIN })
  await clock.advance(1000)

  const agent = await $.ui.mount({ ...BAND, props: { ...BAND.props, view: { agentId: AGENT_ID } } })
  expect(await labelOf(agent)).toBe('cache …')
  await clock.advance(1000)
  // its newest response 32s ago, 20.1k of context
  expect(await labelOf(agent)).toBe('5m-cache 4:28')
  expect(await squaresOf(agent)).toBe('⛁'.repeat(4) + '⛶'.repeat(36))
  await agent.unmount()
})
