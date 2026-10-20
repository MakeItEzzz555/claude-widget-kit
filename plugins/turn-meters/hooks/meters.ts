import type { Activity, Plan, Task } from '../types'

export const doneCount = (tasks: readonly Task[]) =>
  tasks.filter(task => task.status === 'completed').length

export const isFinished = (plan: Plan) => doneCount(plan.tasks) === plan.tasks.length

/** What the plan is on now: the task in progress, else the next pending one. */
export const currentTitle = (plan: Plan) => {
  const task =
    plan.tasks.find(one => one.status === 'in_progress') ?? plan.tasks.find(one => one.status === 'pending')
  return task === undefined ? undefined : (task.title ?? task.id)
}

/** The plan after the task list changed at `at`; a finished plan is replaced by a fresh one. */
export function nextPlan(prev: Plan | null, tasks: Task[], at: number): Plan | null {
  if (tasks.length === 0) return null
  const done = doneCount(tasks)
  if (prev === null || isFinished(prev)) {
    return { tasks, startedAt: at, lastDoneAt: at, baseDone: done }
  }

  return { ...prev, tasks, lastDoneAt: done > doneCount(prev.tasks) ? at : prev.lastDoneAt }
}

/** Milliseconds left at `at`: the pace so far times the tasks left, counting down since the last completion. */
export function remainingMs(plan: Plan, at: number): number | null {
  const done = doneCount(plan.tasks)
  const measured = done - plan.baseDone
  if (measured <= 0) return null
  const perTask = (plan.lastDoneAt - plan.startedAt) / measured

  return Math.max(0, perTask * (plan.tasks.length - done) - (at - plan.lastDoneAt))
}

export function formatEta(ms: number | null): string {
  if (ms === null) return 'est. …'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'est. <1 min'
  if (minutes < 60) return `est. ${minutes} min`

  return `est. ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export const RING_COLUMNS = 10
export const RING_ROWS = 5
const DEFAULT_COLOR = 0x01000000
const TRACK = 0x5c5c5c
// braille dot bits by [column][row] inside one cell
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

export const remainingColor = (remaining: number) =>
  remaining > 50 ? 0x4cc764 : remaining > 20 ? 0xf5b10a : 0xe0251b

/**
 * A braille ring, 10x5 cells (20x20 dots), as Raster cells: the remaining share
 * lit clockwise from 12 o'clock, the rest a dim track, the label in the middle.
 */
export function ringCells(remaining: number | null, label: string): string {
  const words = new Uint32Array(RING_COLUMNS * RING_ROWS * 3)
  const color = remaining === null ? TRACK : remainingColor(remaining)
  for (let row = 0; row < RING_ROWS; row++) {
    for (let col = 0; col < RING_COLUMNS; col++) {
      let bits = 0
      let lit = 0
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const x = col * 2 + dx + 0.5 - RING_COLUMNS
          const y = row * 4 + dy + 0.5 - RING_ROWS * 2
          const radius = Math.hypot(x, y)
          if (radius < 7 || radius > 9.8) continue
          bits |= DOTS[dx]?.[dy] ?? 0
          const turn = (Math.atan2(x, -y) / (2 * Math.PI) + 1) % 1
          if (remaining !== null && turn < remaining / 100) lit++
          else lit--
        }
      }
      const at = (row * RING_COLUMNS + col) * 3
      words[at] = bits === 0 ? 0x20 : 0x2800 + bits
      words[at + 1] = lit > 0 ? color : TRACK
      words[at + 2] = DEFAULT_COLOR
    }
  }
  const middle = Math.floor(RING_ROWS / 2) * RING_COLUMNS
  const start = middle + Math.floor((RING_COLUMNS - label.length) / 2)
  for (let i = 0; i < label.length; i++) {
    words[(start + i) * 3] = label.charCodeAt(i)
    words[(start + i) * 3 + 1] = remaining === null ? TRACK : color
  }

  // the hooks environment has Uint8Array#toBase64 (the Raster docs use it); es2023 typings do not
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

/** `claude-opus-5-5` -> `opus-5-5`, a dated id loses its date. */
export const shortModel = (model: string) =>
  model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, ' 1M')

/** 28_320 -> `28.3k`, 1_234_567 -> `1.23M`. */
export const formatTokens = (count: number) => {
  if (count < 1_000) return `${count}`
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 100_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`
}

