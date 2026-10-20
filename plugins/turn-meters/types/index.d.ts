export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
export type TaskStatus = 'pending' | 'in_progress' | 'completed'
/** `title`: what the task is, as the panel shows it (the `activeForm` while one is given). */
export type Task = { id: string; status: TaskStatus; title?: string }
/** `baseDone`: tasks already completed when the plan started, left out of the pace. */
export type Plan = { tasks: Task[]; startedAt: number; lastDoneAt: number; baseDone: number }
/** The model and effort a loop's last request used. */
export type Loop = { model: string; effort: Effort | null }
export type AgentCard = { id: string; description: string; type: string; status: string }
/**
 * The session's readings from `$.session.usage()`. Percents are used, 0-100; times are clock
 * milliseconds; each is null until a reading exists.
 */
export type Usage = {
  fiveHour: number | null
  week: number | null
  context: number | null
  fiveHourResetsAt: number | null
  weekResetsAt: number | null
  contextTokens: number | null
  contextWindow: number | null
  startedAt: number | null
}
export type Tone = 'ok' | 'bad' | 'edit' | 'agent' | 'idle'
/** One row of the activity feed. `path` is kept for counting files touched and never drawn. */
export type Activity = { at: number; verb: string; target: string; tone: Tone; note: string | null; path?: string }
/** Summed from `turn.complete` usage; every loop's turns count. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Insights = {
  /** Main-loop turns that ended with an answer; `recent` holds their lengths, newest last. */
  turns: { count: number; totalMs: number; lastMs: number | null; recent: number[] }
  /** When the main loop's running turn began; null while idle. */
  turnStartedAt: number | null
  tokens: Tokens | null
  /** Output tokens of each main-loop turn, newest last. */
  outputs: number[]
  compactions: number
  activity: Activity[]
  /** Distinct files edited or written. */
  files: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'turn-meters': {
      /** Keyed by agent id, `main` for the main loop. */
      loops: Record<string, Loop>
      /** Keyed by agent id, `main` for the main loop. */
      plans: Record<string, Plan>
      agents: AgentCard[]
      usage: Usage
      insights: Insights
      now: number
    }
  }
}
