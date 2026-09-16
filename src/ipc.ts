import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { ensureHomeDir, pidPath, sockPath } from './paths.js';

/** Every request a thin client can make of the daemon. */
/** Who is calling: the agent session, not just its directory. */
export interface Caller {
  key: string;
  sessionId: string | null;
  root: string;
  /** Project directory name. */
  project: string;
  /** What this session is working on. */
  task: string | null;
  paneId: string | null;
}

export type Request =
  | { type: 'ping' }
  | { type: 'stop' }
  | { type: 'list' }
  | { type: 'bind'; caller: Caller; chatId?: string; name?: string }
  | { type: 'unbind'; caller: Caller }
  | { type: 'setAway'; caller: Caller; away: boolean; all?: boolean; notifyIdle?: boolean; idleMinMinutes?: number }
  | { type: 'ask'; caller: Caller; payload: unknown; timeoutMs: number }
  | { type: 'notify'; caller: Caller; payload: unknown }
  | { type: 'say'; caller: Caller; text: string; title?: string }
  | { type: 'sendFile'; caller: Caller; path: string; caption?: string };

export interface DaemonStatus {
  pid: number;
  connection: string;
  pendingAsks: number;
  bindings: number;
  startedAt: string;
}

export type Response =
  | { ok: true; kind: 'pong'; status: DaemonStatus }
  | { ok: true; kind: 'ask'; reply: string; via: 'button' | 'text' }
  | { ok: true; kind: 'bind'; chatId: string; created: boolean; name: string }
  | { ok: true; kind: 'list'; bindings: Array<{ key: string; root: string; label: string; task: string | null; chatId: string; paneId: string | null; away: boolean; notifyIdle: boolean; idleMinMinutes: number }> }
  | { ok: true; kind: 'ack'; count?: number }
  /** code maps 1:1 onto the CLI exit code the client should use. */
  | { ok: false; code: 1 | 2 | 3 | 4; message: string };

/**
 * Frames the daemon may push before the final one. The wrapper uses `frame`,
 * not `kind`: `Response` already discriminates on `kind`, and sharing the name
 * made the client strip the response's own discriminator.
 */
export type Frame = { frame: 'note'; text: string } | { frame: 'result'; body: Response };

/** What the pid file says about a daemon that left its socket behind. */
function describeStalePid(): string {
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8').trim());
    if (!pid) return '';
    try {
      process.kill(pid, 0);
      return `（pid ${pid} 还活着，但没在监听——它卡住了）`;
    } catch {
      return `（pid ${pid} 已经不在了）`;
    }
  } catch {
    return '';
  }
}

export function isDaemonListening(): boolean {
  return existsSync(sockPath());
}

/**
 * One request, one connection. The connection stays open until the daemon
 * sends its result frame — that is what makes `ask` block, and what makes a
 * dead daemon surface immediately as a dropped connection instead of a hang.
 */
export function request(
  req: Request,
  opts: { onNote?: (text: string) => void; timeoutMs?: number } = {},
): Promise<Response> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Response): void => {
      if (settled) return;
      settled = true;
      try {
        sock.end();
      } catch {
        // already gone
      }
      resolve(r);
    };

    const sock = createConnection(sockPath());
    let buf = '';

    sock.on('connect', () => {
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          continue;
        }
        if (frame.frame === 'note') {
          opts.onNote?.(frame.text);
          continue;
        }
        done(frame.body);
      }
    });
    sock.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT and ECONNREFUSED are not the same diagnosis and must not read
      // the same. No socket file means the daemon was stopped cleanly or never
      // started. A socket file nobody answers on means it *died* — crashed or
      // was killed — without running its own cleanup, and that is worth saying
      // out loud, because the next `--detach` erases the evidence.
      let hint: string;
      if (err.code === 'ENOENT') hint = 'daemon 没在跑（socket 文件不存在）。先执行：herdr-lark daemon --detach';
      else if (err.code === 'ECONNREFUSED') hint = `daemon 崩了：socket 文件还在但没人接${describeStalePid()}。执行：herdr-lark daemon --detach`;
      else hint = `无法连接 daemon: ${err.message}`;
      done({ ok: false, code: 3, message: hint });
    });
    sock.on('close', () => {
      done({ ok: false, code: 3, message: 'daemon 在回答之前断开了连接（它可能崩溃或被停止了）' });
    });
    if (opts.timeoutMs) {
      sock.setTimeout(opts.timeoutMs, () => {
        done({ ok: false, code: 3, message: 'daemon 没有在预期时间内响应' });
      });
    }
  });
}

export interface ServeHandlers {
  /** Resolve with the final response; call `note` to push progress first. */
  handle(req: Request, ctx: { note: (text: string) => void; onClose: (fn: () => void) => void }): Promise<Response>;
}

export function serve(handlers: ServeHandlers): Promise<Server> {
  ensureHomeDir();
  const path = sockPath();
  // A socket file nobody answers on is a crash leftover: replace it.
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // fall through; listen() will report the real problem
    }
  }
  return new Promise((resolve, reject) => {
    const server = createServer((sock: Socket) => {
      let buf = '';
      const closeFns: Array<() => void> = [];
      sock.on('close', () => {
        for (const fn of closeFns) fn();
      });
      sock.on('error', () => {
        /* client vanished mid-request */
      });
      sock.on('data', async (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        let req: Request;
        try {
          req = JSON.parse(line) as Request;
        } catch {
          sock.write(`${JSON.stringify({ frame: 'result', body: { ok: false, code: 1, message: '无法解析的请求' } })}\n`);
          sock.end();
          return;
        }
        const note = (text: string): void => {
          if (!sock.destroyed) sock.write(`${JSON.stringify({ frame: 'note', text })}\n`);
        };
        const onClose = (fn: () => void): void => {
          closeFns.push(fn);
        };
        let res: Response;
        try {
          res = await handlers.handle(req, { note, onClose });
        } catch (err) {
          res = { ok: false, code: 3, message: err instanceof Error ? err.message : String(err) };
        }
        if (!sock.destroyed) {
          sock.write(`${JSON.stringify({ frame: 'result', body: res })}\n`);
          sock.end();
        }
      });
    });
    server.on('error', reject);
    server.listen(path, () => resolve(server));
  });
}
