import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli/program.js';
import { getAgent, recordAgentLesson } from '../../src/lib/agents/store.js';
import { SOUL_TEMPLATE_IDS, soulTemplate } from '../../src/lib/agents/soul-templates.js';

/**
 * `agents create|edit --soul / --soul-file / --soul-template` and `agents show`, through the
 * real command tree, under a fake HOME (create approves on this machine).
 */

let projectRoot: string;
let contextRoot: string;
let cwd: string;
let realHome: string | undefined;
let fakeHome: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

function sub(name: string): Command {
  const agents = createProgram().commands.find((c) => c.name() === 'agents')!;
  return agents.commands.find((c) => c.name() === name)!;
}

const agentFile = (slug: string) => readFileSync(join(contextRoot, 'agents', `${slug}.md`), 'utf-8');

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-soul-cli-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  process.chdir(projectRoot);
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-soul-cli-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('agents create --soul-template / --soul-file / --soul', () => {
  it('a template writes exactly its text, and nothing records which template it was', async () => {
    const { code } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul-template', 'harsh-reviewer']);
    expect(code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe(soulTemplate('harsh-reviewer')!.text);
    expect(agentFile('x')).not.toContain('harsh-reviewer');
  });

  it('--soul-file reads the soul from a file', async () => {
    const file = join(projectRoot, 'soul.md');
    writeFileSync(file, 'Be calm.\n### Tone\nDry.\n');
    const { code } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul-file', file]);
    expect(code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe('Be calm.\n### Tone\nDry.');
  });

  it('two soul flags fail with exit 1 and write nothing', async () => {
    const { code, out } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul', 'A', '--soul-template', 'fast-doer']);
    expect(code).toBe(1);
    expect(out).toContain('--soul, --soul-file and --soul-template');
    expect(getAgent(contextRoot, 'x')).toBeNull();
  });

  it('an unknown template exits 1 and names all five ids; --help lists them', async () => {
    const { code, out } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul-template', 'nope']);
    expect(code).toBe(1);
    for (const id of SOUL_TEMPLATE_IDS) expect(out).toContain(id);
    const help = sub('create').helpInformation();
    for (const id of SOUL_TEMPLATE_IDS) expect(help).toContain(id);
    expect(sub('edit').helpInformation()).toContain('--soul-template');
  });

  it('P8: a soul with a "## " line exits 1 and writes nothing', async () => {
    const { code } = await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul', 'Be terse.\n## Tone']);
    expect(code).toBe(1);
    expect(getAgent(contextRoot, 'x')).toBeNull();
  });
});

describe('agents edit and show', () => {
  it('edit --soul sets it, edit --soul "" clears it', async () => {
    await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P']);
    expect((await run(['agents', 'edit', 'x', '--soul', 'Be calm.'])).code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe('Be calm.');
    expect((await run(['agents', 'edit', 'x', '--soul', ''])).code).toBe(0);
    expect(getAgent(contextRoot, 'x')?.soul).toBe('');
    expect(agentFile('x')).not.toContain('## Soul');
  });

  it('show --json carries the soul and the parsed pattern; plain show prints both', async () => {
    await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--soul', 'Be calm.']);
    recordAgentLesson(contextRoot, 'x', { lesson: 'Check the date.', now: new Date('2026-10-01T09:00:00Z') });
    const json = await run(['agents', 'show', 'x', '--json']);
    const parsed = JSON.parse(json.out) as { agent: { soul: string; pattern: { playbook: string; lessons: unknown[] } } };
    expect(parsed.agent.soul).toBe('Be calm.');
    expect(parsed.agent.pattern).toEqual({ playbook: '', lessons: [{ date: '2026-10-01', text: 'Check the date.' }] });
    const plain = await run(['agents', 'show', 'x']);
    expect(plain.out).toContain('soul:');
    expect(plain.out).toContain('Be calm.');
    expect(plain.out).toContain('pattern: 1 lessons, playbook empty');
  });
});
