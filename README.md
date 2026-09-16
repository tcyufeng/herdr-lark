# herdr-lark

[![skills.sh](https://skills.sh/b/tcyufeng/herdr-lark)](https://skills.sh/tcyufeng/herdr-lark)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**English** | [简体中文](./README.zh-CN.md)

Reach the agent session **already running** in your [herdr](https://herdr.dev) pane — from Feishu/Lark on your phone.

When it hits something only you can decide, it pushes a card with buttons. You tap one or type a sentence, and the answer lands back in that same session, with all of its context — not a fresh one. Images and voice notes you send go the other way, straight into the pane.

No server and no public URL: the daemon dials out over Feishu's WebSocket. The app is created by scanning a QR code — **no workspace-admin approval needed**, a personal account is enough.

```bash
npx skills add tcyufeng/herdr-lark
```

## Quick start

**1. Put it on your PATH.** The shipped `dist/cli.mjs` is a single self-contained file — no `npm install`, no build step:

```bash
ln -sf "$PWD/.agents/skills/herdr-lark/dist/cli.mjs" ~/.local/bin/herdr-lark
```

**2. Scan a QR code to create the app.**

```bash
herdr-lark setup
```

A QR code is drawn in the terminal — scan it with **Feishu on your phone** (or open the link printed underneath if the terminal renders it badly). The confirmation page lists the permissions being requested; approve, and the app is created on the spot. Credentials go straight into your OS keychain.

**3. Turn it on — the group is created for you.**

```bash
cd <your project> && herdr-lark away on
```

One command gets everything ready: start the daemon → **create a Feishu group for this project** (or reuse the existing one) → flip the switch. Open Feishu and the group is there; every question from this project lands in it.

**One session, one group** — not one directory. Several sessions routinely run in the same repo on
different tasks; keying on the directory would give them one group and one question slot between them,
and deliver your reply to whichever pane ran a command last — the wrong agent. Nor one pane: closing a
space, moving the window or resuming elsewhere renumbers the pane while the session id holds.

A group is named `🤖 project · task`, taking the task from the terminal title the agent sets itself. It
is renamed when the window moves on to something else (after a `/clear`, say), but a name you set by
hand is left alone.

## Make "I'm heading out" work

Drop the rule into your agent's always-loaded rules directory and you never have to remember a command:

```bash
cp .agents/skills/herdr-lark/examples/remote-mode-rule.md ~/.claude/rules/
```

| You say | The agent runs |
|---|---|
| "I'm heading out", "reach me on my phone" | `herdr-lark away on` |
| "I'm back" | `herdr-lark away off --all` |

While remote mode is on, every reply it writes in the terminal is mirrored **verbatim** into the group, decisions arrive as cards with buttons, and you get a push when the agent is stuck on a prompt only you can answer.

Each mirrored card says **whose turn it is**: ⏳ while the session is still working, rewritten in place to
✅ once the turn ends, ⚠️ when it is parked on a prompt only you can answer. Only the newest card carries
a state — the ones above it become signposts — so the bottom of the thread is the only thing worth reading.

Prefer slash commands? Copy them all in — they share a prefix, so typing `/away` lists the set:

```bash
cp .agents/skills/herdr-lark/examples/commands/*.md ~/.claude/commands/
```

`/away-on` · `/away-on-all` · `/away-off` · `/away-off-all` · `/away-status`

Turning it on covers the session you are in; `--all` (and `/away-off-all`) covers every bound session,
because someone who says "I'm back" is back as a person, not back in one directory.

## When the agent forgets to mirror

Mirroring asks the agent to copy its answer into a command *before* it stops speaking, and stopping is the
end of the turn — there is nothing after it to hang the copy on. Busy sessions write the answer and stop,
and the phone gets silence.

Two backstops, neither of which touches the conversation in the terminal:

- **Every agent CLI**: a turn that ends with nothing mirrored pushes a 🔇 card carrying the terminal's own
  output. Readable, but it is a screenshot of a terminal — tables wrap, long answers are cut.
- **Claude Code**: a `Stop` hook sends the turn's real text from the transcript, with markdown intact. It
  declines when the agent already mirrored most of the turn itself. Optional, one entry in your
  `settings.json` — see [examples/hooks](./examples/hooks/README.md). Nothing in the skill depends on it.

## No notification on your phone?

Feishu suppresses mobile push while you are online on desktop. On your phone: Feishu → Settings → Notifications, and turn that off.

## More

- **Full guide**: [English](./docs/guide.md) · [中文](./docs/guide.zh-CN.md) — credential resolution order, environment variables, file locations, known limits
- **What the agent reads**: [SKILL.md](./SKILL.md) — field contract, exit codes, how to write a question worth answering
- **The rule**: [examples/remote-mode-rule.md](./examples/remote-mode-rule.md)

Only exercised end to end on macOS. The Linux and Windows credential stores are written per platform but untested — pull requests welcome.

MIT
