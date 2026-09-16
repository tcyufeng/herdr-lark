import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:net';
import { createLarkChannel, type CardActionEvent, type LarkChannel, type NormalizedMessage } from '@larksuite/channel';
import { BindingStore, type Binding } from './bindings.js';
import { askCard, linkCard, missedMirrorCard, notifyCard, receiptCard, sayCard, statusCard, type TurnState } from './cards.js';
import { resolveCreds } from './creds.js';
import { agentList, findPaneForProject, findPaneForSession, paneStarted, paneTail, promptPane, sendKeys } from './herdr.js';
import { serve, type Caller, type Request, type Response } from './ipc.js';
import { ensureHomeDir, homeDir, logPath, pidPath, sockPath } from './paths.js';
import { validateAsk, validateNotify, ValidationError, type AskPayload } from './validate.js';

const INJECT_PREFIX = '[herdr-lark remote] ';
const POLL_MS = 5_000;
const STATUS_COOLDOWN_MS = 60_000;
/** How long the subscription may be down before the groups are told. */
const LINK_ALERT_AFTER_MS = 90_000;
/**
 * How long a non-connected subscription is tolerated before forcing a fresh
 * connection. The SDK reconnects on a socket it *notices* has dropped, but a
 * half-open one — the laptop slept, the network moved, a NAT dropped the
 * mapping — still looks alive to it, so it never fires and the link stays
 * silent indefinitely. Observed once: eight hours across a night, with no
 * `reconnecting` event at all.
 */
const LINK_FORCE_RECONNECT_AFTER_MS = 60_000;
/** A reconnect loop that has been grinding this long is stuck, not working. */
const LINK_STUCK_AFTER_MS = 300_000;
/** How long to wait for the pane's agent to actually start on an injected message. */
const INJECT_SUBMIT_WAIT_MS = 8_000;
/**
 * How many consecutive polls a session must spend not working before its turn
 * counts as over. herdr reports `idle` between tool calls inside a single
 * turn, so one reading proves nothing — this is the same flicker that made an
 * earlier "you forgot to mirror" nudge fire on live conversations.
 */
const TURN_SETTLE_POLLS = 3;

/** The log records ids and state transitions only — never message bodies. */
function log(event: string, detail: Record<string, unknown> = {}): void {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
  try {
    appendFileSync(logPath(), line, { mode: 0o600 });
  } catch {
    // logging must never take the daemon down
  }
}


/** Feishu caps images at 10 MB and files at 30 MB; refuse before uploading. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * A file may only be sent when it resolves (after realpath, so symlinks
 * cannot escape) inside the project that asked, the daemon's own media
 * directory, or a temp dir. Everything else is refused: `send-file` must not
 * become a way to read arbitrary paths out of the machine.
 */
function resolveSendable(
  path: string,
  root: string,
): { real: string; bytes: Buffer } | { error: string } {
  if (!existsSync(path)) return { error: `文件不存在：${path}` };
  let real: string;
  try {
    real = realpathSync(path);
  } catch (err) {
    return { error: `路径解析失败：${String(err)}` };
  }
  const allowed = [root, join(homeDir(), 'media'), tmpdir()]
    .map((d) => {
      try {
        return realpathSync(d);
      } catch {
        return d;
      }
    });
  if (!allowed.some((d) => within(real, d)))
    return {
      error:
        `拒绝发送 ${real}\n只能发这些目录下的文件：\n  本项目 ${root}\n  ${join(homeDir(), 'media')}\n  ${tmpdir()}\n` +
        '（这是防止 send-file 被用来把机器上任意文件读走）',
    };
  const st = statSync(real);
  if (!st.isFile()) return { error: `不是普通文件：${real}` };
  const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(real);
  const cap = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (st.size > cap)
    return { error: `文件太大：${(st.size / 1024 / 1024).toFixed(1)} MB，上限 ${cap / 1024 / 1024} MB` };
  return { real, bytes: readFileSync(real) };
}

interface Pending {
  reqId: string;
  key: string;
  root: string;
  chatId: string;
  messageId: string;
  label: string;
  payload: AskPayload;
  settle: (r: Response) => void;
  timer: NodeJS.Timeout;
  done: boolean;
}

