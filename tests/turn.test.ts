import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionContextBreakdown } from 'claude-code'

import { ADDED_MIN_TOKENS, addedLine, addedSince, describeAdded, layout } from '../hooks/layout'
import type { Ctx } from '../types'

const CTX: Ctx = {
  window: 200_000,
  rows: [
    { name: 'System prompt', color: 'promptBorder', tokens: 20_000, kind: 'used' },
    { name: 'MCP tools', color: 'cyan_FOR_SUBAGENTS_ONLY', tokens: 10_000, kind: 'used' },
    { name: 'Messages', color: 'purple_FOR_SUBAGENTS_ONLY', tokens: 52_000, kind: 'used' },
    { name: 'Free space', color: 'promptBorder', tokens: 118_000, kind: 'free' },
  ],
}

describe('what a turn added', () => {
  test('each category that grew, by how much; shrinking, holding and noise are left out', () => {
    const before = { 'System prompt': 20_050, 'MCP tools': 0, Messages: 40_000 }
    expect(addedSince(CTX, before)).toEqual({ 'MCP tools': 10_000, Messages: 12_000 })
    expect(addedSince(CTX, { ...before, Messages: 52_000 - ADDED_MIN_TOKENS + 1 })).toEqual({ 'MCP tools': 10_000 })
    expect(addedSince(CTX, null)).toEqual({})
  })

  test('a category grown by a turn ends in solid squares: round(growth / square), at least one', () => {
    // 20 squares of 10k: Messages holds 52k in 5 squares; 12k is 1.2 squares, so the last one is new
    const runs = layout(CTX, 20, 0, { Messages: 12_000, 'MCP tools': 300 })
    const messages = runs.find(r => r.name === 'Messages')
    expect(messages?.text).toBe('⛁ ⛁ ⛁ ⛁ ⛃ ')
    // 25k is 2.5 squares: the last three
    expect(layout(CTX, 20, 0, { Messages: 25_000 }).find(r => r.name === 'Messages')?.text).toBe('⛁ ⛁ ⛃ ⛃ ⛃ ')
    expect(messages?.added).toBe(12_000)
    // 300 tokens still marks one square: MCP tools is one square, now solid
    expect(runs.find(r => r.name === 'MCP tools')?.text).toBe('⛃ ')
    expect(runs.find(r => r.name === 'System prompt')?.text).toBe('⛁ ⛁ ')
  })

  test('a part-full last square that is new is the solid part-full glyph', () => {
    const ctx: Ctx = { window: 200_000, rows: [{ name: 'Messages', color: 'claude', tokens: 25_000, kind: 'used' }] }
    expect(layout(ctx, 20, 0, { Messages: 4000 })[0]?.text).toBe('⛁ ⛁ ⛂ ')
  })

  test('the hover teaches the solid glyph, on the new squares and the rest of the category', () => {
    const messages = layout(CTX, 20, 0, { Messages: 12_000 }).find(r => r.name === 'Messages')
    if (messages === undefined) throw new Error('no Messages run')
    expect(describeAdded(messages, CTX.window, 'last', true)).toBe('⛃ added last turn: Messages +12k · now 52k tokens, 26% of 200k')
    expect(describeAdded(messages, CTX.window, 'this', false)).toBe('Messages · 52k tokens · 26% of 200k · +12k this turn (⛃)')
    const system = layout(CTX, 20, 0, { Messages: 12_000 }).find(r => r.name === 'System prompt')
    if (system === undefined) throw new Error('no System prompt run')
    expect(describeAdded(system, CTX.window, 'last', false)).toBe('System prompt · 20k tokens · 10% of 200k')
  })

  test('the legend line', () => {
    expect(addedLine({ Messages: 6200, 'MCP tools': 1400 }, 'last')).toBe('Last turn (⛃): Messages +6.2k · MCP tools +1.4k')
    expect(addedLine({}, 'this')).toBe('This turn: no growth')
  })
})

const breakdown = (messages: number): SessionContextBreakdown => ({
  categories: [
    { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: messages, color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 180_000 - messages, color: 'promptBorder', isDeferred: false, kind: 'free' },
  ],
  totalTokens: 20_000 + messages,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'auto',
  percentage: 0,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
})

const BAND = {
  plugin: 'context-band',
  component: 'AbovePrompt',
  surface: 'terminal',
  // 103 columns: 40 squares of 5k
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 103, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

test('the squares a turn adds are solid, through the turn and until the next one starts', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-06T00:00:00.000Z') })
  mock.env(on, {})
  let messages = 40_000
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: breakdown(messages) }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: {} }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.measure', ($, e) => ({ changed: e.changed }))

  const measure = () => $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
  const squares = async (ui: { findAll: (q: { type: string; text: RegExp; in: string }) => Promise<{ text: string }[]> }) =>
    (await ui.findAll({ type: 'Text', text: /^([⛁⛀⛃⛂⛶⛝] )+$/, in: 'band' })).map(t => t.text.replaceAll(' ', '')).join('')
  const tipAt = async (x: number) => {
    await ui.pointer({ type: 'move', x, y: 0, in: 'band' })
    return (await ui.find({ type: 'Box', key: 'tip', in: 'band' }))?.text
  }

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  // before any turn nothing is new
  expect(await squares(ui)).toBe('⛁'.repeat(12) + '⛶'.repeat(28))

  // a turn starts, and its responses grow Messages by 12k: 2 squares (5k each) turn solid
  await $.turn.start({ text: 'go', turnId: 't1' })
  messages = 52_000
  await measure()
  expect(await squares(ui)).toBe('⛁'.repeat(12) + '⛃'.repeat(2) + '⛶'.repeat(26))
  // squares 12-13 are the new ones; 4-11 are Messages from before
  expect(await tipAt(24)).toBe(' ⛃ added last turn: Messages +12k · now 52k tokens, 26% of 200k ')
  expect(await tipAt(10)).toBe(' Messages · 52k tokens · 26% of 200k · +12k last turn (⛃) ')

  // the turn ends: the marks stay as the last turn's
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await squares(ui)).toBe('⛁'.repeat(12) + '⛃'.repeat(2) + '⛶'.repeat(26))

  const legend = await $.command.run({
    command: 'context-band',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 103 },
  })
  expect(legend.text).toContain('Last turn (⛃): Messages +12k')

  // the next turn starts from here: nothing is new until it adds something
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(await squares(ui)).toBe('⛁'.repeat(14) + '⛶'.repeat(26))
  await ui.unmount()
})
