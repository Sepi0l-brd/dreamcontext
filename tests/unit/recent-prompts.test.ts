import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recentUserPrompts } from '../../src/lib/recent-prompts.js';

/** The person's recent prompts, read from the transcripts the sleep state records. */

let tmp: string;
let root: string;
let projDir: string;

const user = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { content: text }, ...extra });
const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function transcript(name: string, lines: string[], mtimeSec: number): string {
  const p = join(projDir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

function recordSessions(paths: string[]): void {
  writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify({ sessions: paths.map((p) => ({ transcript_path: p })) }));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-recent-prompts-'));
  root = join(tmp, 'vault', '_dream_context');
  projDir = join(tmp, 'claude', 'projects', '-vault');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(projDir, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('recentUserPrompts', () => {
  it('returns typed prompts newest first, across the recorded project dir, skipping what nobody typed', () => {
    const older = transcript('a.jsonl', [user('first older prompt'), assistant('reply'), user('second older prompt')], 1_000);
    transcript('b.jsonl', [
      user('newest session prompt'),
      user('<command-name>/clear</command-name>'),
      user('meta line', { isMeta: true }),
      user('a sub-agent turn', { isSidechain: true }),
      user('[Request interrupted by user]'),
    ], 2_000);
    recordSessions([older]);
    expect(recentUserPrompts(root)).toEqual(['newest session prompt', 'second older prompt', 'first older prompt']);
  });

  it('caps files and prompts', () => {
    const a = transcript('a.jsonl', [user('old one')], 1_000);
    transcript('b.jsonl', [user('new one'), user('new two')], 2_000);
    recordSessions([a]);
    expect(recentUserPrompts(root, { maxFiles: 1 })).toEqual(['new two', 'new one']);
    expect(recentUserPrompts(root, { maxPrompts: 1 })).toEqual(['new two']);
  });

  it('reads only the tail and drops the partial first line', () => {
    const p = transcript('a.jsonl', [user('x'.repeat(400)), user('kept at the end')], 1_000);
    recordSessions([p]);
    expect(recentUserPrompts(root, { tailBytes: 100 })).toEqual(['kept at the end']);
  });

  it('skips a symlinked transcript and is empty without state', () => {
    const real = transcript('real.jsonl', [user('real prompt')], 1_000);
    const outside = join(tmp, 'outside.jsonl');
    writeFileSync(outside, user('linked secret') + '\n');
    symlinkSync(outside, join(projDir, 'link.jsonl'));
    recordSessions([real]);
    expect(recentUserPrompts(root)).toEqual(['real prompt']);
    rmSync(join(root, 'state', '.sleep.json'));
    expect(recentUserPrompts(root)).toEqual([]);
  });
});