/** 64_000 -> `1m 04s`, 25 min -> `25m`, 102 min -> `1h 42m`. */
export const formatSpan = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const formatAgo = (ms: number) => (ms < 45_000 ? 'now' : `${formatSpan(ms).split(' ')[0]} ago`)

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Bar heights for a series, scaled to its own largest value. */
export const sparkline = (values: readonly number[]) => {
  const top = Math.max(...values, 1)
  return values.map(value => SPARK[Math.min(7, Math.round((value / top) * 7))]).join('')
}

/** Cuts from the front, so a long path keeps its file name: `…/Package.swift`. */
export const fitTail = (text: string, room: number) => {
  const chars = [...text]
  return chars.length <= room ? text : `…${chars.slice(chars.length - Math.max(1, room - 1)).join('')}`
}

// `a/b/c/file.ts` -> `c/file.ts`: enough to recognise, never the full path
export const shortPath = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')

const WORD = /^[a-z][\w:.@-]{0,23}$/i

/** `FOO=1 npm test -- --x` -> `npm test`: the program and its subcommand, never the arguments. */
export function commandName(command: string) {
  const words = command.split(/[;&|\n]/)[0]?.trim().split(/\s+/).filter(word => !/^\w+=/.test(word)) ?? []
  const program = words[0]?.split('/').pop()
  if (program === undefined || !WORD.test(program)) return 'a command'
  return words[1] !== undefined && WORD.test(words[1]) ? `${program} ${words[1]}` : program
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const EDITS: Record<string, string> = { Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited' }

/**
 * One activity row for a tool call that ran, or null for a tool the feed leaves out.
 * Only the tool, a file's last two path parts, a command's program and subcommand
 * or a host name are kept: never contents, arguments or output.
 */
export function activityOf(tool: string, input: Record<string, unknown>, isError: boolean, at: number): Activity | null {
  const failed = isError ? 'failed' : null
  const edit = EDITS[tool]
  if (edit !== undefined) {
    const path = text(input.file_path) || text(input.notebook_path)
    return { at, verb: edit, target: shortPath(path), tone: isError ? 'bad' : 'edit', note: failed, path }
  }
  if (tool === 'Read') return { at, verb: 'Read', target: shortPath(text(input.file_path)), tone: isError ? 'bad' : 'idle', note: failed }
  if (tool === 'Bash') return { at, verb: 'Ran', target: commandName(text(input.command)), tone: isError ? 'bad' : 'ok', note: failed }
  if (tool === 'Grep' || tool === 'Glob') return { at, verb: 'Searched', target: tool.toLowerCase(), tone: 'idle', note: failed }
  if (tool === 'Agent' || tool === 'Task') {
    return { at, verb: 'Agent', target: text(input.subagent_type) || 'general-purpose', tone: isError ? 'bad' : 'agent', note: failed }
  }
  if (tool === 'WebFetch') {
    let host = 'a page'
    try {
      host = new URL(text(input.url)).hostname || host
    } catch {
      // not a URL: the host stays unnamed
    }
    return { at, verb: 'Fetched', target: host, tone: isError ? 'bad' : 'ok', note: failed }
  }
  if (tool === 'WebSearch') return { at, verb: 'Searched', target: 'the web', tone: isError ? 'bad' : 'ok', note: failed }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp !== null && mcp[1] !== 'turn-meters') return { at, verb: 'Called', target: `${mcp[1]} ${mcp[2]}`, tone: isError ? 'bad' : 'ok', note: failed }
  return null
}
