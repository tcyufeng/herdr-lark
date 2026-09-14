import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { bindingsPath, ensureHomeDir } from './paths.js';

export interface Binding {
  /**
   * The agent session this group belongs to. Several sessions often run in
   * the same directory on different tasks — keying on the directory would put
   * them in one group, give them one question slot between them, and deliver
   * a phone reply to whichever pane happened to run a command last. That is
   * the wrong agent acting on your instruction, so the session is the key.
   *
   * `pane:<id>` when the session id could not be read, `proj:<root>` outside
   * herdr entirely.
   */
  key: string;
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

  byChat(chatId: string): Binding | undefined {
    for (const b of this.map.values()) if (b.chatId === chatId) return b;
    return undefined;
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
