# Mirroring without relying on the agent to remember (Claude Code only)

The remote-mode rule asks the agent to copy every reply into `herdr-lark say`.
That works, and it is still the good path — the card carries the agent's own
markdown, tables and code blocks intact.

It is also structurally easy to skip. Copying the answer has to happen *before*
the agent finishes speaking, because finishing speaking is the end of the turn
and there is nothing after it to hang the copy on. A session deep in a task
writes the answer and stops, and the human on the phone gets silence.

Claude Code has a `Stop` hook, which fires at exactly the moment the rule has
no hook of its own. `herdr-lark mirror` reads the hook payload on stdin, pulls
the turn's text out of the transcript, and sends it — the real reply, not a
screenshot of the terminal.

## Install

Add to `~/.claude/settings.json` (keep any hooks already there — `Stop` takes a
list):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "herdr-lark mirror", "timeout": 20 }] }
    ]
  }
}
```

## What it will not do

- **Send twice.** If the agent already mirrored during the turn, the hook
  declines: the daemon compares when the turn started against when anything
  last went out to that group.
- **Fire for sessions that are not in remote mode.** `away` off, or no binding
  at all, and it exits without sending.
- **Speak for subagents.** A subagent's `Stop` carries an `agent_id` and its
  own transcript, and none of it was ever shown in the human's pane.
- **Fail loudly.** It exits 0 whatever happens. A hook that errors on every
  unrelated session in the machine is worse than no hook.

## Other agent CLIs

Nothing here is required. The hook is a Claude Code feature, and the skill does
not depend on it: without it the rule is still the path, and the daemon still
pushes a 🔇 card when a turn ends with nothing mirrored. Installing it changes
one file that belongs to Claude Code, not to herdr-lark.
