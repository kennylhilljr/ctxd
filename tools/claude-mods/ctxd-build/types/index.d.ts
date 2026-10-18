export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type BuildTask = { id: string; subject: string; status: TaskStatus }

export type CheckRun = {
  isOk: boolean
  /** e.g. "184 passed" or "3 errors" */
  summary: string
  at: number
}

/** Definition-of-done steps tracked since the last commit (AGENTS.md). */
export type DodStep = 'run' | 'simplify' | 'verify' | 'code-review'

export type Activity = {
  at: number
  kind: 'tests' | 'typecheck' | 'commit' | 'skill' | 'pr' | 'task' | 'note'
  text: string
  isOk?: boolean
}

export type BuildSnapshot = {
  isCtxd: boolean
  milestone: string
  tasks: BuildTask[]
  tests: CheckRun | null
  typecheck: CheckRun | null
  /** Steps done since the last commit. */
  dod: DodStep[]
  hasRunSkillGenerator: boolean
  branch: string | null
  uncommitted: number
  lastCommit: string | null
  prs: string[]
  activity: Activity[]
}

declare module 'claude-code' {
  interface PluginState {
    'ctxd-build': { snap: BuildSnapshot }
  }
}