export async function runDaemon(): Promise<void> {
  const creds = resolveCreds();
  if (!creds) {
    process.stderr.write('herdr-lark: 找不到飞书应用凭据。先跑一次：herdr-lark setup（或设好 HERDR_LARK_APP_ID / HERDR_LARK_APP_SECRET）\n');
    process.exit(4);
  }
  ensureHomeDir();
  if (existsSync(sockPath())) {
    // Something may still be answering there; the IPC layer replaces a dead
    // socket file, but a live daemon must not be duplicated.
    const { request } = await import('./ipc.js');
    const probe = await request({ type: 'ping' }, { timeoutMs: 2000 });
    if (probe.ok) {
      process.stderr.write('herdr-lark: daemon 已经在跑了\n');
      process.exit(3);
    }
  }

  const bindings = new BindingStore();
  {
    const dropped = bindings.pruneDuplicateChats();
    if (dropped) log('bindings.pruned', { dropped });
  }
  const pendings = new Map<string, Pending>();
  const lastStatus = new Map<string, string>();
  /** Consecutive polls in which a session has not been working. */
  const settledPolls = new Map<string, number>();
  /** When a phone message was last delivered into each session's pane. */
  const lastInject = new Map<string, number>();
  /** The inject a missed-mirror card has already been sent for. */
  const missAlerted = new Map<string, number>();
  const lastStatusPush = new Map<string, number>();
  const workingSince = new Map<string, number>();
  /** When this session last sent anything to its group. */
  const lastOutbound = new Map<string, number>();

  /** Called whenever a session communicates, by any route. Kept for the log
   * and for diagnosing a group that has gone quiet; nothing acts on it
   * automatically — an automatic reminder would have to interrupt the very
   * conversation the human is reading. */
  const markOutbound = (key: string): void => {
    lastOutbound.set(key, Date.now());
  };
  /** Send one reply card, superseding whatever card held the state before it. */
  const sendSay = async (b: Binding, text: string, title?: string): Promise<Response> => {
    try {
      const prev = b.lastSay;
      const sent = await channel.send(b.chatId, { card: sayCard(text, b.label, title) });
      settledPolls.set(b.key, 0);
      bindings.touch(b.key, {
        lastSay: { messageId: sent.messageId, body: text, title, state: 'running' },
      });
      // Only the newest card may claim a state. A background task can wake the
      // session a minute after its turn ended, so a card that legitimately
      // said "over to you" is not wrong — it is just no longer the one to
      // read, and leaving it green contradicts that.
      if (prev) {
        try {
          await channel.updateCard(prev.messageId, sayCard(prev.body, b.label, prev.title, 'superseded'));
        } catch (err) {
          log('say.supersede-failed', { key: b.key, err: String(err).slice(0, 160) });
        }
      }
      markOutbound(b.key);
      log('say.sent', { key: b.key, chars: text.length });
      return { ok: true, kind: 'ack' };
    } catch (err) {
      return { ok: false, code: 3, message: `发送失败：${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const startedAt = new Date().toISOString();

  const channel: LarkChannel = createLarkChannel({
    appId: creds.appId,
    appSecret: creds.appSecret,
    policy: {
      // Only bound groups are listened to, and inside them no @ is needed —
      // the group IS the project, so every message in it is for this agent.
      groupAllowlist: bindings.chatIds(),
      requireMention: false,
      dmMode: creds.ownerOpenId ? 'allowlist' : 'disabled',
      dmAllowlist: creds.ownerOpenId ? [creds.ownerOpenId] : [],
    },
  });

  const refreshPolicy = (): void => {
    channel.updatePolicy({ groupAllowlist: bindings.chatIds() });
  };

  /** One question at a time per *session*, not per directory. */
  const pendingFor = (key: string): Pending | undefined => {
    for (const p of pendings.values()) if (p.key === key && !p.done) return p;
    return undefined;
  };

  /**
   * Close a question: rewrite the card, hand the reply back to the client.
   *
   * `viaCallback` means the tap's own callback response already carries the
   * answered card, so the buttons are gone the moment Feishu renders the
   * reply — no window in which a second tap is possible. The REST update is
   * still issued as a fallback: if the callback response were ever dropped,
   * a card with live buttons on an already-closed question would be worse
   * than a redundant update.
   */
  const answer = async (
    p: Pending,
    reply: string,
    via: 'button' | 'text',
  ): Promise<void> => {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    pendings.delete(p.reqId);
    p.settle({ ok: true, kind: 'ask', reply, via });
    log('ask.answered', { reqId: p.reqId, via, root: p.root });
    try {
      await channel.updateCard(
        p.messageId,
        askCard({ payload: p.payload, projectLabel: p.label, reqId: p.reqId, state: 'answered', reply }),
      );
    } catch (err) {
      log('ask.update-failed', { reqId: p.reqId, err: String(err) });
    }
  };

  const closeWithout = async (p: Pending, state: 'timedout' | 'cancelled', res: Response): Promise<void> => {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    pendings.delete(p.reqId);
    p.settle(res);
    log(`ask.${state}`, { reqId: p.reqId, root: p.root });
    try {
      await channel.updateCard(
        p.messageId,
        askCard({ payload: p.payload, projectLabel: p.label, reqId: p.reqId, state }),
      );
    } catch (err) {
      log('ask.update-failed', { reqId: p.reqId, err: String(err) });
    }
  };

  /** The group's name, so the chat list says which task it belongs to. */
  const groupName = (project: string, task: string | null): string =>
    task ? `🤖 ${project} · ${task}` : `🤖 ${project}`;

  /**
   * Rewrite the newest `say` card's footer once the turn behind it is over.
   * Without this the human on the phone cannot tell "the agent is still
   * working, more is coming" from "it is waiting for me" — every card looks
   * identical, and several cards arriving from one turn make it worse.
   */
  const syncSayFooter = async (b: Binding, status: string | undefined, settled: number): Promise<void> => {
    const last = b.lastSay;
    if (!last || last.state === 'done') return;
    if (!settled) return;
    // Blocked is not a flicker: the agent is parked on a prompt and will stay
    // there until a human acts, so say so without waiting out the debounce.
    if (status !== 'blocked' && settled < TURN_SETTLE_POLLS) return;
    const state: TurnState = status === 'blocked' ? 'blocked' : 'done';
    if (state === last.state) return;
    try {
      await channel.updateCard(last.messageId, sayCard(last.body, b.label, last.title, state));
      log('say.footer', { key: b.key, state });
    } catch (err) {
      log('say.footer-failed', { key: b.key, err: String(err).slice(0, 160) });
    }
    // Record either way: retrying a failing patch every 5 s is noise.
    bindings.touch(b.key, { lastSay: { ...last, state } });
  };

  /**
   * A turn that ended without a single `say` means the human on the phone got
   * nothing while the terminal filled up with the answer. Nothing in the
   * program can make the agent follow the mirroring rule — but the human can
   * be told, and unlike the reminder this replaces, telling them happens on
   * their phone instead of inside the conversation they are having.
   */
  const alertMissedMirror = async (b: Binding, paneId: string | null, settled: number): Promise<void> => {
    if (!b.away || !paneId || settled < TURN_SETTLE_POLLS) return;
    const injected = lastInject.get(b.key);
    if (!injected) return;
    // Something did go out after the message arrived: the rule was followed.
    if ((lastOutbound.get(b.key) ?? 0) > injected) return;
    if (missAlerted.get(b.key) === injected) return;
    missAlerted.set(b.key, injected);
    const tail = await paneTail(paneId);
    try {
      await channel.send(b.chatId, { card: missedMirrorCard(b.label, b.task, tail) });
      markOutbound(b.key);
      log('mirror.missed', { key: b.key, hadTail: !!tail });
    } catch (err) {
      log('mirror.missed-failed', { key: b.key, err: String(err).slice(0, 160) });
    }
  };

  /**
   * Keep the group name in step with what the session is actually doing. After
   * a `/clear` the agent picks up a different task and the old name becomes a
   * lie — and the chat list is the only place the human tells several groups
   * apart, so a stale name there is worse than no name.
   */
  const renameChat = async (b: Binding, task: string): Promise<void> => {
    const name = groupName(b.label, task);
    try {
      await (channel.rawClient as unknown as {
        im: { chat: { update(req: unknown): Promise<unknown> } };
      }).im.chat.update({ path: { chat_id: b.chatId }, data: { name } });
      bindings.touch(b.key, { task, namedAs: name });
      log('chat.renamed', { key: b.key, task });
    } catch (err) {
      log('chat.rename-failed', { key: b.key, err: String(err).slice(0, 160) });
      // Record it anyway: retrying every 5 s on a permission error is noise.
      bindings.touch(b.key, { task, namedAs: name });
    }
  };

  const receipt = async (b: Binding, why: string): Promise<void> => {
    try {
      await channel.send(b.chatId, { card: receiptCard(b.label, why) });
    } catch (err) {
      log('receipt.failed', { key: b.key, err: String(err) });
    }
  };

  const explainPromptFailure = (code?: string, message?: string): string => {
    switch (code) {
      case 'agent_blocked':
        return '终端里的 agent 正卡在一个需要你本人确认的提示上，收不了新输入。回电脑前处理一下。';
      case 'agent_not_found':
      case 'pane_not_found':
        return '记录的 herdr 窗格已经不在了。到项目里跑一次 herdr-lark bind 或任意 herdr-lark 命令，重新记录窗格。';
      case 'agent_prompt_stalled':
        return '消息送到了终端的输入框，但那边没把它发出去——回电脑上按一下回车就行。';
      case 'spawn_failed':
        return `herdr 命令没跑起来：${message ?? '未知原因'}`;
      default:
        return `herdr 拒绝了这次注入：${code ?? '未知'} ${message ?? ''}`.trim();
    }
  };

  /** Deliver a free-standing phone message into the project's pane. */
  const inject = async (b: Binding, text: string): Promise<void> => {
    const agents = await agentList();
    // Look the pane up from the session every time. A stored pane id goes
    // stale the moment the window is closed, moved, or the session is resumed
    // somewhere else — and delivering to a pane that no longer exists is how
    // a message from the phone silently goes nowhere.
    let paneId = b.sessionId ? findPaneForSession(agents, b.sessionId) : null;
    if (paneId && paneId !== b.paneId) bindings.touch(b.key, { paneId });
    if (!paneId) paneId = b.paneId && agents.some((a) => a.pane_id === b.paneId) ? b.paneId : null;
    if (!paneId) paneId = findPaneForProject(agents, b.root);
    if (!paneId) {
      await receipt(b, '这个项目还没有记录到 herdr 窗格，消息没处可送。');
      return;
    }
    let outcome = await promptPane(paneId, `${INJECT_PREFIX}${text}`, { waitMs: INJECT_SUBMIT_WAIT_MS });
    // The text can land in the input box without ever being sent: Claude Code
    // rewrites a pasted image path into an attachment before it will accept a
    // submit, and the Enter herdr sends in the same burst is swallowed while
    // it does that. herdr still reports success — it typed the thing — so
    // without the `--wait` above the message would sit there looking
    // delivered. Press Enter ourselves and check the turn really started.
    if (!outcome.ok && outcome.code === 'agent_prompt_stalled') {
      // Pressing Enter on someone's behalf is only safe when nobody can be
      // typing into that pane. A multiplexer routes the human's keystrokes to
      // the focused pane and nowhere else, so an unfocused pane cannot be
      // holding a half-written sentence — but a focused one can, and sending
      // Enter there would submit whatever they were in the middle of. The
      // exception is away mode: the human has said they are not at this
      // keyboard, which is the whole premise of the mode.
      const focused = (await agentList()).find((a) => a.pane_id === paneId)?.focused ?? false;
      if (focused && !b.away) {
        log('inject.stalled', { key: b.key, paneId, rescued: false, why: 'pane focused, human may be typing' });
      } else {
        const keyed = await sendKeys(paneId, 'enter');
        const started = keyed.ok && (await paneStarted(paneId, INJECT_SUBMIT_WAIT_MS));
        log('inject.stalled', { key: b.key, paneId, rescued: started });
        if (started) outcome = { ok: true };
      }
    }
    if (outcome.ok) lastInject.set(b.key, Date.now());
    log('inject', { key: b.key, paneId, ok: outcome.ok, code: outcome.code });
    if (!outcome.ok) await receipt(b, explainPromptFailure(outcome.code, outcome.message));
  };

  /**
   * Transcribe one voice message. Feishu's file_recognize takes base64 opus
   * and caps at 60 s. Needs the `speech_to_text:speech` scope — without it
   * the call fails and the caller falls back to saying so plainly, which is
   * far better than handing the agent an `<audio .../>` placeholder it cannot
   * read and will silently misinterpret as text.
   */
  const transcribe = async (audioPath: string): Promise<string | null> => {
    try {
      const b64 = readFileSync(audioPath).toString('base64');
      const res = await (channel.rawClient as unknown as {
        speech_to_text: {
          speech: {
            fileRecognize(req: unknown): Promise<{ data?: { recognition_text?: string } }>;
          };
        };
      }).speech_to_text.speech.fileRecognize({
        data: {
          speech: { speech: b64 },
          config: { file_id: createHash('sha1').update(audioPath).digest('hex').slice(0, 16), format: 'opus', engine_type: '16k_auto' },
        },
      });
      const text = res.data?.recognition_text?.trim();
      return text || null;
    } catch (err) {
      log('transcribe.failed', { err: String(err).slice(0, 200) });
      return null;
    }
  };

  /** Save an inbound attachment next to the daemon's state, never in the repo. */
  const saveResources = async (msg: NormalizedMessage): Promise<{ files: string[]; spoken: string[]; unheard: number }> => {
    const out = { files: [] as string[], spoken: [] as string[], unheard: 0 };
    if (!msg.resources.length) return out;
    const dir = join(homeDir(), 'media', createHash('sha1').update(msg.chatId).digest('hex').slice(0, 12));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const res of msg.resources) {
      // Only images have their own download type; everything else (files,
      // voice notes, video) comes down the `file` path.
      const kind = res.type === 'image' ? 'image' : 'file';
      const ext = res.type === 'image' ? 'png' : res.type === 'audio' ? 'opus' : 'bin';
      const name = res.fileName ?? `${res.type}-${Date.now()}.${ext}`;
      const dest = join(dir, `${Date.now()}-${name}`);
      try {
        await channel.downloadResourceToFile(msg.messageId, res.fileKey, kind, dest);
      } catch (err) {
        log('download.failed', { messageId: msg.messageId, type: res.type, err: String(err).slice(0, 200) });
        continue;
      }
      if (res.type === 'audio') {
        const text = await transcribe(dest);
        if (text) out.spoken.push(text);
        else out.unheard += 1;
        continue;
      }
      out.files.push(dest);
    }
    return out;
  };

  /** Session ids herdr can see right now. */
  const liveSessions = async (): Promise<Set<string>> =>
    new Set((await agentList()).map((a) => a.agent_session?.value).filter((v): v is string => !!v));

  channel.on('message', async (msg: NormalizedMessage) => {
    if (msg.senderIsBot) return;
    const b = bindings.byChat(msg.chatId, await liveSessions());
    // Log arrival before anything can drop it. Without this there is no way to
    // tell "the message never reached us" from "it reached us and we dropped
    // it", and the human just sees silence either way.
    log('message.in', { chatId: msg.chatId, bound: !!b, resources: msg.resources.length, chars: msg.content.length });
    if (!b) return;
    const got = await saveResources(msg);
    // A voice message arrives as an `<audio .../>` placeholder in `content`.
    // Strip it: either the transcript replaces it, or the human is told
    // plainly that it could not be heard.
    let text = msg.content.replace(/<audio\b[^>]*\/?>/gi, '').trim();
    if (got.spoken.length) {
      const said = got.spoken.join('\n');
      text = text ? `${text}\n（语音转文字）${said}` : said;
    }
    if (got.unheard) {
      const why =
        '（收到 ' + got.unheard + ' 条语音，但转文字失败——多半是应用还没开 speech_to_text:speech 权限。' +
        '请告诉用户：跑一次 herdr-lark setup --update 重新扫码补上这个权限，或者这次先打字。）';
      text = text ? `${text}\n${why}` : why;
    }
    if (got.files.length) {
      const list = got.files.map((f) => `  ${f}`).join('\n');
      text = text ? `${text}\n（附件已存到本机）\n${list}` : `（我发了附件，已存到本机）\n${list}`;
    }
    if (!text) return;
    const p = pendingFor(b.root);
    if (p) {
      await answer(p, text, 'text');
      return;
    }
    await inject(b, text);
  });

  channel.on('cardAction', async (evt: CardActionEvent) => {
    const value = (evt.action.value ?? {}) as { reqId?: string; optionId?: string };
    if (!value.reqId) return;
    const p = pendings.get(value.reqId);
    if (!p || p.done) {
      // A second tap after the question closed: the human is correcting
      // themselves, so it becomes an instruction rather than nothing.
      const b = bindings.byChat(evt.chatId, await liveSessions());
      if (b) {
        const late = value.optionId ?? '';
        await inject(b, late ? `（补充）我选 ${late}` : '（补充）我又点了一下上面那张卡');
      }
      return { toast: { type: 'info', content: '这个问题已经结束了，刚才那下当成新指令发过去了' } };
    }
    const opt = p.payload.options.find((o) => o.id === value.optionId);
    if (!opt) return { toast: { type: 'error', content: '这个选项对不上，再试一次' } };
    // Build the closed card before answering, so it can ride back on this very
    // callback: Feishu swaps the card in the same round trip and the buttons
    // are gone before a second tap is possible.
    const closed = askCard({
      payload: p.payload,
      projectLabel: p.label,
      reqId: p.reqId,
      state: 'answered',
      reply: opt.label,
    });
    await answer(p, opt.label, 'button');
    return {
      toast: { type: 'success', content: '已回复' },
      card: { type: 'raw', data: closed },
    };
  });

  channel.on('error', (err) => log('channel.error', { code: err.code, message: err.message }));
  // The SDK drops messages that fail its policy gate and says why. Not
  // listening meant a dropped message looked exactly like one that was never
  // sent.
  channel.on('reject', (evt) => log('message.rejected', { chatId: evt.chatId, reason: evt.reason }));
  channel.on('reconnecting', () => log('channel.reconnecting'));
  channel.on('reconnected', () => log('channel.reconnected'));

  await channel.connect();
  log('daemon.connected', { bindings: bindings.all().length, credSource: creds.source });

  // ---- agent state pushes -------------------------------------------------
  const poll = async (): Promise<void> => {
    const all = bindings.all();
    if (!all.length) return;
    const agents = await agentList();

    // Keep every group's name current, whether or not remote mode is on: the
    // human reads the chat list even while sitting at the keyboard.
    for (const b of all) {
      const a =
        (b.sessionId ? agents.find((x) => x.agent_session?.value === b.sessionId) : undefined) ??
        agents.find((x) => x.pane_id === b.paneId);
      if (a && a.pane_id !== b.paneId) bindings.touch(b.key, { paneId: a.pane_id });
      // Compare against the name the group actually carries, not against
      // `task` — that field is rewritten by every CLI call, so it agrees with
      // the title before the rename ever runs. A binding from before this was
      // recorded has no `namedAs`, so it gets one corrective rename.
      const task = a?.terminal_title_stripped?.trim();
      if (task && groupName(b.label, task) !== b.namedAs) await renameChat(b, task);
      const status = a?.agent_status;
      const settled =
        !status || status === 'working' || status === 'unknown' ? 0 : (settledPolls.get(b.key) ?? 0) + 1;
      settledPolls.set(b.key, settled);
      await syncSayFooter(b, status, settled);
      await alertMissedMirror(b, a?.pane_id ?? null, settled);
    }

    const away = all.filter((b) => b.away && b.paneId);
    if (!away.length) return;
    for (const b of away) {
      if (pendingFor(b.key)) continue;
      const a =
        (b.sessionId ? agents.find((x) => x.agent_session?.value === b.sessionId) : undefined) ??
        agents.find((x) => x.pane_id === b.paneId);
      if (!a) continue;
      const prev = lastStatus.get(b.key);
      lastStatus.set(b.key, a.agent_status);
      const now = Date.now();
      if (a.agent_status === 'working' && prev !== 'working') workingSince.set(b.key, now);
      if (!prev || prev === a.agent_status) continue;

      // A turn that ended without the session saying anything to its group
      // means the human got nothing on their phone while the terminal filled
      // up. The rule that every reply is mirrored is the agent's to follow,
      // and an agent that forgets fails silently — so make the miss visible
      // to the only party that can fix it.
      let kind: 'blocked' | 'idle' | null = null;
      let ranMs = 0;
      if (a.agent_status === 'blocked') {
        // Stuck on a prompt only a human can answer: always worth a push.
        kind = 'blocked';
      } else if (prev === 'working' && (a.agent_status === 'idle' || a.agent_status === 'done')) {
        // "Finished" fires at the end of every conversational turn, which is
        // pure noise while the human is at the keyboard. Opt-in, and only
        // when the turn actually ran long enough to be worth interrupting for.
        if (!b.notifyIdle) continue;
        ranMs = now - (workingSince.get(b.key) ?? now);
        if (ranMs < b.idleMinMinutes * 60_000) continue;
        kind = 'idle';
      }
      if (!kind) continue;
      if (now - (lastStatusPush.get(b.key) ?? 0) < STATUS_COOLDOWN_MS) continue;
      lastStatusPush.set(b.key, now);
      const ranFor = ranMs ? `\n跑了 ${Math.round(ranMs / 60_000)} 分钟` : '';
      const detail =
        (a.terminal_title_stripped ? `**${a.terminal_title_stripped}**\n` : '') + `窗格 ${a.pane_id}${ranFor}`;
      try {
        await channel.send(b.chatId, { card: statusCard(b.label, kind, detail) });
        log('status.pushed', { key: b.key, kind });
      } catch (err) {
        log('status.failed', { key: b.key, err: String(err) });
      }
    }
  };
  // ---- subscription health ------------------------------------------------
  // Sending works over REST even while the WebSocket is down, so the channel
  // can报 its own half-failure. Without this the human sees replies arriving
  // normally and has no way to know their own messages are going nowhere.
  let downSince = 0;
  let alerted = false;
  let lastForcedAt = 0;
  let reconnecting = false;

  /** Tear the subscription down and build a new one. */
  const forceReconnect = async (): Promise<void> => {
    if (reconnecting) return;
    reconnecting = true;
    lastForcedAt = Date.now();
    log('link.forcing-reconnect', {
      downForSec: Math.round((Date.now() - downSince) / 1000),
      state: channel.getConnectionStatus()?.state,
      attempts: channel.getConnectionStatus()?.reconnectAttempts,
    });
    try {
      await channel.disconnect();
    } catch (err) {
      log('link.disconnect-failed', { err: String(err).slice(0, 120) });
    }
    try {
      await channel.connect();
      log('link.reconnect-attempted', { state: channel.getConnectionStatus()?.state });
    } catch (err) {
      log('link.reconnect-failed', { err: String(err).slice(0, 120) });
    } finally {
      reconnecting = false;
    }
  };

  const checkLink = async (): Promise<void> => {
    const state = channel.getConnectionStatus()?.state;
    const healthy = state === 'connected';
    if (healthy) {
      if (alerted) {
        const downFor = Math.round((Date.now() - downSince) / 1000);
        alerted = false;
        for (const b of bindings.all().filter((x) => x.away)) {
          try {
            await channel.send(b.chatId, {
              card: linkCard(b.label, 'back', `断了 ${downFor} 秒，现在恢复了。断线期间你发的消息**没有送到**，需要的话重发一次。`),
            });
          } catch {
            // the link just came back; a failure here is not worth cascading
          }
        }
        log('link.recovered', { downForSec: downFor });
      }
      downSince = 0;
      return;
    }
    if (!downSince) downSince = Date.now();
    const down = Date.now() - downSince;

    // Only take over when the SDK has stopped trying. `connecting` and
    // `reconnecting` mean it is on the case — forcing then would abort a
    // legitimate attempt and restart its backoff from zero. `idle` and
    // `failed` mean it has given up or never noticed, and those are the
    // states a half-open socket leaves behind.
    const givenUp = state === 'idle' || state === 'failed' || state === undefined;
    const stuckLooping = !givenUp && down > LINK_STUCK_AFTER_MS;
    const longEnough = down > LINK_FORCE_RECONNECT_AFTER_MS;
    const cooledDown = Date.now() - lastForcedAt > LINK_FORCE_RECONNECT_AFTER_MS;
    if ((givenUp ? longEnough : stuckLooping) && cooledDown) void forceReconnect();

    if (alerted || down < LINK_ALERT_AFTER_MS) return;
    alerted = true;
    log('link.down', { state });
    for (const b of bindings.all().filter((x) => x.away)) {
      try {
        await channel.send(b.chatId, {
          card: linkCard(
            b.label,
            'down',
            `和飞书的长连接断了（状态 \`${state ?? 'unknown'}\`），**你现在发的消息我收不到**。\n\n` +
              '这条卡片能发出来是因为发送走的是另一条通道。正在自动重连；一直不恢复的话，' +
              '在终端跑 `herdr-lark daemon --stop --force` 再 `herdr-lark daemon --detach`。',
          ),
        });
      } catch (err) {
        log('link.alert-failed', { key: b.key, err: String(err).slice(0, 120) });
      }
    }
  };
  const linkTimer = setInterval(() => void checkLink(), POLL_MS);
  linkTimer.unref();

  const pollTimer = setInterval(() => void poll(), POLL_MS);
  pollTimer.unref();

  // ---- IPC ----------------------------------------------------------------
  let server: Server | undefined;
  const shutdown = async (why: string): Promise<void> => {
    log('daemon.stopping', { why });
    // `channel.disconnect()` can hang on a half-dead socket, and a daemon that
    // says it stopped but keeps running blocks the next `--detach` from
    // starting a healthy one. Guarantee the exit.
    setTimeout(() => {
      log('daemon.force-exit', { why });
      process.exit(0);
    }, 8_000).unref();
    clearInterval(pollTimer);
    clearInterval(linkTimer);
    for (const p of [...pendings.values()]) {
      await closeWithout(p, 'cancelled', {
        ok: false,
        code: 3,
        message: 'daemon 正在停止；问题已经发出去了，但这次拿不到答复了',
      });
    }
    try {
      await channel.disconnect();
    } catch {
      // going down anyway
    }
    server?.close();
    for (const f of [sockPath(), pidPath()]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // best effort
      }
    }
    process.exit(0);
  };

  server = await serve({
    handle: async (req: Request, ctx): Promise<Response> => {
      switch (req.type) {
        case 'ping':
          return {
            ok: true,
            kind: 'pong',
            status: {
              pid: process.pid,
              connection: channel.getConnectionStatus()?.state ?? 'unknown',
              pendingAsks: pendings.size,
              bindings: bindings.all().length,
              startedAt,
            },
          };

        case 'stop':
          setTimeout(() => void shutdown('stop requested'), 50);
          return { ok: true, kind: 'ack' };

        case 'list':
          return {
            ok: true,
            kind: 'list',
            bindings: bindings.all().map((b) => ({
              key: b.key,
              root: b.root,
              label: b.label,
              task: b.task,
              chatId: b.chatId,
              paneId: b.paneId,
              away: b.away,
              notifyIdle: b.notifyIdle,
              idleMinMinutes: b.idleMinMinutes,
            })),
          };

        case 'bind': {
          const c = req.caller;
          const existing = bindings.get(c.key);
          if (req.chatId) {
            const b: Binding = {
              key: c.key,
              sessionId: c.sessionId,
              root: c.root,
              task: c.task,
              label: c.project,
              chatId: req.chatId,
              paneId: c.paneId ?? existing?.paneId ?? null,
              away: existing?.away ?? false,
              notifyIdle: existing?.notifyIdle ?? false,
              idleMinMinutes: existing?.idleMinMinutes ?? 10,
              boundAt: new Date().toISOString(),
            };
            bindings.set(b);
            refreshPolicy();
            log('bind', { key: c.key, chatId: req.chatId, created: false });
            return { ok: true, kind: 'bind', chatId: req.chatId, created: false, name: c.project };
          }
          if (existing) {
            bindings.touch(c.key, { paneId: c.paneId, task: c.task });
            return { ok: true, kind: 'bind', chatId: existing.chatId, created: false, name: existing.label };
          }
          // Adopt a binding written before the key was the session: re-key it
          // to this session and keep its group, so upgrading does not orphan
          // the chat history. The first session in the directory takes it; a
          // second one falls through and gets a group of its own, which is
          // exactly the separation this change is for.
          // Take over a binding that is this same conversation under an older
          // key. In order of confidence: the same agent session (the window
          // moved), then the same pane (a `/clear` started a new session in
          // the window the human is still sitting in), then the pre-session
          // key by project directory.
          const prior =
            (c.sessionId
              ? bindings.all().find((x) => x.sessionId === c.sessionId && x.key !== c.key)
              : undefined) ??
            (c.paneId ? bindings.all().find((x) => x.paneId === c.paneId && x.key !== c.key) : undefined) ??
            bindings.get(`proj:${c.root}`);
          if (prior) {
            bindings.remove(prior.key);
            const moved: Binding = {
              ...prior,
              key: c.key,
              sessionId: c.sessionId,
              task: c.task,
              label: c.project,
              paneId: c.paneId ?? prior.paneId,
            };
            bindings.set(moved);
            refreshPolicy();
            if (c.task && c.task !== prior.task) void renameChat(moved, c.task);
            log('bind.resumed', { from: prior.key, to: c.key, chatId: moved.chatId });
            return { ok: true, kind: 'bind', chatId: moved.chatId, created: false, name: moved.label };
          }

          // No local binding — but the group may already exist from an earlier
          // install whose bindings.json is gone. Creating a second group for
          // the same project would split the conversation in two, so look for
          // one the bot made for exactly this session before creating.
          const marker = `herdr-lark · ${c.key}`;
          try {
            for (const summary of await channel.listChats()) {
              let info;
              try {
                info = await channel.getChatInfo(summary.id);
              } catch {
                continue;
              }
              if (info.description !== marker) continue;
              const b: Binding = {
                key: c.key,
                sessionId: c.sessionId,
                root: c.root,
                task: c.task,
                label: c.project,
                chatId: summary.id,
                paneId: c.paneId,
                away: false,
                notifyIdle: false,
                idleMinMinutes: 10,
                boundAt: new Date().toISOString(),
              };
              bindings.set(b);
              refreshPolicy();
              log('bind.reused', { key: c.key, chatId: summary.id });
              return { ok: true, kind: 'bind', chatId: summary.id, created: false, name: summary.name };
            }
          } catch (err) {
            log('bind.scan-failed', { key: c.key, err: String(err) });
          }
          const owner = creds.ownerOpenId;
          if (!owner) {
            return {
              ok: false,
              code: 4,
              message: '不知道该把谁拉进新群（没有记录应用 owner）。用 --chat <chat_id> 绑定一个你自己建好的群。',
            };
          }
          // The group name carries the task, so several sessions in one repo
          // are told apart at a glance in the chat list.
          const name = req.name?.trim() || groupName(c.project, c.task);
          try {
            const { chatId } = await channel.createChat({
              name,
              description: marker,
              inviteUserIds: [owner],
              userIdType: 'open_id',
            });
            // `existing` is undefined here — the bound case returned above.
            const b: Binding = {
              key: c.key,
              sessionId: c.sessionId,
              root: c.root,
              task: c.task,
              label: c.project,
              chatId,
              namedAs: name,
              paneId: c.paneId,
              away: false,
              notifyIdle: false,
              idleMinMinutes: 10,
              boundAt: new Date().toISOString(),
            };
            bindings.set(b);
            refreshPolicy();
            log('bind', { key: c.key, chatId, created: true });
            return { ok: true, kind: 'bind', chatId, created: true, name };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              ok: false,
              code: /permission|99991672|scope/i.test(msg)
                ? 4
                : 3,
              message: `建群失败：${msg}\n若是权限问题，应用缺 im:chat（建群）权限，跑 herdr-lark setup --update 补授权，或用 --chat <chat_id> 绑已有群。`,
            };
          }
        }

        case 'unbind': {
          const b = bindings.get(req.caller.key);
          if (!b) return { ok: false, code: 1, message: '这个会话本来就没绑定' };
          const p = pendingFor(req.caller.key);
          if (p) return { ok: false, code: 4, message: '还有一个问题挂在手机上，先回答或等它超时' };
          bindings.remove(req.caller.key);
          refreshPolicy();
          log('unbind', { key: req.caller.key });
          return { ok: true, kind: 'ack' };
        }

        case 'setAway': {
          // `--all` exists because a person who is back is back for every
          // session, not just the one they happen to be typing in.
          if (req.all) {
            const n = req.away ? bindings.allAwayOn() : bindings.allAwayOff();
            lastStatus.clear();
            workingSince.clear();
            log('away.all', { away: req.away, count: n });
            return { ok: true, kind: 'ack', count: n };
          }
          const b = bindings.touch(req.caller.key, {
            away: req.away,
            paneId: req.caller.paneId,
            task: req.caller.task,
            notifyIdle: req.notifyIdle,
            idleMinMinutes: req.idleMinMinutes,
          });
          if (!b) return { ok: false, code: 4, message: '这个会话还没绑定，先跑 herdr-lark away on' };
          lastStatus.delete(req.caller.key);
          workingSince.delete(req.caller.key);
          log('away', { key: req.caller.key, away: req.away, notifyIdle: b.notifyIdle });
          return { ok: true, kind: 'ack' };
        }

        case 'notify': {
          const b = bindings.touch(req.caller.key, { paneId: req.caller.paneId, task: req.caller.task });
          if (!b) return { ok: false, code: 4, message: '这个会话还没绑定，先跑 herdr-lark away on' };
          let payload;
          try {
            payload = validateNotify(req.payload);
          } catch (err) {
            if (err instanceof ValidationError) return { ok: false, code: 1, message: err.problems.join('\n') };
            throw err;
          }
          try {
            await channel.send(b.chatId, { card: notifyCard(payload, b.label) });
            markOutbound(b.key);
            log('notify.sent', { key: b.key });
            return { ok: true, kind: 'ack' };
          } catch (err) {
            return { ok: false, code: 3, message: `发送失败：${err instanceof Error ? err.message : String(err)}` };
          }
        }

        case 'say': {
          const b = bindings.touch(req.caller.key, { paneId: req.caller.paneId, task: req.caller.task });
          if (!b) return { ok: false, code: 4, message: '这个项目还没 bind，先跑 herdr-lark away on' };
          const text = req.text.trim();
          if (!text) return { ok: false, code: 1, message: '没有内容可发' };
          return sendSay(b, text, req.title);
        }

        // The Stop hook's mirror. Same card as `say`, but it declines rather
        // than duplicates: the agent may already have followed the rule this
        // turn, and two copies of one answer are worse than none.
        case 'mirror': {
          // No `task` here: the hook has no terminal title to offer, and
          // writing null would wipe the one the group is named after.
          const b = bindings.touch(req.caller.key, { paneId: req.caller.paneId });
          if (!b) return { ok: true, kind: 'ack' };
          if (!b.away) return { ok: true, kind: 'ack' };
          if ((lastOutbound.get(b.key) ?? 0) >= req.turnStartedAt) {
            log('mirror.skipped', { key: b.key, why: 'already mirrored this turn' });
            return { ok: true, kind: 'ack' };
          }
          const text = req.text.trim();
          if (!text) return { ok: true, kind: 'ack' };
          log('mirror.hook', { key: b.key, chars: text.length });
          return sendSay(b, text);
        }

        case 'sendFile': {
          const b = bindings.touch(req.caller.key, { paneId: req.caller.paneId, task: req.caller.task });
          if (!b) return { ok: false, code: 4, message: '这个会话还没绑定，先跑 herdr-lark away on' };
          const checked = resolveSendable(req.path, b.root);
          if ('error' in checked) return { ok: false, code: 1, message: checked.error };
          const { real, bytes } = checked;
          const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(real);
          const fileName = basename(real) || 'file';
          try {
            if (req.caption) await channel.send(b.chatId, { markdown: `**[${b.label}]** ${req.caption}` });
            // A Buffer bypasses the SDK's allowedFileDirs allowlist, which can
            // only be fixed at channel creation while bindings change at
            // runtime. The check above is stricter: the file must live inside
            // the calling project (or a temp dir), after realpath.
            await channel.send(
              b.chatId,
              isImage ? { image: { source: bytes } } : { file: { source: bytes, fileName } },
            );
            markOutbound(b.key);
            log('file.sent', { key: b.key, isImage, size: bytes.length });
            return { ok: true, kind: 'ack' };
          } catch (err) {
            return { ok: false, code: 3, message: `发送失败：${err instanceof Error ? err.message : String(err)}` };
          }
        }

        case 'ask': {
          const b = bindings.touch(req.caller.key, { paneId: req.caller.paneId, task: req.caller.task });
          if (!b) return { ok: false, code: 4, message: '这个会话还没绑定，先跑 herdr-lark away on' };
          if (pendingFor(req.caller.key))
            return { ok: false, code: 4, message: '这个项目已经有一个问题挂在手机上了；一次只能问一个' };
          let payload: AskPayload;
          try {
            payload = validateAsk(req.payload);
          } catch (err) {
            if (err instanceof ValidationError) return { ok: false, code: 1, message: err.problems.join('\n') };
            throw err;
          }
          const reqId = randomUUID().replace(/-/g, '').slice(0, 16);
          let messageId: string;
          try {
            const sent = await channel.send(b.chatId, {
              card: askCard({ payload, projectLabel: b.label, reqId, state: 'pending' }),
            });
            messageId = sent.messageId;
          } catch (err) {
            return { ok: false, code: 3, message: `发送失败：${err instanceof Error ? err.message : String(err)}` };
          }
          markOutbound(b.key);
          log('ask.sent', { reqId, key: b.key, options: payload.options.length });

          return await new Promise<Response>((resolve) => {
            const p: Pending = {
              reqId,
              key: b.key,
              root: b.root,
              chatId: b.chatId,
              messageId,
              label: b.label,
              payload,
              settle: resolve,
              done: false,
              timer: setTimeout(() => {
                void closeWithout(p, 'timedout', {
                  ok: false,
                  code: 2,
                  message: `等了 ${Math.round(req.timeoutMs / 1000)} 秒没人回答`,
                });
              }, req.timeoutMs),
            };
            pendings.set(reqId, p);
            // The client dying (a harness tool timeout) must not leave a dead
            // question on the phone.
            ctx.onClose(() => {
              if (!p.done)
                void closeWithout(p, 'cancelled', {
                  ok: false,
                  code: 3,
                  message: '提问方断开了',
                });
            });
            ctx.note(`已发到飞书群，等你回答（最长 ${Math.round(req.timeoutMs / 1000)} 秒）`);
          });
        }

        default:
          return { ok: false, code: 1, message: '不认识的请求' };
      }
    },
  });

  writeFileSync(pidPath(), `${process.pid}\n`, { mode: 0o600 });
  log('daemon.started', { pid: process.pid });
  process.stdout.write(`herdr-lark daemon: pid ${process.pid}，已连上飞书，socket ${sockPath()}\n`);

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}
