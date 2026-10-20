# Spec v10 draft

Working notes collected while the completion kickoff ([docs/build/completion-kickoff-v1.md](../build/completion-kickoff-v1.md)) runs. M7 slice 8 folds this into the numbered Spec v10; until then each workstream appends its own section here instead of editing Spec v9 directly.

## W5: correctness gaps

### W5.1 Approval timestamps

Closes a gap Spec v9's own schema left open: `entries.approved_by` and `entries.approved_hlc` are now set whenever an entry is actually approved, not left NULL forever.

- Set on the review path: `ctxd review --approve` (the `resolve` status event) records the approving human client and the resolve event's HLC.
- Set at creation for an auto-accept review rule match (10.4): the creating client and the create event's HLC, since the rule itself is the approval.
- Left NULL for a write that was never under review at all: the human client writing directly, or a kind whose unreviewed default status is already `active`. There was no approval step to record.
- The weekly digest's "decisions made" section (11.5) now reads `approved_hlc`, falling back to `created_hlc` for a decision that was active from creation and so never had a separate approval moment.

### W5.2 Crash sweep: mechanical release and journal entry

Closes the gap 9.10 already described but the implementation had not reached: a session that crashes without ever calling SessionEnd leaves no ticket behind, so the crash sweep had no `cwd` to check "is the working tree clean" against.

- `sessions.cwd` (schema v20) is recorded once, at SessionStart, and kept for that session's life; a later event's reported `cwd` never overwrites it.
- The crash sweep now runs the same mechanical journal entry and claim release a real SessionEnd runs (`performSessionEnd`), for a finalized session that has a recorded `cwd` and scope, gated behind `claims.mechanical_release` (the same flag that already gates live SessionEnd's release).
- A session with no recorded `cwd` (a row from before this slice) or no scope is only finalized, exactly as before this slice.

### W5.3 List mode ordering

Fixes a bug against Spec v9's own 11.2: "With `query: '*'` and a time filter, results are listed newest first instead of by relevance." The implementation listed by time at the SQL level, but then re-sorted the results by a score that, in list mode, was the entry's importance, whatever the `importance` flag said.

- List mode (`query: "*"`) now lists strictly by time in both `importance` flag states: every list-mode row gets `_score = 0`, so the final stable sort leaves the SQL's own time-descending order alone.
- The scope fan-out multipliers (0.9/0.8/1.0, 11.2) and the flagged-entry penalty are relevance adjustments; they apply only to scored (non-`"*"`) search, never to list mode.
