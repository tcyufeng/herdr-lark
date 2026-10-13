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

## Approving tool calls from the phone

When Claude Code needs permission to run a tool, the agent is already stopped
waiting on the harness — it cannot ask through `herdr-lark ask`. A
`PermissionRequest` hook can: in remote mode it puts the request on your phone
as a card with **允许 / 拒绝** and the call itself shown verbatim (the command,
the file path, the URL), then answers the prompt with what you tap.

- Typing in the group instead of tapping denies the call and passes your words
  to the agent as the reason — "别删，改成移到 /tmp" is an instruction, not
  just a no.
- The prompt stays on screen in the terminal too. Answer it there and the card
  closes itself within about ten seconds, marked as handled in the terminal.
- Outside remote mode it returns at once with no decision, so the terminal
  prompt appears exactly as it would without the hook.
- Deny and ask rules in your settings still apply: a tap cannot allow what a
  deny rule forbids.

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "herdr-lark permit", "timeout": 3600 }] }
    ]
  }
}
```

The timeout is long on purpose: the card waits up to 55 minutes for you. A
shorter timeout ends the wait early and leaves the decision to the terminal.

## Keeping questions off the terminal picker

Claude Code has a built-in multiple-choice picker (`AskUserQuestion`). The
remote-mode rule tells the agent to ask through `herdr-lark ask` instead, and
agents do not always listen. When one reaches for the picker while you are on
your phone, the daemon sees only that the pane is blocked. It copies the screen
into a 🔔 card so you can at least read the question, but you cannot answer it
from there: the picker takes keystrokes, and a reply in the group arrives as text.

A `PreToolUse` hook stops the picker before it opens. In remote mode it refuses
the tool and tells the agent to ask through `herdr-lark ask`, which puts real
buttons on your phone. Outside remote mode it does nothing, so the picker works
as usual when you are at the keyboard.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [{ "type": "command", "command": "herdr-lark guard-ask", "timeout": 10 }]
      }
    ]
  }
}
```

Like the Stop hook, it takes effect in sessions started after it is added.

## Other agent CLIs

Nothing here is required. The hook is a Claude Code feature, and the skill does
not depend on it: without it the rule is still the path, and the daemon still
pushes a 🔇 card when a turn ends with nothing mirrored. Installing it changes
one file that belongs to Claude Code, not to herdr-lark.
