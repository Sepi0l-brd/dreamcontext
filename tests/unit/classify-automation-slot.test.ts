/**
 * The automation SLOT and the one frontmatter parser behind it.
 *
 * `classifyAutomationSlot` decides whether an agent's legacy approval record may be
 * honoured (rule (b)) and whether an approval write deletes it (Invariant 2), so every
 * edge input is pinned here, through real files on disk. The same parser and the same
 * `agent:` predicate feed `readAutomationFile`, and the last block proves the two agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentKeyOf,
  classifyAutomationSlot,
  contextRootOf,
  isSafeAutomationSlug as slotIsSafe,
  parseManifestFrontmatter,
  readManifestFrontmatter,
} from '../../src/lib/agents/slot.js';
import { isSafeAutomationSlug as storeIsSafe, readAutomationFile } from '../../src/lib/automations/store.js';
import { isLegacyAutomation } from '../../src/lib/agents/compose.js';

let projectRoot: string;
let contextRoot: string;
let dir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-slot-'));
  contextRoot = join(projectRoot, '_dream_context');
  dir = join(contextRoot, 'automations');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function manifest(slug: string, frontmatter: string, body = '## Prompt\nDo the thing.\n'): string {
  const path = join(dir, `${slug}.md`);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}`);
  return path;
}

describe('classifyAutomationSlot', () => {
  it("'absent' when nothing is at the path", () => {
    expect(classifyAutomationSlot(contextRoot, 'nobody')).toBe('absent');
  });

  it("'absent' when the automations folder itself does not exist", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(classifyAutomationSlot(contextRoot, 'nobody')).toBe('absent');
  });

  it("'legacy-call' for an unsplit on-call manifest (no agent: key, mode: call)", () => {
    manifest('helper', 'id: auto_x\ntitle: Helper\nmode: call');
    expect(classifyAutomationSlot(contextRoot, 'helper')).toBe('legacy-call');
  });

  it("'legacy-call' when mode is the quoted string \"call\" (the same string after YAML)", () => {
    manifest('helper', 'title: Helper\nmode: "call"');
    expect(classifyAutomationSlot(contextRoot, 'helper')).toBe('legacy-call');
  });

  it("'automation' for an unsplit scheduled manifest, and for one with no mode at all", () => {
    manifest('digest', 'title: Digest\nmode: sched');
    manifest('older', 'title: Older');
    expect(classifyAutomationSlot(contextRoot, 'digest')).toBe('automation');
    expect(classifyAutomationSlot(contextRoot, 'older')).toBe('automation');
  });

  it("'automation' for a case variant of call: only the exact string is call, as parseAutomationMode reads it", () => {
    manifest('helper', 'title: Helper\nmode: Call');
    expect(classifyAutomationSlot(contextRoot, 'helper')).toBe('automation');
  });

  it("'automation' for a new-format automation bound to an agent — even one written with mode: call", () => {
    manifest('digest', 'title: Digest\nagent: researcher\nmode: sched');
    manifest('pair', 'title: Pair\nagent: pair\nmode: call');
    expect(classifyAutomationSlot(contextRoot, 'digest')).toBe('automation');
    expect(classifyAutomationSlot(contextRoot, 'pair')).toBe('automation');
  });

  it("'unreadable' for an agent: key that is empty, null, not a string, or not a safe slug", () => {
    manifest('a', 'title: A\nagent: ""\nmode: call');
    manifest('b', 'title: B\nagent:\nmode: call');
    manifest('c', 'title: C\nagent: 42\nmode: call');
    manifest('d', 'title: D\nagent: Bad Slug\nmode: call');
    manifest('e', 'title: E\nagent: "../escape"\nmode: call');
    for (const slug of ['a', 'b', 'c', 'd', 'e']) {
      expect(classifyAutomationSlot(contextRoot, slug)).toBe('unreadable');
    }
  });

  it("'unreadable' for a duplicated mode: key (YAML refuses it)", () => {
    manifest('helper', 'title: Helper\nmode: sched\nmode: call');
    expect(classifyAutomationSlot(contextRoot, 'helper')).toBe('unreadable');
  });

  it("'unreadable' for frontmatter that is not YAML", () => {
    manifest('broken', 'title: [unclosed\nmode: call');
    expect(classifyAutomationSlot(contextRoot, 'broken')).toBe('unreadable');
  });

  it('a leading BOM and CRLF line endings classify exactly like the plain file', () => {
    writeFileSync(join(dir, 'bom.md'), '﻿---\ntitle: Helper\nmode: call\n---\n\n## Prompt\nx\n');
    writeFileSync(join(dir, 'crlf.md'), '---\r\ntitle: Helper\r\nmode: call\r\n---\r\n\r\n## Prompt\r\nx\r\n');
    expect(classifyAutomationSlot(contextRoot, 'bom')).toBe('legacy-call');
    expect(classifyAutomationSlot(contextRoot, 'crlf')).toBe('legacy-call');
  });

  it("'unreadable' for a symlink — even one pointing at a perfectly valid on-call manifest", () => {
    const real = join(projectRoot, 'elsewhere.md');
    writeFileSync(real, '---\ntitle: Helper\nmode: call\n---\n\n## Prompt\nx\n');
    symlinkSync(real, join(dir, 'helper.md'));
    expect(classifyAutomationSlot(contextRoot, 'helper')).toBe('unreadable');
  });

  it("'unreadable' for a directory sitting at the manifest path", () => {
    mkdirSync(join(dir, 'odd.md'));
    expect(classifyAutomationSlot(contextRoot, 'odd')).toBe('unreadable');
  });

  it("'unreadable' for a slug that is not safe (never a path to look at)", () => {
    expect(classifyAutomationSlot(contextRoot, '../escape')).toBe('unreadable');
    expect(classifyAutomationSlot(contextRoot, 'cache')).toBe('unreadable');
  });
});

describe('agentKeyOf — one predicate, discriminated so an agent named "none" is still an agent', () => {
  it('none / invalid / agent', () => {
    expect(agentKeyOf({ title: 'x' })).toEqual({ kind: 'none' });
    expect(agentKeyOf({ agent: '' })).toEqual({ kind: 'invalid' });
    expect(agentKeyOf({ agent: null })).toEqual({ kind: 'invalid' });
    expect(agentKeyOf({ agent: ' researcher ' })).toEqual({ kind: 'agent', slug: 'researcher' });
    expect(agentKeyOf({ agent: 'none' })).toEqual({ kind: 'agent', slug: 'none' });
  });

  it('isLegacyAutomation is exactly "no agent key"', () => {
    expect(isLegacyAutomation({ mode: 'call' })).toBe(true);
    expect(isLegacyAutomation({ agent: 'x' })).toBe(false);
    // A broken key is NOT legacy: reading it as legacy would let a bad value
    // resurrect a legacy approval.
    expect(isLegacyAutomation({ agent: '' })).toBe(false);
  });
});

describe('readManifestFrontmatter never follows a symlink and never throws', () => {
  it('null for a symlink, a missing file and broken YAML; parsed data otherwise', () => {
    const real = manifest('real', 'title: Real\nmode: call');
    symlinkSync(real, join(dir, 'link.md'));
    manifest('broken', 'title: [unclosed');
    expect(readManifestFrontmatter(join(dir, 'link.md'))).toBeNull();
    expect(readManifestFrontmatter(join(dir, 'missing.md'))).toBeNull();
    expect(readManifestFrontmatter(join(dir, 'broken.md'))).toBeNull();
    expect(readManifestFrontmatter(real)?.data).toMatchObject({ title: 'Real', mode: 'call' });
  });

  it('parseManifestFrontmatter throws on a duplicated key, as readFrontmatter always did', () => {
    expect(() => parseManifestFrontmatter('---\nmode: a\nmode: b\n---\nbody')).toThrow();
  });
});

describe('the slug rule and the context root live in slot.ts, and store.ts re-exports the same function', () => {
  it('one function, not a copy', () => {
    expect(storeIsSafe).toBe(slotIsSafe);
    expect(slotIsSafe('funnel-watcher')).toBe(true);
    expect(slotIsSafe('hitl')).toBe(false);
    expect(slotIsSafe('a--b')).toBe(false);
  });

  it('contextRootOf joins the brain folder onto the project root', () => {
    expect(contextRootOf('/p/alpha')).toBe(join('/p/alpha', '_dream_context'));
  });
});

describe('readAutomationFile agrees with the classifier (one parser, one predicate)', () => {
  it('fills the run-target fields with the behaviour-neutral defaults', () => {
    const path = manifest('digest', 'id: auto_d1\ntitle: Digest\nmode: sched');
    const m = readAutomationFile(path);
    expect(m.runKind).toBe('automation');
    expect(m.agent).toBe('digest');
    expect(m.agentTitle).toBe('Digest');
    expect(m.job).toBe('');
    expect(m.bindings).toEqual([]);
    expect(m.legacyKey).toBe(false);
  });

  it('sets legacyKey exactly when the classifier says legacy-call', () => {
    const cases: Array<[string, string]> = [
      ['helper', 'title: Helper\nmode: call'],
      ['quoted', 'title: Quoted\nmode: "call"'],
      ['digest', 'title: Digest\nmode: sched'],
      ['bound', 'title: Bound\nagent: researcher\nmode: call'],
    ];
    for (const [slug, fm] of cases) {
      const m = readAutomationFile(manifest(slug, fm));
      expect(m.legacyKey).toBe(classifyAutomationSlot(contextRoot, slug) === 'legacy-call');
    }
  });

  it('still throws on a duplicated key, so listAutomations keeps skipping it', () => {
    const path = manifest('dup', 'title: Dup\nmode: sched\nmode: call');
    expect(() => readAutomationFile(path)).toThrow();
  });

  it('a broken manifest stays broken on every read, not just the first (no parse cache)', () => {
    // gray-matter caches a text before parsing it; without the fix the second
    // read of the same broken text returned an empty, frontmatter-less file and
    // the slot flipped from 'unreadable' to 'automation'.
    const path = manifest('flaky', 'title: Flaky\nmode: call\nmode: call');
    expect(classifyAutomationSlot(contextRoot, 'flaky')).toBe('unreadable');
    expect(classifyAutomationSlot(contextRoot, 'flaky')).toBe('unreadable');
    expect(() => readAutomationFile(path)).toThrow();
    expect(() => readAutomationFile(path)).toThrow();
  });
});
