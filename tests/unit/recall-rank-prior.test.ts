import { describe, it, expect } from 'vitest';
import {
  applyDocRankPrior,
  bm25Search,
  buildFields,
  docRankPrior,
  recencyMultiplier,
  snippetFor,
  STATUS_PENALTY,
  CAPTURE_RANK_PENALTY,
  CHANGELOG_RANK_FACTOR,
  BOARD_RANK_FACTOR,
  type CorpusDoc,
  type CorpusType,
} from '../../src/lib/recall.js';

const NOW = new Date('2026-10-10T00:00:00Z');

function mk(slug: string, body: string, extra: Partial<CorpusDoc> = {}): CorpusDoc {
  const f = buildFields({ slug, title: slug, description: '', tags: [], body });
  return {
    type: 'knowledge' as CorpusType, path: `/x/${slug}.md`, relPath: `knowledge/${slug}.md`, slug, title: slug,
    description: '', tags: [], body, tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq,
    fieldFreq: f.fieldFreq, fieldLen: f.fieldLen, links: f.links, identityTokens: f.identityTokens,
    updatedAt: '2026-10-01', ...extra,
  };
}

describe('docRankPrior', () => {
  it('is the product of status, recency, capture and kind factors', () => {
    const doc = mk('a', 'x y z', { status: 'completed', capture: true, type: 'changelog' });
    const expected = STATUS_PENALTY.completed * recencyMultiplier(doc.updatedAt, NOW) * CAPTURE_RANK_PENALTY * CHANGELOG_RANK_FACTOR;
    expect(docRankPrior(doc, NOW)).toBeCloseTo(expected, 12);
  });

  it('boards take the board factor, plain prose takes none', () => {
    const board = mk('b', 'labels', { type: 'whiteboard' });
    const prose = mk('p', 'labels');
    expect(docRankPrior(board, NOW) / docRankPrior(prose, NOW)).toBeCloseTo(BOARD_RANK_FACTOR, 12);
  });

  it('applyDocRankPrior(1, …) is docRankPrior, and scales linearly in the base', () => {
    const doc = mk('alpha', 'x', { status: 'completed' });
    expect(applyDocRankPrior(1, doc, NOW)).toBe(docRankPrior(doc, NOW));
    expect(applyDocRankPrior(4, doc, NOW)).toBeCloseTo(4 * docRankPrior(doc, NOW), 12);
  });

  it('bm25Search ranks a completed doc below an identical active one (prior applied once)', () => {
    const docs = [mk('alpha', 'scheduler jobs run', { status: 'completed' }), mk('beta', 'scheduler jobs run')];
    const hits = bm25Search('scheduler jobs', docs, 5, { now: NOW });
    const byslug = Object.fromEntries(hits.map((h) => [h.doc.slug, h]));
    expect(byslug.alpha.score).toBe(byslug.beta.score);
    expect(byslug.alpha.rankScore).toBeLessThan(byslug.beta.rankScore);
  });
});

describe('snippetFor', () => {
  it('equals the snippet bm25Search attaches for the same query', () => {
    const docs = [mk('alpha', 'first line\nthe scheduler runs jobs\nthird line\nfourth')];
    const hit = bm25Search('scheduler jobs', docs, 1, { now: NOW })[0];
    expect(snippetFor(docs[0], 'scheduler jobs')).toBe(hit.snippet);
  });
});
