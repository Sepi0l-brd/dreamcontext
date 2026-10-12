/**
 * The `agent` recall channel: indexed locally from `agents/<slug>.md`, never cloud-eligible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bm25Search, buildCorpus, CORPUS_TYPES, docKey } from '../../src/lib/recall.js';
import { CLOUD_ELIGIBLE_TYPES } from '../../src/lib/embeddings/egress-rules.js';
import { TYPE_LABELS, parseTypes } from '../../src/cli/commands/memory.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-agents-recall-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'scout.md'), [
    '---', 'id: agt_s1', 'title: Market scout', '---', '', '## Prompt', '', 'You track narwhal-themed competitor launches.', '',
  ].join('\n'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('agent recall channel', () => {
  it('is a corpus type the CLI parses and labels', () => {
    expect(CORPUS_TYPES).toContain('agent');
    expect(TYPE_LABELS.agent).toBe('agent');
    expect(parseTypes('agent')).toEqual(['agent']);
  });

  it('indexes agents/*.md locally and finds an agent by its prompt', () => {
    const corpus = buildCorpus(root, { types: ['agent'] });
    expect(corpus.map(docKey)).toHaveLength(1);
    expect(corpus[0].type).toBe('agent');
    const hits = bm25Search('narwhal competitor launches', buildCorpus(root), 5);
    expect(hits[0]?.doc.type).toBe('agent');
  });

  it('is withheld from cloud egress (not in the allow-list)', () => {
    expect((CLOUD_ELIGIBLE_TYPES as readonly string[]).includes('agent')).toBe(false);
  });
});
