import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, AgentCard, Effort, Insights, Plan, Task, TaskStatus, Tone, Usage } from '../types'
import {
  activityOf,
  currentTitle,
  fitTail,
  doneCount,
  formatAgo,
  formatEta,
  formatSpan,
  formatTokens,
  isFinished,
  nextPlan,
  remainingColor,
  remainingMs,
  ringCells,
  RING_COLUMNS,
  RING_ROWS,
  shortModel,
  sparkline,
} from './meters'

const MAIN = 'main'
const loops = atom({ plugin: 'turn-meters', key: 'loops' } as const, {})
const plans = atom({ plugin: 'turn-meters', key: 'plans' } as const, {})
const agents = atom({ plugin: 'turn-meters', key: 'agents' } as const, [])
const usage = atom({ plugin: 'turn-meters', key: 'usage' } as const, {
  fiveHour: null,
  week: null,
  context: null,
  fiveHourResetsAt: null,
  weekResetsAt: null,
  contextTokens: null,
  contextWindow: null,
  startedAt: null,
})
const insights = atom({ plugin: 'turn-meters', key: 'insights' } as const, {
  turns: { count: 0, totalMs: 0, lastMs: null, recent: [] },
  turnStartedAt: null,
  tokens: null,
  outputs: [],
  compactions: 0,
  activity: [],
  files: [],
})
const now = atom({ plugin: 'turn-meters', key: 'now' } as const, 0)

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const TICKS = ['▂', '▃', '▄', '▆', '█']
// yellow -> red, one per effort level
const HEAT = ['#f5d90a', '#f5b10a', '#f5820a', '#ef5310', '#e0251b']
const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']
const ACTIVE: readonly string[] = ['pending', 'running', 'waiting', 'idle']
const MAX_AGENTS = 9
const MAX_ACTIVITY = 8
const MAX_SERIES = 32
const MAX_FILES = 500
const PANE = 'agent-panel'
const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Session', columns: 44 })
const TONES: Record<Tone, string> = { ok: 'success', bad: 'error', edit: 'suggestion', agent: 'merged', idle: 'inactive' }
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

const resetOf = (iso: string | undefined) => {
  const at = iso === undefined ? NaN : Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

const readUsage = (
  from: {
    context: { percent?: number; tokens?: number; window: number }
    rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  },
  startedAt: number | null,
): Usage => {
  const fiveHour = from.rateLimits.find(limit => limit.kind === 'five_hour')
  const week = from.rateLimits.find(limit => limit.kind === 'seven_day')
  return {
    fiveHour: fiveHour?.percentUsed ?? null,
    week: week?.percentUsed ?? null,
    context: from.context.percent ?? null,
    fiveHourResetsAt: resetOf(fiveHour?.resetsAt),
    weekResetsAt: resetOf(week?.resetsAt),
    contextTokens: from.context.tokens ?? null,
    contextWindow: from.context.tokens === undefined ? null : from.context.window,
    startedAt,
  }
}

const measureUsage = async ($: EngineInterface) => {
  const now = await $.session.usage()
  await writeUsage($, readUsage(now, now.startedAt))
}

const addActivity = (all: Insights, entry: Activity): Insights => {
  const path = entry.path
  const files = path === undefined || path === '' || all.files.includes(path) ? all.files : [...all.files, path].slice(0, MAX_FILES)
  const { path: _, ...row } = entry
  return { ...all, files, activity: [...all.activity, row].slice(-MAX_ACTIVITY) }
}

/** Folds a finished turn into the counts: every loop's tokens, the main loop's turns. */
const recordTurn = async ($: EngineInterface, e: { agentId?: string; durationMs: number; reason: string; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } }) => {
  await update($, insights, all => {
    const used = e.usage
    const tokens =
      used === undefined
        ? all.tokens
        : {
            input: (all.tokens?.input ?? 0) + used.input_tokens,
            output: (all.tokens?.output ?? 0) + used.output_tokens,
            cacheRead: (all.tokens?.cacheRead ?? 0) + used.cache_read_input_tokens,
            cacheWrite: (all.tokens?.cacheWrite ?? 0) + used.cache_creation_input_tokens,
          }
    if (e.agentId !== undefined) return { ...all, tokens }
    // an interrupted or failed turn ends the live timer but is not a completed turn
    const isAnswered = e.reason === 'answer' || e.reason === 'refusal'
    const turns = isAnswered
      ? {
          count: all.turns.count + 1,
          totalMs: all.turns.totalMs + e.durationMs,
          lastMs: e.durationMs,
          recent: [...all.turns.recent, e.durationMs].slice(-MAX_SERIES),
        }
      : all.turns
    const outputs = used === undefined ? all.outputs : [...all.outputs, used.output_tokens].slice(-MAX_SERIES)
    return { ...all, tokens, turns, outputs, turnStartedAt: null }
  })
}

