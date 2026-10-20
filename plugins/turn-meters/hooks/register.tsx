import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentCard, Effort, Plan, Task, TaskStatus, Usage } from '../types'
import {
  currentTitle,
  doneCount,
  formatEta,
  isFinished,
  nextPlan,
  remainingColor,
  remainingMs,
  ringCells,
  RING_COLUMNS,
  RING_ROWS,
  shortModel,
} from './meters'

const MAIN = 'main'
const loops = atom({ plugin: 'turn-meters', key: 'loops' } as const, {})
const plans = atom({ plugin: 'turn-meters', key: 'plans' } as const, {})
const agents = atom({ plugin: 'turn-meters', key: 'agents' } as const, [])
const usage = atom({ plugin: 'turn-meters', key: 'usage' } as const, {
  fiveHour: null,
  week: null,
  context: null,
})
const now = atom({ plugin: 'turn-meters', key: 'now' } as const, 0)

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const TICKS = ['▂', '▃', '▄', '▆', '█']
// yellow -> red, one per effort level
const HEAT = ['#f5d90a', '#f5b10a', '#f5820a', '#ef5310', '#e0251b']
const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']
const ACTIVE: readonly string[] = ['pending', 'running', 'waiting', 'idle']
const MAX_AGENTS = 9
const PANE = 'agent-panel'
const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Agents', columns: 44 })
// a pattern, not the name: the engine's tool-name types predate this mod's own tool
const PROGRESS_TOOL = /^mcp__turn-meters__progress$/

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

/** The effort ticks, effort label and progress bar the band and the panel share. */
const meterParts = ($: EngineInterface, e: RenderEvent, at: number) => {
  const { Box, Text } = $.ui.resolve(e)
  const effortTicks = (level: Effort | null | undefined) => {
    const index = typeof level === 'string' ? LEVELS.indexOf(level) : -1
    return TICKS.map((mark, i) =>
      i <= index ? <Text color={HEAT[i] ?? 'text'}>{mark}</Text> : <Text dimColor>{mark}</Text>,
    )
  }
  const effortLabel = (loop: { model: string; effort: Effort | null }) => {
    const index = typeof loop.effort === 'string' ? LEVELS.indexOf(loop.effort) : -1
    const words = ` ${loop.effort ?? 'no effort'} · ${shortModel(loop.model)}`
    return index < 0 ? (
      <Text dimColor wrap="truncate-end">{words}</Text>
    ) : (
      <Text color={HEAT[index] ?? 'text'} wrap="truncate-end">{words}</Text>
    )
  }
  const progressBar = (plan: Plan, width: number) => {
    const done = doneCount(plan.tasks)
    const isDone = done === plan.tasks.length
    const tail = ` ${done}/${plan.tasks.length} · ${isDone ? 'done' : formatEta(remainingMs(plan, at))}`
    const size = Math.max(4, Math.min(40, width - tail.length))
    const filled = Math.round((done / plan.tasks.length) * size)
    return (
      <Box>
        <Text color={isDone ? 'success' : 'claude'}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(size - filled)}</Text>
        <Text dimColor wrap="truncate-end">{tail}</Text>
      </Box>
    )
  }

  return { effortTicks, effortLabel, progressBar }
}

// State bookkeeping must never disturb a model request or a tool call.
const quietly = (work: Promise<unknown>) => work.catch(() => undefined)

// Write only a changed value, so an unchanged reading redraws nothing.
const writeUsage = async ($: EngineInterface, value: Usage) => {
  if (JSON.stringify(await read($, usage)) !== JSON.stringify(value)) await update($, usage, () => value)
}
const writeAgents = async ($: EngineInterface, value: AgentCard[]) => {
  if (JSON.stringify(await read($, agents)) !== JSON.stringify(value)) await update($, agents, () => value)
}

const editTasks = async ($: EngineInterface, key: string, edit: (tasks: Task[]) => Task[]) => {
  const at = await $.clock.now()
  await update($, plans, all => {
    const { [key]: prev, ...rest } = all
    const plan = nextPlan(prev ?? null, edit(prev?.tasks ?? []), at)
    return plan === null ? rest : { ...rest, [key]: plan }
  })
}

const readUsage = (from: {
  context: { percent?: number }
  rateLimits: readonly { kind: string; percentUsed: number }[]
}): Usage => ({
  fiveHour: from.rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed ?? null,
  week: from.rateLimits.find(limit => limit.kind === 'seven_day')?.percentUsed ?? null,
  context: from.context.percent ?? null,
})

