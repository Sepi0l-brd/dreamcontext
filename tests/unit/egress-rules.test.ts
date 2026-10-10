import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFields, type CorpusDoc, type CorpusType } from '../../src/lib/recall.js';
import type { Chunk } from '../../src/lib/embeddings/chunker.js';
import {
  CLOUD_ELIGIBLE_TYPES,
  QUERY_CHAR_CAP,
  RERANK_TEXT_CHAR_CAP,
  SECRET_PATTERNS,
  applyRerank,
  capQuery,
  eligibleTypesHash,
  isCloudEligibleChunk,
  isCloudEligibleDoc,
  isDocUnderRoot,
  pickBestChunkLexical,
  rerankCandidateText,
  scanSecrets,
  type SecretRule,
} from '../../src/lib/embeddings/egress-rules.js';

let tmp: string;
let root: string;

function mkDoc(slug: string, body: string, over: Partial<CorpusDoc> = {}, file?: string): CorpusDoc {
  const path = file ?? join(root, 'knowledge', `${slug}.md`);
  if (!file) {
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(path, body);
  }
  const f = buildFields({ slug, title: slug, description: 'desc', tags: [], body });
  return {
    type: 'knowledge' as CorpusType, path, relPath: `knowledge/${slug}.md`, slug, title: slug, description: 'desc',
    tags: [], body, tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq,
    fieldLen: f.fieldLen, links: f.links, identityTokens: f.identityTokens, ...over,
  };
}

const chunk = (seq: number, text: string): Chunk => ({ seq, hash: `h${seq}`, text });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-egress-rules-'));
  root = join(tmp, '_dream_context');
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('scanSecrets', () => {
  // Built from parts so this file never holds a literal that real secret scanners flag.
  const samples: Record<SecretRule, string> = {
    secret_pem: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
    secret_api_token: 'key is ' + 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2',
    secret_github: 'ghp_' + 'A'.repeat(36),
    secret_aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
    secret_slack: 'xoxb-' + '1234567890-abcdefghij',
    secret_jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijk_lmnop'].join('.'),
    secret_assignment: 'password = hunter2hunter2',
  };

  for (const [rule, text] of Object.entries(samples) as Array<[SecretRule, string]>) {
    it(`detects ${rule}`, () => {
      expect(scanSecrets(text)).toBe(rule);
      expect(isCloudEligibleChunk(`prefix text ${text} suffix`)).toBe(rule);
    });
  }

  it('passes ordinary prose, short assignments and repeated calls (no regex state)', () => {
    for (let i = 0; i < 3; i++) {
      expect(scanSecrets('The token budget is small; password = x. See sk-short.')).toBeNull();
      expect(scanSecrets(samples.secret_api_token)).toBe('secret_api_token');
    }
  });

  it('has no global/sticky flags on any pattern', () => {
    for (const re of Object.values(SECRET_PATTERNS)) expect(re.flags).not.toMatch(/[gy]/);
  });
});

describe('capQuery', () => {
  it('scans the FULL prompt before applying the cap', () => {
    const secret = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2';
    const prompt = 'x'.repeat(QUERY_CHAR_CAP + 50) + ' ' + secret;
    expect(capQuery(prompt)).toEqual({ text: null, rule: 'secret_api_token' });
  });

  it('sends the head, capped', () => {
    const prompt = 'a'.repeat(QUERY_CHAR_CAP + 100);
    expect(capQuery(prompt).text).toBe('a'.repeat(QUERY_CHAR_CAP));
    expect(capQuery('short prompt')).toEqual({ text: 'short prompt', rule: null });
  });
});

