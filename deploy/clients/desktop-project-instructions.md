# Claude Desktop project instructions template

Paste into a Claude Desktop project's instructions and replace `<scope>` (PRD section 6.5, read R8 and write W8):

```
This project uses ctxd scope "<scope>". At the start of each chat, call context_brief for that
scope. When we settle a decision, record it with context_write (kind decision, with the reason).
When we reach a conclusion or wrap up, offer to save a handoff with context_handoff.
```
