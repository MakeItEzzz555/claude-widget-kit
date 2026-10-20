import type { Plan, Task } from '../types'

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
