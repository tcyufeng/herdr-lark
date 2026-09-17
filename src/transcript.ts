import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Turn {
  /** Everything the agent said to the human this turn, in order. */
  text: string;
  /** When the turn began, so the daemon can tell an already-mirrored turn apart. */
  startedAt: number;
}

interface Line {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

const blocks = (line: Line): { type?: string; text?: string }[] => {
  const c = line.message?.content;
  return Array.isArray(c) ? (c as { type?: string; text?: string }[]) : [];
};

/**
 * Where a turn begins. Any `user` line that is not purely tool results starts
 * one — a typed message, an injected one, or a harness wake-up such as a
 * finished background task. All three make the agent speak again, and all
 * three are boundaries for "what it said this turn".
 *
 * Content arrives either as a plain string or as a block array, so both shapes
 * have to be understood; checking only for blocks silently finds no turn at
 * all in a transcript whose messages are strings.
 */
const isTurnStart = (line: Line): boolean => {
  if (line.type !== 'user' || line.isSidechain) return false;
  if (typeof line.message?.content === 'string') return true;
  return blocks(line).some((b) => b.type !== 'tool_result');
};

/**
 * The last slice of a file, as text starting at a line boundary.
 *
 * Transcripts grow without bound — 544 MB observed on a long-running session —
 * and `readFileSync(path, 'utf8')` throws ERR_STRING_TOO_LONG past roughly half
 * a gigabyte. That failure was silent: the mirror hook simply stopped working
 * on exactly the sessions that had been talking the longest, which are the ones
 * the human most wants mirrored. Only the tail was ever needed.
 */
const TAIL_BYTES = 16 * 1024 * 1024;

function readTail(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // The window almost certainly opened mid-line; that fragment is not JSON.
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The agent's own words from the last turn of a Claude Code transcript.
 *
 * Every `text` block since the last human message is included, not just the
 * final one: the human watching the terminal sees the narration between tool
 * calls too, and the mirroring rule is "what you said", not "your conclusion".
 * `thinking` and `tool_use` blocks are not said out loud, so they stay out.
 *
 * Sidechain lines belong to subagents, which have their own transcript and
 * were never shown to the human in this pane.
 */
export function lastTurn(transcriptPath: string): Turn | null {
  const raw = readTail(transcriptPath);
  if (raw === null) return null;
  const lines: Line[] = [];
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    try {
      lines.push(JSON.parse(ln) as Line);
    } catch {
      // A transcript being appended to can end mid-line; skip what won't parse.
    }
  }
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isTurnStart(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const said: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.type !== 'assistant' || line.isSidechain) continue;
    for (const b of blocks(line)) if (b.type === 'text' && b.text?.trim()) said.push(b.text.trim());
  }
  if (!said.length) return null;
  const startedAt = Date.parse(lines[start]!.timestamp ?? '') || Date.now();
  return { text: said.join('\n\n'), startedAt };
}

/**
 * The Claude Code transcript for a session, wherever it landed.
 *
 * Claude Code files transcripts under a directory named after the working
 * directory it was started in, which is not always the project root a binding
 * records — a session that started in a subdirectory files elsewhere. So look
 * the session id up across all of them rather than computing one path.
 *
 * Returns null for any other agent CLI, which is the point: the caller falls
 * back to reading the terminal.
 */
export function findTranscript(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const root = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects');
  if (!existsSync(root)) return null;
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Unreadable config dir: fall back to the terminal like any other agent.
  }
  return null;
}
