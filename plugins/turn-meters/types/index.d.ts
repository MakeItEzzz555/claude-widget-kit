export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
export type TaskStatus = 'pending' | 'in_progress' | 'completed'
/** `title`: what the task is, as the panel shows it (the `activeForm` while one is given). */
export type Task = { id: string; status: TaskStatus; title?: string }
/** `baseDone`: tasks already completed when the plan started, left out of the pace. */
export type Plan = { tasks: Task[]; startedAt: number; lastDoneAt: number; baseDone: number }
/** The model and effort a loop's last request used. */
export type Loop = { model: string; effort: Effort | null }
export type AgentCard = { id: string; description: string; type: string; status: string }
/** Percent used, 0-100; null until a reading exists. */
export type Usage = { fiveHour: number | null; week: number | null; context: number | null }

declare module 'claude-code' {
  interface PluginState {
    'turn-meters': {
      /** Keyed by agent id, `main` for the main loop. */
      loops: Record<string, Loop>
      /** Keyed by agent id, `main` for the main loop. */
      plans: Record<string, Plan>
      agents: AgentCard[]
      usage: Usage
      now: number
    }
  }
}
