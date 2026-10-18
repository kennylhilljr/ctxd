import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: 'ctxd build',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('tracks tasks, tests and the definition of done, and draws them', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify({ name: 'ctxd' }) }))
  on('process.run', ($, e) => ({
    value: {
    exitCode: 0,
    stdout: e.argv.includes('rev-parse') ? 'm1/store-write-path\n' : e.argv.includes('status') ? ' M src/store/db.ts\n' : 'Store: write path\n',
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
    },
  }))
  let nextId = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: String(++nextId), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '      Tests  184 passed (184)\n', stderr: '', interrupted: false },
    text: '      Tests  184 passed (184)\n',
  }))
  on('tool.call', { tool: 'Skill' }, ($, e) => ({ result: { success: true, commandName: e.skill } }))

  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  const commands: string[] = []
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  await $.session.start({ cwd: '/work/ctxd', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'TaskCreate', subject: 'Store write path', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Access and personas', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Skill', skill: 'simplify' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'ctxd-build', surface, component: 'Pane', requestId: 'ctxd-build', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /ctxd M1 .* 1\/2 slices/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tests ✓ 184/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /m1\/store-write-path/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ \/simplify/ })).toBeDefined()
    await ui.unmount()
  }
  expect(commands).toEqual(['ctxd-build'])
  expect(statuses.at(-1)).toBe('ctxd M1 ▰▰▰▱▱ 1/2 · tests ✓ 184 · tsc · · DoD 1/4 · m1/store-write-path')
})

test('stays quiet outside the ctxd repository', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify({ name: 'something-else' }) }))
  await $.session.start({ cwd: '/work/other', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'ctxd-build', surface: 'terminal', component: 'Pane', requestId: 'ctxd-build', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /only in the ctxd repository/ })).toBeDefined()
  await ui.unmount()
})
