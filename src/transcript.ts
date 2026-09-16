import { readFileSync } from 'node:fs';

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
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
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
