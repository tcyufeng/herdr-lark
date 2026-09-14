import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { bindingsPath, ensureHomeDir } from './paths.js';

export interface Binding {
  /**
   * `pane:<id>` — one window, one group. See `caller()` in cli.ts for why the
   * pane wins over both the directory and the agent session.
   * `sess:<id>` or `proj:<root>` when there is no pane to key on.
   */
  key: string;
  /** Recorded, not keyed on: a change here means the human ran `/clear`. */
  sessionId: string | null;
  /** Project root — no longer the key, but still how bindings are grouped. */
  root: string;
  /** What this session is working on, from the terminal title when known. */
  task: string | null;
  label: string;
  chatId: string;
  /** herdr pane that phone messages are injected into; refreshed on every call. */
  paneId: string | null;
  away: boolean;
  /** Push a card when a turn finishes, not just when the agent is stuck. */
  notifyIdle: boolean;
  /** Only push "finished" when the turn ran at least this long. */
  idleMinMinutes: number;
  boundAt: string;
}

export class BindingStore {
  private map = new Map<string, Binding>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(bindingsPath(), 'utf8')) as { bindings?: Binding[] };
      for (const b of raw.bindings ?? []) {
        if (!b || typeof b.root !== 'string' || typeof b.chatId !== 'string') continue;
        // Older files predate the idle policy; default to the quiet setting.
        b.notifyIdle = b.notifyIdle === true;
        b.idleMinMinutes = typeof b.idleMinMinutes === 'number' ? b.idleMinMinutes : 10;
        // Bindings written before the key was the session are keyed by root.
        if (typeof b.key !== 'string') b.key = `proj:${b.root}`;
        if (b.sessionId === undefined) b.sessionId = null;
        if (b.task === undefined) b.task = null;
        this.map.set(b.key, b);
      }
    } catch {
      // no bindings yet
    }
  }

  private persist(): void {
    ensureHomeDir();
    const file = bindingsPath();
    const tmp = `${file}.tmp`;
    const data = { bindings: [...this.map.values()] };
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }

  get(key: string): Binding | undefined {
    return this.map.get(key);
  }

  /** Every binding under one project root, for display and for `off --all`. */
  byRoot(root: string): Binding[] {
    return [...this.map.values()].filter((b) => b.root === root);
  }

  /**
   * Which binding a group's messages belong to. `live` says which sessions
   * herdr can currently see, so that after a window is closed and the same
   * conversation resumed elsewhere, the group routes to the one that is
   * actually running rather than to whichever stale record came first.
   */
  byChat(chatId: string, live?: Set<string>): Binding | undefined {
    const matches = [...this.map.values()].filter((b) => b.chatId === chatId);
    if (matches.length <= 1) return matches[0];
    const running = matches.find((b) => b.sessionId && live?.has(b.sessionId));
    if (running) return running;
    return matches.sort((a, b) => b.boundAt.localeCompare(a.boundAt))[0];
  }

  /**
   * Two bindings on one group means one of them is a leftover — a window was
   * closed and the conversation re-bound elsewhere. Keep the newest and drop
   * the rest, or a phone message goes to whichever record is found first.
   */
  pruneDuplicateChats(): number {
    const byChat = new Map<string, Binding[]>();
    for (const b of this.map.values()) {
      const list = byChat.get(b.chatId) ?? [];
      list.push(b);
      byChat.set(b.chatId, list);
    }
    let dropped = 0;
    for (const list of byChat.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.boundAt.localeCompare(a.boundAt));
      for (const stale of list.slice(1)) {
        this.map.delete(stale.key);
        dropped += 1;
      }
    }
    if (dropped) this.persist();
    return dropped;
  }

  all(): Binding[] {
    return [...this.map.values()];
  }

  chatIds(): string[] {
    return [...this.map.values()].map((b) => b.chatId);
  }

  set(b: Binding): void {
    this.map.set(b.key, b);
    this.persist();
  }

  /** Refresh the fields a live call carries, without disturbing the binding. */
  touch(
    key: string,
    patch: Partial<Pick<Binding, 'paneId' | 'away' | 'label' | 'task' | 'notifyIdle' | 'idleMinMinutes'>>,
  ): Binding | undefined {
    const b = this.map.get(key);
    if (!b) return undefined;
    if (patch.paneId !== undefined && patch.paneId !== null) b.paneId = patch.paneId;
    if (patch.away !== undefined) b.away = patch.away;
    if (patch.notifyIdle !== undefined) b.notifyIdle = patch.notifyIdle;
    if (patch.idleMinMinutes !== undefined) b.idleMinMinutes = patch.idleMinMinutes;
    if (patch.label) b.label = patch.label;
    if (patch.task !== undefined) b.task = patch.task;
    this.persist();
    return b;
  }

  remove(key: string): boolean {
    const had = this.map.delete(key);
    if (had) this.persist();
    return had;
  }

  /** Turn remote mode on for every bound session. */
  allAwayOn(): number {
    let n = 0;
    for (const b of this.map.values())
      if (!b.away) {
        b.away = true;
        n += 1;
      }
    if (n) this.persist();
    return n;
  }

  /** Turn remote mode off everywhere: the human is back, not "back here". */
  allAwayOff(): number {
    let n = 0;
    for (const b of this.map.values())
      if (b.away) {
        b.away = false;
        n += 1;
      }
    if (n) this.persist();
    return n;
  }
}
