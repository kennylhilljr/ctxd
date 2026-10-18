import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, BuildSnapshot, BuildTask, DodStep } from '../types'
import {
  DOD_STEPS,
  ago,
  bar,
  countTscErrors,
  dodStepOf,
  firstPrUrl,
  fromTodos,
  isCommitCommand,
  isGitCommand,
  isPrCreateCommand,
  isTestCommand,
  isTypecheckCommand,
  parseVitest,
  skillName,
  statusLine,
  updateTask,
  upsertTask,
} from './parse'

/**
 * ctxd-build: shows the progress of a ctxd build while Claude Code works on it.
 * It watches the session's own tool calls (tasks, tests, typecheck, commits, PRs, skills)
 * and draws a status line, a /ctxd-build pane and a few toasts. It is active only in the
 * ctxd repository (package.json name "ctxd") and never blocks or changes a tool call.
 */

const PANE = 'ctxd-build'

const EMPTY: BuildSnapshot = {
  isCtxd: false,
  milestone: 'M1',
  tasks: [],
  tests: null,
  typecheck: null,
  dod: [],
  hasRunSkillGenerator: false,
  branch: null,
  uncommitted: 0,
  lastCommit: null,
  prs: [],
  activity: [],
}

const snap = atom({ plugin: 'ctxd-build', key: 'snap' } as const, EMPTY)

const DOD_LABEL: Record<DodStep, string> = {
  run: '/run',
  simplify: '/simplify',
  verify: '/verify',
  'code-review': '/code-review',
}

let storeKey = ''
let lastGitAt = 0

const log = (s: BuildSnapshot, a: Activity): BuildSnapshot => ({ ...s, activity: [...s.activity, a].slice(-40) })

/** Apply a change, persist it per repository, and refresh the status line. */
async function change($: EngineInterface, fn: (s: BuildSnapshot) => BuildSnapshot): Promise<BuildSnapshot> {
  await update($, snap, s => fn(s ?? EMPTY))
  const next = (await read($, snap)) ?? EMPTY
  if (storeKey) await $.store.set(storeKey, next)
  $.ui.status(next.isCtxd ? statusLine(next) : undefined)
  return next
}

async function markDod($: EngineInterface, step: DodStep): Promise<void> {
  const now = await $.clock.now()
  await change($, s => (s.dod.includes(step) ? s : log({ ...s, dod: [...s.dod, step] }, { at: now, kind: 'skill', text: DOD_LABEL[step] })))
}

async function gitRun($: EngineInterface, argv: string[]) {
  return $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)
}