const refreshAgents = async ($: EngineInterface) => {
  const list = await $.agent.list()
  await writeAgents(
    $,
    list
      .filter(agent => ACTIVE.includes(agent.status))
      .map(({ id, description, type, status }) => ({ id, description, type, status })),
  )
}

// Every second while the main loop works, for its live turn time; every ten seconds otherwise.
const tick = async ($: EngineInterface, isFull: boolean) => {
  const isLive = (await read($, insights)).turnStartedAt !== null
  if (!isLive && !isFull) return
  if (isFull && (await read($, agents)).length > 0) await refreshAgents($)
  const at = await $.clock.now()
  await update($, now, () => at)
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
    // Keeps ETAs and timers counting and agent statuses fresh between events.
    let ticks = 0
    $.clock.every(1_000, () => void quietly(tick($, ticks++ % 10 === 0)))
    await quietly(refreshAgents($))
    await quietly(measureUsage($))

    return next(e)
  })

  on('command.run', { command: 'agent-panel' }, async $ => {
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Session panel opened.' : 'The session panel is waiting for room to open.' }
  })

  on('session.measure', async ($, e, next) => {
    // the start time comes from $.session.usage() at session.start and each step, never from inside a measure
    await quietly((async () => writeUsage($, readUsage(e, (await read($, usage)).startedAt)))())

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await quietly(
        (async () => {
          const at = await $.clock.now()
          await update($, insights, all => ({ ...all, turnStartedAt: at }))
        })(),
      )
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    // a precompute installs nothing; a subagent's compaction is its own
    if (e.trigger !== 'precompute' && e.agentId === undefined && compacted.skip === undefined) {
      await quietly(
        (async () => {
          const at = await $.clock.now()
          await update($, insights, all =>
            addActivity({ ...all, compactions: all.compactions + 1 }, { at, verb: 'Compacted', target: 'context', tone: 'idle', note: e.trigger }),
          )
        })(),
      )
    }

    return compacted
  }).catch(($, e, next) => next(e))

  // The activity feed: a privacy-safe line for each tool call that ran.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      await quietly(
        (async () => {
          const entry = activityOf(e.tool, e as unknown as Record<string, unknown>, ran.isError === true, await $.clock.now())
          if (entry !== null) await update($, insights, all => addActivity(all, entry))
        })(),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

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
    if (e.agentId === undefined) await quietly(measureUsage($))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    await quietly(recordTurn($, e))
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
    const [allLoops, allPlans, used, seen] = await Promise.all([read($, loops), read($, plans), read($, usage), read($, insights)])
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
    // the compact session summary: elapsed, turns, the live turn and the token total
    if (used.startedAt !== null && (seen.turns.count > 0 || seen.turnStartedAt !== null)) {
      mainRows.push(
        <Text wrap="truncate-end">
          <Text dimColor>session </Text>
          <Text>{formatSpan(at - used.startedAt)}</Text>
          <Text dimColor> · {seen.turns.count} turn{seen.turns.count === 1 ? '' : 's'}</Text>
          {seen.turnStartedAt !== null && <Text color="claude"> · live {formatSpan(at - seen.turnStartedAt)}</Text>}
          {seen.tokens !== null && <Text dimColor> · {formatTokens(seen.tokens.input + seen.tokens.cacheRead + seen.tokens.cacheWrite + seen.tokens.output)} tokens</Text>}
        </Text>,
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

  // The right-hand panel, a dashboard of cards: session, tokens, turns, context, limits, agents, activity.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [allLoops, allPlans, cards, used, seen] = await Promise.all([
      read($, loops),
      read($, plans),
      read($, agents),
      read($, usage),
      read($, insights),
    ])
    await read($, now) // redraws on the ticker
    const { Box, Text } = $.ui.resolve(e)
    const at = await $.clock.now()
    const { effortTicks, effortLabel, progressBar } = meterParts($, e, at)
    const width = e.props.bodyColumns
    // two cards a row once the pane is wide enough for both
    const half = width >= 88 ? Math.floor((width - 1) / 2) : width
    const inner = half - 4

    const waiting = (text: string) => <Text dimColor wrap="truncate-end">{text}</Text>
    const box = (key: string, icon: string, title: string, value: JSX.Element | null, rows: JSX.Element[], size = half) => (
      <Box key={key} flexDirection="column" width={size} borderStyle="round" borderDimColor paddingX={1}>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color="claude">{icon} </Text>
            <Text bold>{title}</Text>
          </Text>
          {value}
        </Box>
        {rows}
      </Box>
    )
    const meter = (share: number, size: number, color: string) => {
      const filled = Math.round(Math.max(0, Math.min(1, share)) * size)
      return (
        <Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(size - filled)}</Text>
        </Text>
      )
    }
    const remaining = (percent: number | null) => (percent === null ? null : Math.max(0, Math.round(100 - percent)))
    // theme keys, so the meters keep contrast on light themes too
    const leftColor = (left: number) => (left > 50 ? 'success' : left > 20 ? 'warning' : 'error')

    const session = box(
      'session',
      '◷',
      'Session',
      seen.turnStartedAt !== null ? <Text color="success">● Working</Text> : <Text dimColor>○ Idle</Text>,
      [
        used.startedAt === null ? (
          waiting('Start time unknown')
        ) : (
          <Text>
            <Text dimColor>elapsed </Text>
            <Text bold>{formatSpan(at - used.startedAt)}</Text>
          </Text>
        ),
        ...(seen.turnStartedAt === null
          ? []
          : [
              <Text>
                <Text dimColor>this turn </Text>
                <Text color="claude">{formatSpan(at - seen.turnStartedAt)}</Text>
              </Text>,
            ]),
        allLoops[MAIN] === undefined ? (
          waiting('No model request yet')
        ) : (
          <Box>
            {effortTicks(allLoops[MAIN].effort)}
            {effortLabel(allLoops[MAIN])}
          </Box>
        ),
      ],
    )

    const tokens = seen.tokens
    const tokenCard = box(
      'tokens',
      '≋',
      'Tokens',
      tokens === null ? null : <Text bold>{formatTokens(tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output)}</Text>,
      tokens === null
        ? [waiting('Waiting for a finished turn')]
        : [
            <Text wrap="truncate-end">
              <Text dimColor>in </Text>
              {formatTokens(tokens.input)}
              <Text dimColor> · out </Text>
              {formatTokens(tokens.output)}
            </Text>,
            <Text wrap="truncate-end">
              <Text dimColor>cache read </Text>
              {formatTokens(tokens.cacheRead)}
              <Text dimColor> · write </Text>
              {formatTokens(tokens.cacheWrite)}
            </Text>,
            ...(seen.outputs.length > 1
              ? [
                  <Text wrap="truncate-end">
                    <Text color="claude">{sparkline(seen.outputs.slice(-Math.max(4, inner - 16)))}</Text>
                    <Text dimColor> output per turn</Text>
                  </Text>,
                ]
              : []),
          ],
    )

    const { count, totalMs, lastMs, recent } = seen.turns
    // a count, never "n of m": Claude Code has no turn quota
    const turnCard = box('turns', '↻', 'Turns', <Text bold>{count} done</Text>, [
      count === 0 ? (
        waiting('No completed turn yet')
      ) : (
        <Text wrap="truncate-end">
          <Text dimColor>avg </Text>
          {formatSpan(totalMs / count)}
          <Text dimColor> · last </Text>
          {lastMs === null ? '—' : formatSpan(lastMs)}
        </Text>
      ),
      ...(recent.length > 1
        ? [
            <Text wrap="truncate-end">
              <Text color="claude">{sparkline(recent.slice(-Math.max(4, inner - 14)))}</Text>
              <Text dimColor> turn lengths</Text>
            </Text>,
          ]
        : []),
    ])

    const contextLeft = remaining(used.context)
    const contextCard = box(
      'context',
      '◧',
      'Context',
      contextLeft === null ? null : <Text color={leftColor(contextLeft)} bold>{contextLeft}% left</Text>,
      contextLeft === null
        ? [waiting('Waiting for the first response')]
        : [
            meter(contextLeft / 100, Math.min(inner, 30), leftColor(contextLeft)),
            ...(used.contextTokens === null || used.contextWindow === null
              ? []
              : [
                  <Text wrap="truncate-end">
                    {formatTokens(used.contextTokens)}
                    <Text dimColor> / {formatTokens(used.contextWindow)} tokens</Text>
                  </Text>,
                ]),
            ...(seen.compactions > 0 ? [<Text color="warning">compacted {seen.compactions}×</Text>] : []),
          ],
    )

    const limit = (key: string, title: string, percent: number | null, resetsAt: number | null) => {
      const left = remaining(percent)
      return box(
        key,
        key === 'five-hour' ? '◔' : '▦',
        title,
        left === null ? null : <Text color={leftColor(left)} bold>{left}% left</Text>,
        left === null || percent === null
          ? [waiting('Waiting for rate limits')]
          : [
              meter(left / 100, Math.min(inner, 30), leftColor(left)),
              <Text wrap="truncate-end">
                <Text dimColor>{Math.round(percent)}% used · </Text>
                {resetsAt === null ? <Text dimColor>reset time unknown</Text> : <Text>resets in {formatSpan(resetsAt - at)}</Text>}
              </Text>,
            ],
      )
    }

    const agentCard = (
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

    const activity = box(
      'activity',
      '∿',
      'Recent activity',
      seen.files.length === 0 ? null : <Text dimColor>{seen.files.length} file{seen.files.length === 1 ? '' : 's'} edited</Text>,
      seen.activity.length === 0
        ? [waiting('No tool calls yet')]
        : [...seen.activity].reverse().map((entry, i) => {
            const ago = formatAgo(at - entry.at)
            // dot, verb column, the note and the time keep their room; the target gives way from its front
            const room = width - 4 - 2 - 9 - (entry.note === null ? 0 : entry.note.length + 1) - ago.length - 1
            return (
              <Box key={`activity-${i}`} justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color={TONES[entry.tone]}>● </Text>
                  {entry.verb.padEnd(9)}
                  <Text color="suggestion">{fitTail(entry.target, room)}</Text>
                  {entry.note !== null && <Text dimColor> {entry.note}</Text>}
                </Text>
                <Text dimColor> {ago}</Text>
              </Box>
            )
          }),
      width,
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {session}
          {tokenCard}
          {turnCard}
          {contextCard}
          {limit('five-hour', '5h limit', used.fiveHour, used.fiveHourResetsAt)}
          {limit('week', 'Weekly limit', used.week, used.weekResetsAt)}
        </Box>
        {agentCard(MAIN, 'claude', 'Claude', 'main', allLoops[MAIN], allPlans[MAIN])}
        {cards.length === 0 && <Text dimColor> No agents running</Text>}
        {cards.slice(0, MAX_AGENTS).map(agent =>
          agentCard(
            agent.id,
            agent.status === 'running' ? 'success' : agent.status === 'idle' ? 'inactive' : 'warning',
            agent.description || agent.type,
            agent.type,
            allLoops[agent.id],
            allPlans[agent.id],
          ),
        )}
        {cards.length > MAX_AGENTS && <Text dimColor> +{cards.length - MAX_AGENTS} more agents</Text>}
        {activity}
      </Box>
    )
  })
}
