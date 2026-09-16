import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  agent: string;
  agent_session?: { value?: string };
  agent_status: AgentStatus;
  cwd: string;
  foreground_cwd?: string;
  pane_id: string;
  focused: boolean;
  terminal_title_stripped?: string;
  workspace_id?: string;
}

/** herdr answers with `{error:{code,message}}` on stdout and still exits 0. */
interface HerdrEnvelope<T> {
  id?: string;
  result?: T;
  error?: { code: string; message: string };
}

export function insideHerdr(): boolean {
  return process.env.HERDR_ENV === '1';
}

/** The pane this process was started from, when herdr set it. */
export function currentPaneId(): string | null {
  const id = process.env.HERDR_PANE_ID?.trim();
  return id || null;
}

function parse<T>(stdout: string): HerdrEnvelope<T> {
  try {
    return JSON.parse(stdout) as HerdrEnvelope<T>;
  } catch {
    return { error: { code: 'bad_output', message: stdout.slice(0, 200) } };
  }
}

export async function agentList(): Promise<AgentInfo[]> {
  try {
    const { stdout } = await execFileAsync('herdr', ['agent', 'list'], { timeout: 10_000 });
    const env = parse<{ agents?: AgentInfo[] }>(stdout);
    return env.result?.agents ?? [];
  } catch {
    return [];
  }
}