async function refreshGit($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now()
  if (!force && now - lastGitAt < 2000) return
  lastGitAt = now
  const branch = await gitRun($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  const status = await gitRun($, ['git', 'status', '--porcelain'])
  const last = await gitRun($, ['git', 'log', '-1', '--format=%s'])
  await change($, s => ({
    ...s,
    branch: branch?.exitCode === 0 ? branch.stdout.trim() || null : s.branch,
    uncommitted: status?.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : s.uncommitted,
    lastCommit: last?.exitCode === 0 ? last.stdout.trim() || null : s.lastCommit,
  }))
}

async function isCtxdSession($: EngineInterface): Promise<boolean> {
  return ((await read($, snap)) ?? EMPTY).isCtxd
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    let isCtxd = false
    try {
      const pkg = JSON.parse(await $.fs.read(`${e.cwd}/package.json`)) as { name?: string }
      isCtxd = pkg.name === 'ctxd'
    } catch {
      isCtxd = false
    }
    if (!isCtxd) return ran

    storeKey = `snap:${e.cwd}`
    const saved = (await $.store.get(storeKey)) as BuildSnapshot | undefined
    await change($, () => ({ ...EMPTY, ...(saved ?? {}), isCtxd: true }))
    await refreshGit($, true)
    try {
      await $.command.register({
        name: 'ctxd-build',
        description: 'ctxd build progress: open the pane, or "reset", or "milestone M2"',
        argumentHint: '[reset | milestone <M#>]',
      })
    } catch {
      $.ui.toast('ctxd-build: could not register /ctxd-build; the status line still works')
    }
    return ran
  })

  on('command.run', { command: 'ctxd-build' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'reset') {
      await change($, s => ({ ...EMPTY, isCtxd: s.isCtxd, milestone: s.milestone }))
      await refreshGit($, true)
      return { text: 'ctxd-build: progress reset.' }
    }
    const m = /^milestone\s+(M\d+)$/i.exec(args)
    if (m) {
      const milestone = (m[1] as string).toUpperCase()
      await change($, s => ({ ...s, milestone, tasks: [] }))
      return { text: `ctxd-build: tracking ${milestone}.` }
    }
    await $.ui.open({ id: PANE, title: 'ctxd build' })
    return { text: 'ctxd-build: pane opened.' }
  })

  // Tasks: the task-list tools and the older TodoWrite.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
    if (task && ran.deny === undefined && !ran.isError) {
      const now = await $.clock.now()
      await change($, s => log({ ...s, tasks: upsertTask(s.tasks, { id: task.id, subject: task.subject, status: 'pending' }) }, { at: now, kind: 'task', text: `+ ${task.subject}` }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const now = await $.clock.now()
      await change($, s => {
        const tasks = updateTask(s.tasks, e.taskId, { subject: e.subject, status: e.status })
        const subject = tasks.find(t => t.id === e.taskId)?.subject ?? e.taskId
        return e.status === 'completed' || e.status === 'in_progress'
          ? log({ ...s, tasks }, { at: now, kind: 'task', text: `${e.status === 'completed' ? '✓' : '▶'} ${subject}`, isOk: true })
          : { ...s, tasks }
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await change($, s => ({ ...s, tasks: fromTodos(e.todos) }))
    return ran
  }).catch(($, e, next) => next(e))

  // Skills the model runs, and the ones typed as slash commands.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const name = skillName(e.skill)
      if (name === 'run-skill-generator') await change($, s => ({ ...s, hasRunSkillGenerator: true }))
      const step = dodStepOf(name)
      if (step) await markDod($, step)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    const command = e.command?.name
    if (command) {
      if (skillName(command) === 'run-skill-generator') await change($, s => ({ ...s, hasRunSkillGenerator: true }))
      const step = dodStepOf(command)
      if (step) await markDod($, step)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Shell commands: tests, typecheck, commits, PRs, and git state.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const cur = (await read($, snap)) ?? EMPTY
    if (!cur.isCtxd || ran.deny !== undefined) return ran

    const cmd = e.command
    const out = ran.text ?? ''
    const failed = ran.isError === true
    const now = await $.clock.now()

    if (isTestCommand(cmd)) {
      const v = parseVitest(out)
      if (v) {
        const isOk = v.failed === 0 && !failed
        const summary = isOk ? `${v.passed}` : `${v.failed} failed`
        const wasOk = cur.tests?.isOk
        await change($, s => log({ ...s, tests: { isOk, summary, at: now } }, { at: now, kind: 'tests', text: `tests ${v.passed}/${v.total} passed`, isOk }))
        if (wasOk === true && !isOk) $.ui.toast(`ctxd: tests went red (${v.failed} failed)`)
        if (wasOk === false && isOk) $.ui.toast(`ctxd: tests green again (${v.passed} passed)`)
      }
    }

    if (isTypecheckCommand(cmd)) {
      const errors = countTscErrors(out)
      const isOk = errors === 0 && !(failed && !isTestCommand(cmd))
      await change($, s => log({ ...s, typecheck: { isOk, summary: isOk ? 'clean' : `${errors} errors`, at: now } }, { at: now, kind: 'typecheck', text: isOk ? 'typecheck clean' : `typecheck: ${errors} errors`, isOk }))
    }

    if (isCommitCommand(cmd) && !failed) {
      const skipped = (['simplify', 'verify', 'code-review'] as DodStep[]).filter(step => !cur.dod.includes(step))
      if (skipped.length > 0) {
        $.ui.toast(`ctxd: committed without ${skipped.map(step => DOD_LABEL[step]).join(', ')} (AGENTS.md definition of done)`)
      }
      await change($, s => log({ ...s, dod: [] }, { at: now, kind: 'commit', text: 'commit', isOk: skipped.length === 0 }))
      await refreshGit($, true)
      await change($, s => ({ ...s, activity: s.activity.map((a, i) => (i === s.activity.length - 1 && a.kind === 'commit' ? { ...a, text: `commit: ${s.lastCommit ?? ''}` } : a)) }))
    }

    if (isPrCreateCommand(cmd) && !failed) {
      const url = firstPrUrl(out)
      if (url) {
        await change($, s => log({ ...s, prs: [...s.prs.filter(p => p !== url), url] }, { at: now, kind: 'pr', text: `PR ${url.split('/').pop()}`, isOk: true }))
        $.ui.toast(`ctxd: opened PR #${url.split('/').pop()}`)
      }
    }

    if (isGitCommand(cmd)) await refreshGit($, true)
    else await refreshGit($)
    return ran
  }).catch(($, e, next) => next(e))

  // File edits change the uncommitted count.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (await isCtxdSession($)) await refreshGit($)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (await isCtxdSession($)) await refreshGit($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = (await read($, snap)) ?? EMPTY
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)

    if (!s.isCtxd) {
      return <Text dimColor>ctxd-build is active only in the ctxd repository.</Text>
    }

    const done = s.tasks.filter((t: BuildTask) => t.status === 'completed').length
    const mark = (t: BuildTask) => (t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '·')
    const cut = (text: string, room: number) => (text.length > room ? `${text.slice(0, room - 1)}…` : text)
    const check = (label: string, c: BuildSnapshot['tests']) =>
      c ? (
        <Text color={c.isOk ? 'success' : 'error'}>
          {label} {c.isOk ? '✓' : '✗'} {c.summary} <Text dimColor>({ago(c.at, now)})</Text>
        </Text>
      ) : (
        <Text dimColor>{label} · not run yet</Text>
      )
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 16 - s.tasks.length)

    return (
      <Box flexDirection="column">
        <Text bold>
          ctxd {s.milestone} {bar(done, s.tasks.length, 12)} {done}/{s.tasks.length} slices
        </Text>
        <Text dimColor>
          {s.branch ?? 'no branch'} · {s.uncommitted} uncommitted
          {s.lastCommit ? ` · last: ${cut(s.lastCommit, width - 30)}` : ''}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {s.tasks.length === 0 && <Text dimColor>No slices yet. They appear as Claude creates its task list.</Text>}
          {s.tasks.map((t: BuildTask) => (
            <Text color={t.status === 'in_progress' ? 'suggestion' : undefined} dimColor={t.status === 'completed'}>
              {mark(t)} {cut(t.subject, width - 2)}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {check('typecheck', s.typecheck)}
          {check('tests', s.tests)}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Definition of done, since the last commit</Text>
          <Text>
            {DOD_STEPS.map((step: DodStep) => (
              <Text color={s.dod.includes(step) ? 'success' : 'subtle'}>
                {s.dod.includes(step) ? '✓' : '·'} {DOD_LABEL[step]}{'  '}
              </Text>
            ))}
          </Text>
          <Text dimColor>
            /run-skill-generator {s.hasRunSkillGenerator ? '✓ done' : '· not yet (run once ctxd server starts)'}
          </Text>
        </Box>

        {s.prs.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Pull requests</Text>
            {s.prs.slice(-5).map((url: string) => (
              <Text dimColor>{cut(url, width)}</Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Recent</Text>
          {s.activity.length === 0 && <Text dimColor>Nothing yet.</Text>}
          {s.activity.slice(-room).map((a: Activity) => (
            <Text color={a.isOk === false ? 'error' : undefined} dimColor={a.isOk === undefined}>
              {ago(a.at, now).padEnd(8)} {cut(a.text, width - 10)}
            </Text>
          ))}
        </Box>

        <Box marginTop={1}>
          <Button key="refresh" label="Refresh git" onPress={() => refreshGit($, true)} />
          <Text> </Text>
          <Button key="reset" label="Reset" onPress={() => change($, x => ({ ...EMPTY, isCtxd: x.isCtxd, milestone: x.milestone }))} />
        </Box>
      </Box>
    )
  })
}
