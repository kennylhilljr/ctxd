# ctxd-build

A Claude Code mod that shows how a ctxd build is going while Claude Code works on it. It is active only inside the ctxd repository (its `package.json` name is `ctxd`) and never blocks or changes a tool call.

## What it shows

- **Status line**, always: `ctxd M1 ▰▰▰▱▱ 3/6 · tests ✓ 184 · tsc ✓ · DoD 2/4 · m1/store-write-path`.
- **`/ctxd-build` pane**:
  - milestone slices from Claude's task list (pending, in progress, done);
  - the last typecheck and test results, with their age;
  - the AGENTS.md definition of done since the last commit (`/run`, `/simplify`, `/verify`, `/code-review`), and whether `/run-skill-generator` has run;
  - branch, uncommitted files, last commit, pull requests;
  - recent activity.
- **Toasts** when tests go red or green again, when a PR is opened, and when a commit lands without `/simplify`, `/verify` or `/code-review`.

## Commands

| Command | Does |
|---|---|
| `/ctxd-build` | Open the pane |
| `/ctxd-build milestone M2` | Track a new milestone (clears the slice list) |
| `/ctxd-build reset` | Clear the tracked progress |

Progress is kept per repository folder across sessions.

## Install

From the root of your ctxd clone, for one session (reloads when the files change):

```bash
claude --plugin-dir tools/claude-mods/ctxd-build
```

To have it in every session, at the prompt of a terminal session:

```
/plugin install ctxd-build --marketplace kennylhilljr/ctxd
```

The repository is private, so this needs a GitHub credential for git on your Mac (for example `gh auth login` and then `gh auth setup-git`).

## Develop

```bash
claude plugin validate tools/claude-mods/ctxd-build
claude plugin test tools/claude-mods/ctxd-build
```
