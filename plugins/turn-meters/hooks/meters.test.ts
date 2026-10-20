import { expect, mock, test } from 'claude-code/testing'

import type { Task } from '../types'
import { formatEta, nextPlan, remainingMs, ringCells } from './meters'

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
