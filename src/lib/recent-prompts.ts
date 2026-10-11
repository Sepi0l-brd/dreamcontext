import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userPromptOf } from './transcript-history.js';

/**
 * recent-prompts — what the person has been TYPING in this project lately, read from the Claude Code
 * transcripts the sleep state already records (`state/.sleep.json` → `sessions[].transcript_path`).
 *
 * One caller today: the recall recommendation, which needs the language of the prompts (a brain
 * written in English and queried in Turkish is a multi-language brain, and keyword search fails it).
 * The text never leaves this module's caller: the route turns it into a share and drops it.
 *
 * Bounded on purpose: the newest few transcripts of the project, only their tail, a capped number of
 * prompts. Symlinks are skipped (a transcript dir is outside the vault, but the rule is the same).
 * Never throws: no state, no transcripts or an unreadable file is simply fewer prompts.
 */

export interface RecentPromptsOpts {
  /** Newest transcripts read. */
  maxFiles?: number;
  /** Bytes read from the end of each transcript. */
  tailBytes?: number;
  /** Prompts returned, newest first. */
  maxPrompts?: number;
}

const DEFAULTS: Required<RecentPromptsOpts> = { maxFiles: 12, tailBytes: 512 * 1024, maxPrompts: 200 };

function isPlainFile(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPlainDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The transcript directories the sleep state points at. */
function transcriptDirs(contextRoot: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8');
  } catch {
    return [];
  }
  let sessions: unknown;
  try {
    sessions = (JSON.parse(raw) as { sessions?: unknown }).sessions;
  } catch {
    return [];
  }
  if (!Array.isArray(sessions)) return [];
  const dirs = new Set<string>();
  for (const s of sessions) {
    const p = (s as { transcript_path?: unknown } | null)?.transcript_path;
    if (typeof p === 'string' && p.endsWith('.jsonl')) dirs.add(dirname(p));
  }
  return [...dirs].filter(isPlainDir);
}

function readTail(path: string, bytes: number): string {
  let fd: number | null = null;
  try {
    const size = lstatSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf-8');
    // A tail starts mid-line: drop the partial first line.
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The person's recent prompts in this project, newest first. Empty when nothing is recorded. */
export function recentUserPrompts(contextRoot: string, opts: RecentPromptsOpts = {}): string[] {
  const o = { ...DEFAULTS, ...opts };
  const files: Array<{ path: string; mtime: number }> = [];
  for (const dir of transcriptDirs(contextRoot)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      if (!isPlainFile(path)) continue;
      try {
        files.push({ path, mtime: lstatSync(path).mtimeMs });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const prompts: string[] = [];
  for (const f of files.slice(0, o.maxFiles)) {
    const lines = readTail(f.path, o.tailBytes).split('\n');
    const own: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      // Another agent's turns inside this transcript are not the person typing.
      if ((obj as { isSidechain?: unknown }).isSidechain === true) continue;
      const text = userPromptOf(obj);
      // Claude Code writes "[Request interrupted by user]" as a user turn: nobody typed it.
      if (text && !/^\[Request interrupted/.test(text)) own.push(text);
    }
    prompts.push(...own.reverse());
    if (prompts.length >= o.maxPrompts) break;
  }
  return prompts.slice(0, o.maxPrompts);
}
