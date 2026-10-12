import { AutomationError, SOUL_MAX_CHARS } from '../automations/types.js';
import { normalizeSoul, soulProblem } from './soul-templates.js';

/**
 * Pure helpers around an agent's soul: the write-time validator and the two
 * one-line summaries the roster card shows. The templates and the rule itself
 * live in the self-contained `soul-templates.ts`, which the dashboard mirrors.
 */

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A leading list marker on one line: `-`, `*`, `•`, or `1.` / `1)`, followed by a space. */
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** The soul flattened to one line, at most `max` chars with an ellipsis; '' when none. Each
 *  line loses its list marker first, so a bulleted soul reads as sentences on a card, not as
 *  "…yourself. - Lead with…". */
export function soulExcerpt(s: string, max = 160): string {
  const flat = s.split('\n').map((line) => line.replace(LIST_MARKER, '')).join(' ');
  return clip(flat.replace(/\s+/g, ' ').trim(), max);
}

/** The first non-empty line of the prompt, leading markdown markers stripped, at most `max` chars. */
export function roleLineOf(prompt: string, max = 90): string {
  for (const raw of prompt.split('\n')) {
    const line = raw.replace(/^[\s#>*-]+/, '').trim();
    if (line) return clip(line, max);
  }
  return '';
}

/** The soul as it will be written (see `normalizeSoul`), or an `AutomationError`. */
export function validateSoul(s: string): string {
  const problem = soulProblem(s);
  if (problem === 'too-long') {
    throw new AutomationError(`A soul is at most ${SOUL_MAX_CHARS.toLocaleString('en-US')} characters.`);
  }
  if (problem === 'heading-line') {
    throw new AutomationError('A soul cannot contain a line that starts with "## " (it would end the section). Use "###" or plain text.');
  }
  return normalizeSoul(s);
}
