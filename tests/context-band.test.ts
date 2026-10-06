import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'

import { LABEL_WIDTH, cacheLabel, describeRun, layout, parseTail, squaresFor, tipLeft } from '../hooks/layout'
import type { Ctx } from '../types'

const CTX: Ctx = {
  window: 200_000,
  rows: [
    { name: 'System prompt', color: 'promptBorder', tokens: 20_000, kind: 'used' },
    { name: 'Messages', color: 'claude', tokens: 40_000, kind: 'used' },
    { name: 'Free space', color: 'inactive', tokens: 107_000, kind: 'free' },
    { name: 'Autocompact buffer', color: 'inactive', tokens: 33_000, kind: 'buffer' },
  ],
}

const countOf = (runs: ReturnType<typeof layout>, kind: string) =>
  runs.filter(r => r.kind === kind).reduce((n, r) => n + r.count, 0)

describe('layout', () => {
  test('squares follow the width', () => {
    expect(squaresFor(80)).toBe(40)
    expect(squaresFor(81)).toBe(41)
    expect(squaresFor(0)).toBe(1)
  })

  test('each square is an equal share of the window, whatever their number', () => {
    for (const n of [10, 40, 100]) {
      const runs = layout(CTX, n)
      expect(runs.reduce((sum, r) => sum + r.count, 0)).toBe(n)
      // 60k of 200k used is 30%; 33k buffer is 16.5%
      expect(countOf(runs, 'used')).toBe(Math.round(n * 0.3))
      expect(countOf(runs, 'buffer')).toBe(Math.round(n * 0.165))
    }
  })

  test('categories keep their order and colours, the buffer sits at the right end', () => {
    const runs = layout(CTX, 20)
    expect(runs.map(r => r.name)).toEqual(['System prompt', 'Messages', 'Free space', 'Autocompact buffer'])
    expect(runs.map(r => r.color)).toEqual(['promptBorder', 'claude', 'inactive', 'inactive'])
  })

  test('squares are drawn with /context glyphs, a part-full last square hollow', () => {
    const runs = layout(CTX, 20)
    expect(runs.map(r => r.text.replaceAll(' ', ''))).toEqual(['⛁⛁', '⛁⛁⛁⛁', '⛶'.repeat(11), '⛝⛝⛝'])
    // 25k of 10k squares: two full, the third half full
    const partial = layout({ ...CTX, rows: [{ name: 'Messages', color: 'claude', tokens: 25_000, kind: 'used' }] }, 20)
    expect(partial[0]?.text).toBe('⛁ ⛁ ⛀ ')
  })

  test('a tooltip starts on the next square, else ends on the previous one', () => {
    // square 3 sits at columns 6-7: a 20-wide tip starts on square 4, at column 8
    expect(tipLeft(3, 20, 99)).toBe(8)
    // square 45 at 90-91: past the last square's glyph (99) there is no room, so it ends on square 44
    expect(tipLeft(45, 20, 99)).toBe(70)
    // a tip that fits neither side ends at the last square's glyph
    expect(tipLeft(5, 95, 99)).toBe(4)
  })

  test('a draft shows as pending squares after the used ones, at least one', () => {
    const one = layout(CTX, 20, 5)
    expect(countOf(one, 'pending')).toBe(1)
    expect(one[2]).toMatchObject({ kind: 'pending', color: 'claude', text: '⛶ ' })

    // 30k more tokens of 10k squares reaches square 9
    expect(countOf(layout(CTX, 20, 30_000), 'pending')).toBe(3)
    expect(countOf(layout(CTX, 20, 0), 'pending')).toBe(0)
  })
})