export function agentListSync(): AgentInfo[] {
  try {
    const stdout = execFileSync('herdr', ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parse<{ agents?: AgentInfo[] }>(stdout).result?.agents ?? [];
  } catch {
    return [];
  }
}

export interface PromptOutcome {
  ok: boolean;
  /** herdr's own error code when the submission was refused. */
  code?: string;
  message?: string;
}

/**
 * Inject one line into a pane's agent. herdr refuses the submission outright
 * when the agent is already blocked (`agent_blocked`) — that is a real
 * outcome the caller must report to the phone, not a transport failure.
 */
export async function promptPane(
  paneId: string,
  text: string,
  opts: { waitMs?: number } = {},
): Promise<PromptOutcome> {
  const args = ['agent', 'prompt', paneId, text];
  // `--wait` is what turns "herdr typed it" into "the agent actually took it".
  // Without it a submission that lands in the input box but never gets sent
  // still reports ok, and the message sits there until a human walks over.
  if (opts.waitMs) args.push('--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(opts.waitMs));
  try {
    const { stdout } = await execFileAsync('herdr', args, {
      timeout: (opts.waitMs ?? 0) + 20_000,
      maxBuffer: 1024 * 1024,
    });
    const env = parse<unknown>(stdout);
    if (env.error) return { ok: false, code: env.error.code, message: env.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'spawn_failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Raw key presses into a pane. Used to finish a submission herdr's own prompt left hanging. */
export async function sendKeys(paneId: string, ...keys: string[]): Promise<PromptOutcome> {
  try {
    const { stdout } = await execFileAsync('herdr', ['agent', 'send-keys', paneId, ...keys], { timeout: 10_000 });
    const env = parse<unknown>(stdout);
    if (env.error) return { ok: false, code: env.error.code, message: env.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'spawn_failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Did the pane start a turn? Returns false on timeout rather than throwing. */
export async function paneStarted(paneId: string, timeoutMs: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'herdr',
      ['agent', 'wait', paneId, '--until', 'working', '--until', 'blocked', '--timeout', String(timeoutMs)],
      { timeout: timeoutMs + 10_000 },
    );
    return !parse<unknown>(stdout).error;
  } catch {
    return false;
  }
}

/** Best-effort: the pane currently running an agent in this project. */
export function findPaneForProject(agents: AgentInfo[], root: string): string | null {
  const inProject = agents.filter((a) => a.cwd === root || a.foreground_cwd === root);
  if (inProject.length === 0) return null;
  const focused = inProject.find((a) => a.focused);
  return (focused ?? inProject[0])!.pane_id;
}

/**
 * Which pane is running this agent session right now. A pane can be moved,
 * split off or renumbered while the session inside it keeps running, so the
 * session id is the durable identity and the pane is looked up from it at the
 * moment a message has to be delivered.
 */
export function findPaneForSession(agents: AgentInfo[], sessionId: string): string | null {
  return agents.find((a) => a.agent_session?.value === sessionId)?.pane_id ?? null;
}

export interface SessionIdentity {
  /** The agent session's own id — the lease holder. */
  sessionId: string | null;
  paneId: string | null;
  /** Project root, kept for display and for grouping several sessions. */
  root: string;
  /** Short label: the project directory name. */
  project: string;
  /** What this session is working on, as the terminal title reports it. */
  title: string | null;
}

/**
 * Identify the session this command was run from. `HERDR_PANE_ID` tells us
 * which pane we are in; herdr then tells us which agent session occupies it.
 */
export function identifySession(root: string, project: string): SessionIdentity {
  const paneId = currentPaneId();
  const id: SessionIdentity = { sessionId: null, paneId, root, project, title: null };
  if (!paneId) return id;
  const me = agentListSync().find((a) => a.pane_id === paneId);
  if (!me) return id;
  id.sessionId = me.agent_session?.value ?? null;
  id.title = me.terminal_title_stripped?.trim() || null;
  return id;
}

/**
 * The visible tail of a pane, with the terminal's own furniture stripped off
 * the bottom — status bar, input box, rules. Used as a fallback mirror when a
 * session finished a turn without sending its reply to the group: raw output
 * the human can read beats a card that only says "go look at your computer".
 */
/**
 * The agent's input prompt. Everything from here down is the terminal's own
 * chrome — the box rules around the input, the model/context/usage bar — and
 * none of it belongs in a message to a phone.
 */
const PANE_PROMPT = /^\s*(?:❯|›)\s?/;
/** Blank lines and box rules, the only things safe to shave blindly. */
const PANE_RULE = /^\s*(?:─{3,}\s*)?$/;
/** Hint lines the agent parks just above its input box. Best-effort, cosmetic. */
const PANE_HINT = /^\s*(?:new task\?|✔ Update|.*\/clear to save |.*·\s*ctrl\+)/;

export async function paneTail(paneId: string, keep = 24, maxChars = 2400): Promise<string | null> {
  try {
    // `recent-unwrapped` is the good source but herdr refuses it outright while
    // the pane is working ('agent_not_idle') — and a session can start a new
    // turn between the settle check and this read. `visible` always answers.
    const read = async (source: string, lines: number): Promise<string> =>
      (await execFileAsync('herdr', ['agent', 'read', paneId, '--source', source, '--lines', String(lines)], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })).stdout;
    let stdout: string;
    try {
      stdout = await read('recent-unwrapped', 60);
    } catch {
      stdout = await read('visible', 60);
    }
    const lines = stdout.split('\n');
    // Cut at the input prompt rather than shaving known chrome off the bottom.
    // Shaving stops at the first line it does not recognise, so one unlisted
    // status-bar line (`Usage …`) drags the whole bar into the message.
    let cut = -1;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 15; i--) {
      if (PANE_PROMPT.test(lines[i]!)) {
        cut = i;
        break;
      }
    }
    if (cut > 0) {
      while (cut > 0 && (PANE_RULE.test(lines[cut - 1]!) || PANE_HINT.test(lines[cut - 1]!))) cut -= 1;
      lines.length = cut;
    }
    while (lines.length && (PANE_RULE.test(lines[lines.length - 1]!) || PANE_HINT.test(lines[lines.length - 1]!)))
      lines.pop();
    const tail = lines.slice(-keep).join('\n').trim();
    if (!tail) return null;
    return tail.length > maxChars ? `…（略去开头）\n${tail.slice(-maxChars)}` : tail;
  } catch {
    return null;
  }
}
