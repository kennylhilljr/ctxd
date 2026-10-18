import type { BuildTask, DodStep, TaskStatus } from '../types'

/** Pure helpers: everything here is tested without the engine. */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export const stripAnsi = (s: string): string => s.replace(ANSI, '')

export const isTestCommand = (cmd: string): boolean =>
  /\b(npm\s+(run\s+)?test|npx\s+vitest|vitest(\s+run)?|pnpm\s+test|yarn\s+test)\b/.test(cmd)

export const isTypecheckCommand = (cmd: string): boolean =>
  /\b(npm\s+run\s+typecheck|tsc\b|npx\s+tsc)\b/.test(cmd)

export const isCommitCommand = (cmd: string): boolean => /\bgit\s+(-C\s+\S+\s+)?commit\b/.test(cmd)

export const isPrCreateCommand = (cmd: string): boolean => /\bgh\s+pr\s+create\b/.test(cmd)

export const isGitCommand = (cmd: string): boolean => /\bgit\b/.test(cmd)

/** Vitest's summary line: "Tests  3 failed | 181 passed (184)". */
export function parseVitest(output: string): { passed: number; failed: number; total: number } | null {
  const text = stripAnsi(output)
  const m = /^\s*Tests\s+(.*?)\((\d+)\)\s*$/m.exec(text)
  if (!m) return null
  const counts = m[1] ?? ''
  const failed = Number(/(\d+)\s+failed/.exec(counts)?.[1] ?? 0)
  const passed = Number(/(\d+)\s+passed/.exec(counts)?.[1] ?? 0)
  return { passed, failed, total: Number(m[2]) }
}

/** Number of TypeScript errors in tsc output. */
export const countTscErrors = (output: string): number =>
  (stripAnsi(output).match(/error TS\d+:/g) ?? []).length

export function firstPrUrl(output: string): string | null {
  return /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(output)?.[0] ?? null
}

/** "anthropic-skills:simplify" and "/simplify args" both become "simplify". */
export function skillName(raw: string): string {
  const first = raw.trim().replace(/^\//, '').split(/\s+/)[0] ?? ''
  return (first.split(':').pop() ?? '').toLowerCase()
}

const DOD: readonly DodStep[] = ['run', 'simplify', 'verify', 'code-review']

/** The definition-of-done step a skill counts as, if any. */
export function dodStepOf(skill: string): DodStep | null {
  const name = skillName(skill)
  if (name === 'review' || name === 'code-review') return 'code-review'
  return (DOD as readonly string[]).includes(name) ? (name as DodStep) : null
}

export const DOD_STEPS = DOD

/** Apply a TaskCreate result, a TaskUpdate or a TodoWrite list to the task list. */
export function upsertTask(tasks: readonly BuildTask[], t: BuildTask): BuildTask[] {
  const i = tasks.findIndex(x => x.id === t.id)
  if (i < 0) return [...tasks, t]
  return tasks.map((x, j) => (j === i ? t : x))
}

export function updateTask(
  tasks: readonly BuildTask[],
  id: string,
  change: { subject?: string; status?: TaskStatus | 'deleted' },
): BuildTask[] {
  const { status, subject } = change
  if (status === 'deleted') return tasks.filter(t => t.id !== id)
  return tasks.map(t => (t.id === id ? { ...t, subject: subject ?? t.subject, status: status ?? t.status } : t))
}

export function fromTodos(todos: readonly { content: string; status: TaskStatus }[]): BuildTask[] {
  return todos.map((t, i) => ({ id: `todo-${i + 1}`, subject: t.content, status: t.status }))
}

/** "▰▰▰▱▱▱" for done of total, in `width` cells. */
export function bar(done: number, total: number, width = 10): string {
  if (total <= 0) return '▱'.repeat(width)
  const filled = Math.round((Math.min(done, total) / total) * width)
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** The one-line status: `ctxd M1 ▰▰▱▱▱ 2/5 · tests ✓184 · tsc ✓ · DoD 2/4 · m1/store`. */
export function statusLine(s: {
  milestone: string
  tasks: readonly BuildTask[]
  tests: { isOk: boolean; summary: string } | null
  typecheck: { isOk: boolean } | null
  dod: readonly DodStep[]
  branch: string | null
}): string {
  const done = s.tasks.filter(t => t.status === 'completed').length
  const parts = [
    `ctxd ${s.milestone} ${bar(done, s.tasks.length, 5)} ${done}/${s.tasks.length}`,
    s.tests ? `tests ${s.tests.isOk ? '✓' : '✗'} ${s.tests.summary}` : 'tests ·',
    s.typecheck ? `tsc ${s.typecheck.isOk ? '✓' : '✗'}` : 'tsc ·',
    `DoD ${s.dod.length}/${DOD.length}`,
  ]
  if (s.branch) parts.push(s.branch)
  return parts.join(' · ')
}
