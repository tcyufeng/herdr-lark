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
export async function promptPane(paneId: string, text: string): Promise<PromptOutcome> {
  try {
    const { stdout } = await execFileAsync('herdr', ['agent', 'prompt', paneId, text], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const env = parse<unknown>(stdout);
    if (env.error) return { ok: false, code: env.error.code, message: env.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'spawn_failed', message: err instanceof Error ? err.message : String(err) };
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
