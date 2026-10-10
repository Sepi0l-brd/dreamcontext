import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRecallTier } from '../../src/cli/commands/doctor.js';
import { grantVaultConsent, setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dr-home-'));
  root = mkdtempSync(join(tmpdir(), 'dr-root-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('doctor: Recall tier', () => {
  it('is ok and local when cloud recall was never enabled', () => {
    const [r] = checkRecallTier(root, home);
    expect(r.status).toBe('ok');
    expect(r.message).toContain('local');
  });

  it('warns about an unbuilt index for a fresh CLI grant', () => {
    setRecallCloudKey('sk-fake-key-for-doctor-0123456789', 'manual', home);
    grantVaultConsent(root, { tier: 'cloud', rerankModel: 'voyageai/rerank-2.5-lite', surface: 'cli-tty' }, home);
    const [r] = checkRecallTier(root, home);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('cloud index is not built');
    expect(r.message).not.toContain('dashboard');
  });

  it('flags a grant made from the dashboard', () => {
    setRecallCloudKey('sk-fake-key-for-doctor-0123456789', 'manual', home);
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: null, surface: 'dashboard' }, home);
    const [r] = checkRecallTier(root, home);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('granted from the dashboard');
    expect(r.supportedFixes).toContain('dreamcontext recall cloud status');
  });

  it('warns when consent exists but the key is gone, without printing a key', () => {
    setRecallCloudKey('sk-fake-key-for-doctor-0123456789', 'manual', home);
    grantVaultConsent(root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, home);
    setRecallCloudKey(null, 'manual', home);
    const [r] = checkRecallTier(root, home);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('no recall key');
    expect(JSON.stringify(r)).not.toContain('sk-fake');
  });
});
