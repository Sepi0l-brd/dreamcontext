import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { RESERVED_SLUGS, type AutomationSlot } from '../automations/types.js';

/**
 * The automation SLOT — what sits at `automations/<slug>.md` — and the one way
 * every module reads a manifest's frontmatter.
 *
 * Imported by the approval registry and by both stores, so it imports neither:
 * only the contract root and the frontmatter library. That keeps the registry
 * free of `store.ts` (its own rule) while it re-classifies a slot inside its
 * writes.
 *
 * ONE parser and ONE `agent:` predicate on purpose. If `classifyAutomationSlot`
 * and `readAutomationFile` disagreed about a single edge input (an empty
 * `agent:`, a quoted `mode: "call"`, a duplicated key), the registry would decide
 * one thing about a file and the runner would run another.
 */

/** The brain folder inside a project. Mirrors `src/lib/context-path.ts`. */
export const CONTEXT_DIR_NAME = '_dream_context';

/** The contextRoot of a project root, as every caller of the registry derives
 *  its projectRoot: `dirname(contextRoot)`. */
export function contextRootOf(projectRoot: string): string {
  return join(projectRoot, CONTEXT_DIR_NAME);
}

/** Kebab-case, path-safe automation or agent slug (lab's rule, plus the
 *  reserved sibling-directory names `cache`/`output`/`review`/`hitl` — manifests
 *  are flat, so a slug shares a namespace with those directories). */
export function isSafeAutomationSlug(slug: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false;
  if (slug.includes('--')) return false;
  if (slug.endsWith('-')) return false;
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) return false;
  return true;
}

export interface ManifestFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Parse a manifest's text. THROWS on YAML it cannot read (a duplicated key
 * included), exactly as `readFrontmatter` always has, so a reader that skipped a
 * broken manifest still skips it. A leading BOM is stripped by gray-matter.
 *
 * Passes an (empty) options object on purpose: gray-matter caches a file by its
 * text BEFORE parsing it, so without options a manifest whose YAML throws once
 * reads as an empty, frontmatter-less file on every later read in the same
 * process. A slot would then flip from `'unreadable'` to `'automation'` on its
 * second classification — exactly the kind of drift between two reads the
 * approval registry cannot afford. With options, gray-matter never caches.
 */
export function parseManifestFrontmatter(raw: string): ManifestFrontmatter {
  const parsed = matter(raw, {});
  const data = parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>) : {};
  return { data, content: parsed.content };
}

/**
 * Read a manifest WITHOUT following a symlink: `null` for a symlink, a
 * non-file, an unreadable file or unparseable YAML. Never throws.
 */
export function readManifestFrontmatter(path: string): ManifestFrontmatter | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return parseManifestFrontmatter(readFileSync(path, 'utf-8'));
  } catch {
    // Missing, unreadable or unparseable: the caller treats all three as "no
    // usable manifest here", and the slot classifier tells them apart itself.
    return null;
  }
}

/**
 * The `agent:` key of a manifest's frontmatter.
 *
 * A discriminated object rather than a bare string so that an agent literally
 * named `none` can never read as "no agent".
 *  - `none`    — no `agent` key at all: a legacy (unsplit) manifest.
 *  - `invalid` — the key is present but empty, null, not a string, or not a safe
 *                slug. Never read as legacy: that would let a broken value
 *                resurrect a legacy approval.
 *  - `agent`   — a new-format automation bound to `slug`.
 */
export type AgentKey = { kind: 'none' } | { kind: 'invalid' } | { kind: 'agent'; slug: string };

export function agentKeyOf(data: Record<string, unknown>): AgentKey {
  if (!Object.prototype.hasOwnProperty.call(data, 'agent')) return { kind: 'none' };
  const v = data.agent;
  if (typeof v !== 'string') return { kind: 'invalid' };
  const slug = v.trim();
  return isSafeAutomationSlug(slug) ? { kind: 'agent', slug } : { kind: 'invalid' };
}

/** `mode: call`, read exactly as `parseAutomationMode` reads it: only the exact
 *  string `call` (a quoted `"call"` is the same string after YAML). */
export function isCallMode(data: Record<string, unknown>): boolean {
  return data.mode === 'call';
}

/** The slot a successfully parsed regular file occupies. */
export function slotFromFrontmatter(data: Record<string, unknown>): Exclude<AutomationSlot, 'absent'> {
  const key = agentKeyOf(data);
  if (key.kind === 'invalid') return 'unreadable';
  if (key.kind === 'agent') return 'automation';
  return isCallMode(data) ? 'legacy-call' : 'automation';
}

/**
 * Classify `automations/<slug>.md` with `lstat` and the shared parser — never
 * through `getAutomation`, whose `null` cannot tell "nothing here" from "a file
 * I could not read". Never throws.
 */
export function classifyAutomationSlot(contextRoot: string, slug: string): AutomationSlot {
  if (!isSafeAutomationSlug(slug)) return 'unreadable';
  const path = join(contextRoot, 'automations', `${slug}.md`);
  try {
    lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  const fm = readManifestFrontmatter(path);
  return fm === null ? 'unreadable' : slotFromFrontmatter(fm.data);
}
