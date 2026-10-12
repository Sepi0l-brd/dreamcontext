import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOUL_MAX_CHARS,
  SOUL_TEMPLATE_IDS,
  SOUL_TEMPLATES,
  normalizeSoul,
  soulProblem,
  soulTemplate,
} from '../../src/lib/agents/soul-templates.js';
import { roleLineOf, soulExcerpt, validateSoul } from '../../src/lib/agents/soul.js';
import { AutomationError, SOUL_MAX_CHARS as REEXPORTED_MAX } from '../../src/lib/automations/types.js';

/**
 * The dashboard cannot import `src/`, so the soul templates and the soul rule are
 * mirrored byte-identically into dashboard/src/generated/soul-templates.ts. Any
 * drift fails here. Fix: `cp src/lib/agents/soul-templates.ts dashboard/src/generated/`.
 */
const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const OWNER = 'src/lib/agents/soul-templates.ts';
const MIRROR = 'dashboard/src/generated/soul-templates.ts';

describe('soul templates mirror', () => {
  it('the dashboard copy is byte-identical to the owner', () => {
    expect(read(MIRROR)).toBe(read(OWNER));
  });

  it('the owner stays self-contained (no imports, so the copy compiles in the dashboard)', () => {
    expect(read(OWNER)).not.toMatch(/^\s*import\s/m);
    expect(read(OWNER)).not.toMatch(/\brequire\(/);
  });

  it('five ids, in order, each with a non-empty text under the cap and no em dash', () => {
    expect([...SOUL_TEMPLATE_IDS]).toEqual(['harsh-reviewer', 'fast-doer', 'careful-researcher', 'plain-writer', 'calm-helper']);
    expect(SOUL_TEMPLATES.map((t) => t.id)).toEqual([...SOUL_TEMPLATE_IDS]);
    for (const t of SOUL_TEMPLATES) {
      expect(t.text.trim().length).toBeGreaterThan(0);
      expect(t.text.length).toBeLessThanOrEqual(SOUL_MAX_CHARS);
      expect(t.text).not.toContain('—');
      expect(t.label).not.toContain('—');
      expect(soulProblem(t.text)).toBeNull();
    }
    expect(read(OWNER)).not.toContain('—');
  });

  it('soulTemplate finds by id and returns null for an unknown one', () => {
    expect(soulTemplate('fast-doer')?.label).toBe('Fast doer');
    expect(soulTemplate('nope')).toBeNull();
  });

  it('types.ts re-exports the one cap', () => {
    expect(REEXPORTED_MAX).toBe(2000);
    expect(SOUL_MAX_CHARS).toBe(2000);
  });
});

describe('the soul rule', () => {
  it('a "## x" line is a heading-line, also indented; "### x" is fine', () => {
    expect(soulProblem('Be terse.\n## Tone\nDry.')).toBe('heading-line');
    expect(soulProblem('Be terse.\n   ## Tone')).toBe('heading-line');
    expect(soulProblem('Be terse.\n### Tone\nDry.')).toBeNull();
    // P8: the reader ends a section on the UNtrimmed line, so "## " and "##\t" (which trim to "##") count.
    expect(soulProblem('Be calm.\n## \nNever push to main.')).toBe('heading-line');
    expect(soulProblem('Be calm.\n##\t\nNever push to main.')).toBe('heading-line');
    expect(soulProblem('Be calm.\n  ## x\nNever push to main.')).toBe('heading-line');
    expect(soulProblem('Be calm.\n##\nNever push to main.')).toBeNull();
    expect(soulProblem('##no space is not a heading')).toBeNull();
  });

  it('2001 chars is too-long; 2000 is fine (after normalisation)', () => {
    expect(soulProblem('a'.repeat(2001))).toBe('too-long');
    expect(soulProblem('a'.repeat(2000))).toBeNull();
    expect(soulProblem(`  ${'a'.repeat(2000)}\n\n`)).toBeNull();
  });

  it('normalizeSoul strips NULs, turns CRLF into LF and trims', () => {
    expect(normalizeSoul('  Be\0 terse.\r\nNo praise.\r\n\n')).toBe('Be terse.\nNo praise.');
  });

  it('validateSoul returns the normalised soul or throws an AutomationError with the plan message', () => {
    expect(validateSoul(' Be terse.\r\n')).toBe('Be terse.');
    expect(() => validateSoul('a'.repeat(2001))).toThrow(new AutomationError('A soul is at most 2,000 characters.'));
    expect(() => validateSoul('## Tone')).toThrow(/cannot contain a line that starts with "## "/);
  });
});

describe('summaries', () => {
  it('soulExcerpt drops a leading list marker from every line, and only a leading one', () => {
    expect(soulExcerpt('Lead.\n- One.\n* Two.\n• Three.\n1. Four.\n12) Five.\n  - Six.')).toBe('Lead. One. Two. Three. Four. Five. Six.');
    // Not a marker: no space after it, or not at the start of the line.
    expect(soulExcerpt('**Bold** stays.\n-5 degrees.\nA - B.\n2026 was fine.')).toBe('**Bold** stays. -5 degrees. A - B. 2026 was fine.');
    // Every template reads as sentences on a card.
    for (const t of SOUL_TEMPLATES) expect(soulExcerpt(t.text, 2000)).not.toMatch(/(^|\s)[-*•] /);
  });

  it('soulExcerpt flattens to one line, caps at 160 with an ellipsis, and is empty for no soul', () => {
    expect(soulExcerpt('')).toBe('');
    expect(soulExcerpt('Be terse.\n- No praise.')).toBe('Be terse. No praise.');
    const long = soulExcerpt('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toContain('\n');
  });

  it('roleLineOf takes the first non-empty line without markdown markers, capped at 90', () => {
    expect(roleLineOf('\n\n# Summarise the day\nMore.')).toBe('Summarise the day');
    expect(roleLineOf('- > Review pull requests')).toBe('Review pull requests');
    expect(roleLineOf('')).toBe('');
    expect(roleLineOf('x'.repeat(200)).length).toBeLessThanOrEqual(90);
  });
});