const refreshAgents = async ($: EngineInterface) => {
  const list = await $.agent.list()
  await writeAgents(
    $,
    list
      .filter(agent => ACTIVE.includes(agent.status))
      .map(({ id, description, type, status }) => ({ id, description, type, status })),
  )
}

const tick = async ($: EngineInterface) => {
  if ((await read($, agents)).length > 0) await refreshAgents($)
  if (Object.values(await read($, plans)).some(plan => !isFinished(plan))) {
    const at = await $.clock.now()
    await update($, now, () => at)
  }
}

const parseSteps = (steps: unknown): Task[] | null =>
  Array.isArray(steps) &&
  steps.every(
    step =>
      typeof step?.title === 'string' &&
      typeof step?.status === 'string' &&
      STATUSES.includes(step.status),
  )
    ? steps.map(step => ({ id: step.title, status: step.status as TaskStatus, title: step.title }))
    : null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'progress',
      description:
        'Shows the person a live progress bar with a time estimate for a multi-step task. ' +
        'Skip it when TodoWrite or the Task tools already track the work. Otherwise call it ' +
        'when you start a task of 3 or more steps, with every step, and again each time a ' +
        "step's status changes. Always send the whole list.",
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: STATUSES },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'agent-panel',
      description: 'Open the agents panel: what each agent is on, its progress and time left',
    })
    void quietly(openPane($))
    // Keeps ETAs counting down and agent statuses fresh between events.
    $.clock.every(10_000, () => void quietly(tick($)))
    await quietly(refreshAgents($))
    await quietly(writeUsage($, readUsage(await $.session.usage())))

    return next(e)
  })

  on('command.run', { command: 'agent-panel' }, async $ => {
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Agents panel opened.' : 'The agents panel is waiting for room to open.' }
  })

  on('session.measure', async ($, e, next) => {
    await quietly(writeUsage($, readUsage(e)))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const key = e.agentId ?? MAIN
    const loop = { model: e.model, effort: e.effort ?? null }
    await quietly(
      (async () => {
        if (JSON.stringify((await read($, loops))[key]) !== JSON.stringify(loop)) {
          await update($, loops, all => ({ ...all, [key]: loop }))
        }
        if (e.agentId !== undefined && !(await read($, agents)).some(agent => agent.id === e.agentId)) {
          await refreshAgents($)
        }
      })(),
    )
    const result = yield* next(e)
    // context fills during a turn; the engine only measures at its end
    if (e.agentId === undefined) await quietly((async () => writeUsage($, readUsage(await $.session.usage())))())

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await quietly(refreshAgents($))

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await quietly(refreshAgents($))

    return spawned
  }).catch(($, e, next) => next(e))

  // A finished main plan stays up until the next prompt.
  on('prompt.submit', async ($, e, next) => {
    const plan = (await read($, plans))[MAIN]
    if (plan !== undefined && isFinished(plan)) await editTasks($, MAIN, () => [])

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const tasks = parseSteps((e as { steps?: unknown }).steps)
    if (tasks === null) {
      return { deny: 'steps must be a list of { title, status: pending | in_progress | completed }.' }
    }
    await editTasks($, e.agentId ?? MAIN, () => tasks)

    return { result: `Progress shown: ${doneCount(tasks)}/${tasks.length} steps done.` }
  }).catch(() => ({ deny: 'turn-meters could not show the progress bar.' }))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      await editTasks($, e.agentId ?? MAIN, () =>
        e.todos.map(todo => ({ id: todo.content, status: todo.status, title: todo.activeForm || todo.content })),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The Task tools keep one shared list: it feeds the main plan.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && !ran.isError ? ran.result.task.id : undefined
    if (id !== undefined) {
      // a new task after a finished list starts a new plan rather than extending the old one
      await editTasks($, MAIN, tasks => [
        ...(doneCount(tasks) === tasks.length ? [] : tasks),
        { id, status: 'pending', title: e.activeForm ?? e.subject },
      ])
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const status = e.status
    const title = e.activeForm ?? e.subject
    if (ran.deny === undefined && !ran.isError && (status !== undefined || title !== undefined)) {
      await editTasks($, MAIN, tasks =>
        status === 'deleted'
          ? tasks.filter(task => task.id !== e.taskId)
          : tasks.map(task =>
              task.id === e.taskId ? { ...task, ...(status && { status }), ...(title && { title }) } : task,
            ),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  // TaskList resyncs the statuses of the tasks the main plan tracks.
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const listed = new Map(ran.result.tasks.map(task => [task.id, task.status]))
      await editTasks($, MAIN, tasks =>
        tasks.flatMap(task => {
          const status = listed.get(task.id)
          return status === undefined ? [] : [{ ...task, status }]
        }),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [allLoops, allPlans, used] = await Promise.all([read($, loops), read($, plans), read($, usage)])
    await read($, now) // redraws on the ETA ticker
    const mainLoop = allLoops[MAIN]
    const mainPlan = allPlans[MAIN]
    const gauges = (
      [
        ['5h', used.fiveHour],
        ['week', used.week],
        ['ctx', used.context],
      ] as const
    ).flatMap(([label, percent]) =>
      percent === null ? [] : [{ label, left: Math.max(0, Math.round(100 - percent)) }],
    )
    if (mainLoop === undefined && mainPlan === undefined && gauges.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // Raster is the terminal's alone; other surfaces get the percentage as text
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    const at = await $.clock.now()
    const columns = e.props.bodyColumns

    const { effortTicks, effortLabel, progressBar } = meterParts($, e, at)

    // Rings on the left, the main loop's effort and tasks beside them when they fit.
    const ringsWidth = gauges.length * RING_COLUMNS + Math.max(0, gauges.length - 1) * 2
    const isBeside = gauges.length > 0 && columns - ringsWidth - 3 >= 34
    const rowsWidth = isBeside ? columns - ringsWidth - 3 : columns
    const mainRows = []
    if (mainLoop !== undefined) {
      mainRows.push(
        <Box>
          <Text dimColor>effort </Text>
          {effortTicks(mainLoop.effort)}
          {effortLabel(mainLoop)}
        </Box>,
      )
    }
    if (mainPlan !== undefined) {
      mainRows.push(
        <Box>
          <Text dimColor>tasks  </Text>
          {progressBar(mainPlan, rowsWidth - 7)}
        </Box>,
      )
    }
    const rings = gauges.map(({ label, left }) => (
      <Box flexDirection="column" alignItems="center" width={RING_COLUMNS}>
        {Raster ? (
          <Raster key={`ring-${label}`} columns={RING_COLUMNS} rows={RING_ROWS} cells={ringCells(left, `${left}%`)} />
        ) : (
          <Text color={hex(remainingColor(left))}>{left}%</Text>
        )}
        <Text dimColor>{label} left</Text>
      </Box>
    ))

    return (
      <Box flexDirection="column">
        {(rings.length > 0 || mainRows.length > 0) && (
          <Box flexDirection={isBeside ? 'row' : 'column'} columnGap={3}>
            {rings.length > 0 && <Box columnGap={2}>{rings}</Box>}
            {mainRows.length > 0 && (
              <Box flexDirection="column" justifyContent="center">
                {mainRows}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })

  // The right-hand panel: the main loop, then each running agent, top to bottom.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [allLoops, allPlans, cards] = await Promise.all([read($, loops), read($, plans), read($, agents)])
    await read($, now) // redraws on the ETA ticker
    const { Box, Text } = $.ui.resolve(e)
    const { effortTicks, effortLabel, progressBar } = meterParts($, e, await $.clock.now())
    const width = e.props.bodyColumns

    const card = (
      id: string,
      dot: string,
      name: string,
      kind: string,
      loop: { model: string; effort: Effort | null } | undefined,
      plan: Plan | undefined,
    ) => (
      <Box key={`card-${id}`} flexDirection="column" width={width} borderStyle="round" borderDimColor paddingX={1}>
        <Text wrap="truncate-end">
          <Text color={dot}>● </Text>
          <Text bold>{name}</Text>
          <Text dimColor> {kind}</Text>
        </Text>
        {plan === undefined ? (
          <Text dimColor>no task list yet</Text>
        ) : (
          <Box flexDirection="column">
            <Text wrap="truncate-end">▸ {currentTitle(plan) ?? 'all tasks done'}</Text>
            {progressBar(plan, width - 4)}
          </Box>
        )}
        {loop === undefined ? (
          <Text dimColor>no model request yet</Text>
        ) : (
          <Box>
            {effortTicks(loop.effort)}
            {effortLabel(loop)}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {card(MAIN, 'claude', 'Claude', 'main', allLoops[MAIN], allPlans[MAIN])}
        {cards.length === 0 && <Text dimColor> No agents running</Text>}
        {cards.slice(0, MAX_AGENTS).map(agent =>
          card(
            agent.id,
            agent.status === 'running' ? 'success' : agent.status === 'idle' ? 'inactive' : 'warning',
            agent.description || agent.type,
            agent.type,
            allLoops[agent.id],
            allPlans[agent.id],
          ),
        )}
        {cards.length > MAX_AGENTS && <Text dimColor> +{cards.length - MAX_AGENTS} more agents</Text>}
      </Box>
    )
  })
}