describe('cache', () => {
  const row = (ts: string, written: { h: number; m: number } | null, extra: object = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: {
        model: 'claude-opus-5-5',
        usage: written === null ? {} : { cache_creation: { ephemeral_1h_input_tokens: written.h, ephemeral_5m_input_tokens: written.m } },
      },
      ...extra,
    })

  test('the TTL comes from the newest response that wrote to the cache', () => {
    const tail = [
      '{"cut": tru', // a tail's first line is usually partial
      row('2026-10-06T00:00:00.000Z', { h: 0, m: 900 }),
      row('2026-10-06T00:01:00.000Z', { h: 1963, m: 0 }),
      row('2026-10-06T00:02:00.000Z', { h: 0, m: 0 }),
      row('2026-10-06T00:03:00.000Z', { h: 0, m: 50 }, { isSidechain: true }),
      '{"type":"user","message":{"content":"hi"}}',
      '',
    ].join('\n')
    expect(parseTail(tail)).toEqual({ ttl: '1h', at: Date.parse('2026-10-06T00:02:00.000Z') })
  })

  test('nothing written yet leaves the TTL unknown', () => {
    expect(parseTail(row('2026-10-06T00:00:00.000Z', null))).toEqual({
      ttl: null,
      at: Date.parse('2026-10-06T00:00:00.000Z'),
    })
  })

  test('tiny shares and counts read with their unit', () => {
    const agents: Ctx = { window: 1_000_000, rows: [{ name: 'Custom agents', color: 'permission', tokens: 212, kind: 'used' }] }
    const run = layout(agents, 100)[0]
    expect(run === undefined ? '' : describeRun(run, agents.window)).toBe('Custom agents · 212 tokens · <0.1% of 1.0M')
  })

  test('the label counts down and turns over', () => {
    const at = 1_000_000
    // before the first request it says so; until the TTL is known it waits rather than guess
    expect(cacheLabel(null, at).text).toBe('no cache yet')
    expect(cacheLabel({ touchedAt: at, ttl: null }, at + 61_000).text).toBe('cache …')

    expect(cacheLabel({ touchedAt: at, ttl: '1h' }, at)).toMatchObject({ text: '1h-cache 60:00', color: 'success' })
    expect(cacheLabel({ touchedAt: at, ttl: '5m' }, at + 250_000)).toMatchObject({ text: '5m-cache 0:50', color: 'warning' })
    expect(cacheLabel({ touchedAt: at, ttl: '5m' }, at + 300_000)).toMatchObject({ text: 'cache expired <1m ago', color: 'error' })
    expect(cacheLabel({ touchedAt: at, ttl: '1h' }, at + 96 * 60_000).text).toBe('cache expired 36m ago')
    expect(cacheLabel({ touchedAt: at, ttl: '1h' }, at + 3 * 3600_000 + 59 * 60_000).text).toBe('cache expired 2h ago')
    expect(cacheLabel({ touchedAt: at, ttl: '5m' }, at + 50 * 3600_000).text).toBe('cache expired 2d ago')
    // the widest label fits the room kept for it
    expect('cache expired 59m ago'.length).toBe(LABEL_WIDTH)
  })
})

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 40_000, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 9_000, color: 'ide', isDeferred: true, kind: 'deferred' },
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
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 103, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

/** The squares as drawn, in order, without their separating spaces. */
async function squaresOf(ui: { findAll: (q: { type: string; text: RegExp }) => Promise<{ text: string }[]> }) {
  // a run is glyphs each followed by a space; the legend's glyphs stand alone
  const runs = await ui.findAll({ type: 'Text', text: /^([⛁⛀⛶⛝] )+$/ })
  return runs
    .map(t => t.text)
    .join('')
    .replaceAll(' ', '')
}

const TRANSCRIPT_AT = Date.parse('2026-10-06T00:30:00.000Z')

