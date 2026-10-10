import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCorpus } from '../../src/lib/recall.js';
import { buildCorpusCached } from '../../src/lib/recall-corpus-cache.js';

let root: string;

function write(rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'dc-cloud-optout-')), '_dream_context');
  mkdirSync(root, { recursive: true });
  write('knowledge/private-note.md', '---\nname: Private note\ndescription: d\ncloud: false\n---\n\nSensitive body text.\n');
  write('knowledge/open-note.md', '---\nname: Open note\ndescription: d\ncloud: true\n---\n\nOpen body text.\n');
  write('knowledge/plain-note.md', '---\nname: Plain note\ndescription: d\n---\n\nPlain body text.\n');
  write('whiteboards/board/board.excalidraw.md', '---\nname: Board\ncloud: false\n---\n\n## Text Elements\nlabel ^abc\n');
});

afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

const flags = (docs: ReturnType<typeof buildCorpus>) =>
  Object.fromEntries(docs.filter((d) => d.type === 'knowledge').map((d) => [d.slug, d.cloudOptOut ?? false]));

describe('CorpusDoc.cloudOptOut', () => {
  it('is set only by frontmatter `cloud: false`', () => {
    expect(flags(buildCorpus(root))).toEqual({ 'private-note': true, 'open-note': false, 'plain-note': false });
  });

  it('survives the corpus cache, cold and warm', () => {
    const cold = buildCorpusCached(root);
    expect(flags(cold)).toEqual({ 'private-note': true, 'open-note': false, 'plain-note': false });
    const warm = buildCorpusCached(root);
    expect(flags(warm)).toEqual(flags(cold));
    expect(warm).toEqual(buildCorpus(root));
  });

  it('a whiteboard with `cloud: false` is flagged too (when the board parses)', () => {
    const boards = buildCorpus(root, { types: ['whiteboard'] });
    for (const b of boards) expect(b.cloudOptOut).toBe(true);
  });
});