describe('isDocUnderRoot / isCloudEligibleDoc', () => {
  it('accepts a regular file under the root', () => {
    expect(isDocUnderRoot(mkDoc('a', 'body'), root)).toBe(true);
    expect(isCloudEligibleDoc(mkDoc('a', 'body'), root)).toBeNull();
  });

  it('rejects a symlinked child pointing outside the root', () => {
    const outside = join(tmp, 'outside.md');
    writeFileSync(outside, 'secret outside text');
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    const link = join(root, 'knowledge', 'link.md');
    symlinkSync(outside, link);
    const doc = mkDoc('link', 'secret outside text', {}, link);
    expect(isDocUnderRoot(doc, root)).toBe(false);
    expect(isCloudEligibleDoc(doc, root)).toBe('outside_root');
  });

  it('rejects a doc built from a different root and a doc whose file is gone', () => {
    const other = join(tmp, 'other', '_dream_context');
    mkdirSync(join(other, 'knowledge'), { recursive: true });
    const p = join(other, 'knowledge', 'b.md');
    writeFileSync(p, 'b');
    expect(isDocUnderRoot(mkDoc('b', 'b', {}, p), root)).toBe(false);
    expect(isDocUnderRoot(mkDoc('gone', 'x', {}, join(root, 'knowledge', 'nope.md')), root)).toBe(false);
  });

  it('applies the rules in order: type, capture, federated, cloud:false, whole-doc PEM', () => {
    expect(isCloudEligibleDoc(mkDoc('c1', 'x', { type: 'changelog' }), root)).toBe('type_not_allowed');
    expect(isCloudEligibleDoc(mkDoc('c2', 'x', { type: 'insight' }), root)).toBe('type_not_allowed');
    expect(isCloudEligibleDoc(mkDoc('c3', 'x', { capture: true }), root)).toBe('capture');
    expect(isCloudEligibleDoc(mkDoc('c4', 'x', { federated: true }), root)).toBe('federated');
    expect(isCloudEligibleDoc(mkDoc('c5', 'x', { cloudOptOut: true }), root)).toBe('cloud_false');
    const pemDoc = mkDoc('c6', 'intro\n' + ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') + '\nMIIE...\n');
    expect(isCloudEligibleDoc(pemDoc, root)).toBe('secret_pem');
  });

  it('allow-list is exactly the eight reviewed types', () => {
    expect([...CLOUD_ELIGIBLE_TYPES].sort()).toEqual(
      ['core', 'feature', 'knowledge', 'memory', 'objective', 'task', 'thesis', 'whiteboard'],
    );
  });
});

describe('pickBestChunkLexical', () => {
  it('picks the chunk sharing the most distinct query tokens', () => {
    const chunks = [chunk(0, 'alpha beta'), chunk(1, 'scheduler jobs morning'), chunk(2, 'gateway')];
    expect(pickBestChunkLexical(chunks, 'scheduler jobs')?.seq).toBe(1);
  });
  it('ties go to the lowest seq, regardless of input order; empty → null', () => {
    const chunks = [chunk(2, 'same words'), chunk(0, 'same words'), chunk(1, 'same words')];
    expect(pickBestChunkLexical(chunks, 'same words')?.seq).toBe(0);
    expect(pickBestChunkLexical([], 'q')).toBeNull();
  });
});

describe('rerankCandidateText', () => {
  const mkTitled = () => mkDoc('Title', 'the body text', { type: 'task' });

  it('formats [type] title, then the chunk without its own title line', () => {
    expect(rerankCandidateText(mkTitled(), chunk(0, 'Title\nchunk body'))).toBe('[task] Title\nchunk body');
  });
  it('keeps a chunk whose first line is not the title', () => {
    expect(rerankCandidateText(mkTitled(), chunk(0, 'other\nmore'))).toBe('[task] Title\nother\nmore');
  });
  it('falls back to description + body without a chunk', () => {
    expect(rerankCandidateText(mkTitled(), null)).toBe('[task] Title\ndesc\nthe body text');
  });
  it('cuts at the last whitespace within the cap', () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
    const out = rerankCandidateText(mkTitled(), chunk(0, `Title\n${words}`));
    expect(out.length).toBeLessThanOrEqual(RERANK_TEXT_CHAR_CAP);
    expect(out.length).toBeGreaterThan(RERANK_TEXT_CHAR_CAP - 12);
    expect(words.startsWith(out.slice('[task] Title\n'.length))).toBe(true);
    expect(/\sw?\d*$/.test(out)).toBe(true);
    expect(out.endsWith(' ')).toBe(false);
  });
  it('hard-cuts a single unbroken string', () => {
    expect(rerankCandidateText(mkTitled(), chunk(0, 'Title\n' + 'x'.repeat(5000))).length).toBe(RERANK_TEXT_CHAR_CAP);
  });
});

describe('applyRerank', () => {
  const fused = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => ({ key, fused: 1 - i * 0.1 }));

  it('alpha 1.0 reorders the window by relevance alone and leaves keys below n alone', () => {
    const scores = new Map([['a', 0.1], ['b', 0.9], ['c', 0.5], ['d', 0.7]]);
    expect(applyRerank(fused, scores, 1, 4)).toEqual(['b', 'd', 'c', 'a', 'e', 'f']);
  });

  it('a window key without a score keeps its slot; scored keys fill the rest', () => {
    const scores = new Map([['a', 0.1], ['c', 0.9], ['d', 0.5]]); // b withheld
    expect(applyRerank(fused, scores, 1, 4)).toEqual(['c', 'b', 'd', 'a', 'e', 'f']);
  });

  it('scored keys below n are ignored', () => {
    const scores = new Map([['a', 0.1], ['b', 0.2], ['f', 99]]);
    expect(applyRerank(fused, scores, 1, 2)).toEqual(['b', 'a', 'c', 'd', 'e', 'f']);
  });

  it('alpha 0 keeps fused order; blending sits between', () => {
    const scores = new Map([['a', 0], ['b', 1], ['c', 0.5]]);
    expect(applyRerank(fused, scores, 0, 3)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // a: .7·0 + .3·1 = .3 ; b: .7·1 + .3·.5 = .85 ; c: .7·.5 + 0 = .35
    expect(applyRerank(fused, scores, 0.7, 3).slice(0, 3)).toEqual(['b', 'c', 'a']);
  });

  it('an empty score map changes nothing; equal scores keep fused order (zero span)', () => {
    expect(applyRerank(fused, new Map(), 1, 6)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const flat = new Map([['a', 0.4], ['b', 0.4], ['c', 0.4]]);
    expect(applyRerank(fused, flat, 1, 3)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('n larger than the list, n of 0 and an empty list are safe; every key is returned once', () => {
    const scores = new Map([['a', 0.1], ['f', 0.9]]);
    const out = applyRerank(fused, scores, 1, 99);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(applyRerank(fused, scores, 1, 0)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(applyRerank([], scores, 1, 5)).toEqual([]);
  });
});

describe('eligibleTypesHash', () => {
  it('is stable across calls and a sha256 hex', () => {
    expect(eligibleTypesHash()).toBe(eligibleTypesHash());
    expect(eligibleTypesHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any SECRET_PATTERNS source changes', () => {
    const before = eligibleTypesHash();
    const original = SECRET_PATTERNS.secret_aws;
    try {
      (SECRET_PATTERNS as Record<SecretRule, RegExp>).secret_aws = /\bAKIA[0-9A-Z]{17}\b/;
      expect(eligibleTypesHash()).not.toBe(before);
    } finally {
      (SECRET_PATTERNS as Record<SecretRule, RegExp>).secret_aws = original;
    }
    expect(eligibleTypesHash()).toBe(before);
  });
});