test('the band draws on the terminal and the desktop, a draft shows, the cache counts down', async ($, on) => {
  const clock = mock.clock(on, { now: TRANSCRIPT_AT })
  let box = { text: '', cursor: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, breakdown: BREAKDOWN }, rateLimits: [] },
  }))
  on('prompt.fill', ($, e) => {
    box = { text: e.text, cursor: e.text.length }
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: box }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  // the transcript's tail: one response that wrote to the 5m bucket
  const response = {
    type: 'assistant',
    timestamp: new Date(TRANSCRIPT_AT).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 } } },
  }
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  let isTranscriptWritten = false
  on('process.run', () => ({
    value: { exitCode: 0, stdout: isTranscriptWritten ? JSON.stringify(response) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/tmp/session.jsonl' })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // 103 columns less the 23 kept for the label: 40 squares of 5k tokens each
    expect(await squaresOf(ui)).toBe('⛁'.repeat(12) + '⛶'.repeat(21) + '⛝'.repeat(7))
    // no request yet: the label says so, not an empty space
    expect(await ui.find({ type: 'Text', text: 'no cache yet' })).toBeDefined()
    // one tooltip per square, on the band's own row: what it is, its share, how big a square is
    const systemTips = await ui.findAll({ type: 'Text', text: ' System prompt · 20k tokens · 10% of 200k ' })
    expect(systemTips).toHaveLength(4)
    expect(await ui.findAll({ type: 'Text', text: ' Autocompact buffer (kept for /compact) · 33k tokens · 17% of 200k ' })).toHaveLength(7)
    // drawn after every square, so a revealed one paints over its neighbours
    const boxes = await ui.findAll({ type: 'Box' })
    const keys = boxes.map(b => b.key ?? '')
    expect(keys.indexOf('tip-0')).toBeGreaterThan(keys.indexOf('sq-39'))
    // square 0's tip starts on square 1; the last square's ends on the one before it
    expect(boxes.find(b => b.key === 'tip-0')?.props).toMatchObject({ position: 'absolute', top: 0, left: 2, display: 'none' })
    // 40 squares: the last glyph is column 78, and no tip reaches the cache label past it
    // the last free square (32, columns 64-65) has no room after: its 40-wide tip ends on square 31
    expect(' Free space · 107k tokens · 54% of 200k '.length).toBe(40)
    expect(boxes.find(b => b.key === 'tip-32')?.props.left).toBe(64 - 40)
    // the last square's 67-wide tip ends on the square before it
    expect(boxes.find(b => b.key === 'tip-39')?.props.left).toBe(78 - 67)
    await ui.unmount()
  }

  // typing reaches the band through prompt.edit, which only the editor raises; a fill takes the same path
  await $.prompt.fill({ text: 'x'.repeat(40_000), mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  await clock.settle()
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 10k draft tokens after 60k used reach square 14 of 5k each
  expect(await squaresOf(ui)).toBe('⛁'.repeat(12) + '⛶'.repeat(2) + '⛶'.repeat(19) + '⛝'.repeat(7))
  expect(await ui.find({ type: 'Text', text: ' Prompt draft (typed, not sent) · ~10k tokens · 5.0% of 200k ' })).toBeDefined()
  await ui.unmount()

  // a main-loop request arms the countdown; its response tells the TTL
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  isTranscriptWritten = true
  await $.classic.Stop({ stop_hook_active: false })
  await clock.settle()
  await clock.advance(61_000)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '5m-cache 3:59' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 5m TTL · last request \d\d:\d\d:\d\d · expires \d\d:\d\d:\d\d $/ })).toBeDefined()
  await clock.advance(240_000)
  expect(await ui.find({ type: 'Text', text: 'cache expired <1m ago' })).toBeDefined()
  await clock.advance(36 * 60_000)
  expect(await ui.find({ type: 'Text', text: 'cache expired 36m ago' })).toBeDefined()
  await ui.unmount()

  // the legend, for terminals without hover
  const legend = await $.command.run({
    command: 'context-band',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 103 },
  })
  expect(legend.text).toContain('⛁ System prompt (light grey): 20k, 10%')
  expect(legend.text).toContain('⛁ Messages (orange): 40k, 20%')
  expect(legend.text).toContain('Prompt cache: 5m TTL · last request')
  expect(legend.text).toContain('Refresh: Refresh cache now · auto-refresh off')
})
