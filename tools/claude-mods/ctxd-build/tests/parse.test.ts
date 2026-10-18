import { describe, expect, test } from 'claude-code/testing'

import {
  bar,
  countTscErrors,
  dodStepOf,
  firstPrUrl,
  isCommitCommand,
  isTestCommand,
  isTypecheckCommand,
  parseVitest,
  skillName,
  statusLine,
  updateTask,
  upsertTask,
} from '../hooks/parse'

describe('ctxd-build parsing', () => {
  test('reads vitest summaries, colored or not', async () => {
    expect(parseVitest('\n Test Files  16 passed (16)\n      Tests  184 passed (184)\n')).toEqual({ passed: 184, failed: 0, total: 184 })
    expect(parseVitest('      Tests  \u001b[31m3 failed\u001b[39m | \u001b[32m181 passed\u001b[39m (184)')).toEqual({ passed: 181, failed: 3, total: 184 })
    expect(parseVitest('no summary here')).toBeNull()
  })

  test('counts tsc errors', async () => {
    expect(countTscErrors('src/a.ts(1,2): error TS2322: x\nsrc/b.ts(3,4): error TS2345: y')).toBe(2)
    expect(countTscErrors('> tsc -p tsconfig.json --noEmit')).toBe(0)
  })

  test('recognizes commands', async () => {
    expect(isTestCommand('npm run typecheck && npm test')).toBe(true)
    expect(isTypecheckCommand('npm run typecheck && npm test')).toBe(true)
    expect(isTestCommand('npx vitest run test/unit/paths.test.ts')).toBe(true)
    expect(isCommitCommand('git commit -q -m "x"')).toBe(true)
    expect(isCommitCommand('git -C /tmp/r commit -m x')).toBe(true)
    expect(isCommitCommand('git status')).toBe(false)
  })

  test('maps skills to definition-of-done steps', async () => {
    expect(skillName('anthropic-skills:simplify')).toBe('simplify')
    expect(skillName('/code-review focus on sync')).toBe('code-review')
    expect(dodStepOf('verify')).toBe('verify')
    expect(dodStepOf('review')).toBe('code-review')
    expect(dodStepOf('loop')).toBeNull()
  })

  test('finds PR urls', async () => {
    expect(firstPrUrl('Creating pull request\nhttps://github.com/example/sample-app/pull/12\n')).toBe('https://github.com/example/sample-app/pull/12')
    expect(firstPrUrl('nothing')).toBeNull()
  })

  test('tracks tasks', async () => {
    let tasks = upsertTask([], { id: '1', subject: 'Store write path', status: 'pending' })
    tasks = upsertTask(tasks, { id: '2', subject: 'Access', status: 'pending' })
    tasks = updateTask(tasks, '1', { status: 'completed' })
    expect(tasks.map(t => t.status)).toEqual(['completed', 'pending'])
    expect(updateTask(tasks, '2', { status: 'deleted' })).toHaveLength(1)
  })

  test('draws the status line', async () => {
    expect(bar(2, 4, 4)).toBe('▰▰▱▱')
    expect(bar(0, 0, 3)).toBe('▱▱▱')
    expect(
      statusLine({
        milestone: 'M1',
        tasks: [
          { id: '1', subject: 'a', status: 'completed' },
          { id: '2', subject: 'b', status: 'in_progress' },
        ],
        tests: { isOk: true, summary: '184' },
        typecheck: { isOk: true },
        dod: ['simplify'],
        branch: 'm1/store',
      }),
    ).toBe('ctxd M1 ▰▰▰▱▱ 1/2 · tests ✓ 184 · tsc ✓ · DoD 1/4 · m1/store')
  })
})
