import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRecallOptionsRoutes } from '../../src/server/routes/recall-options.js';
import { setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';
import { RECALL_MEASUREMENTS } from '../../src/lib/recall-measurements.js';
import type { CorpusDoc } from '../../src/lib/recall.js';

/** `GET /api/recall/options`: the same guard as the cloud status route, the measurements, a recommendation, never a key. */

const HOST = '127.0.0.1:4173';
const KEY = 'sk-or-v1-PLANTED-RECALL-KEY-0123456789';
const GIB = 1024 ** 3;
const ENV = ['DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'OPENROUTER_API_KEY'];

interface Opts { host?: string; origin?: string | null; remote?: string }

function get(o: Opts = {}): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  const headers: Record<string, string> = { host: o.host ?? HOST };
  if (o.origin) headers.origin = o.origin;
  Object.assign(stream, { method: 'GET', url: '/api/recall/options', headers, socket: { remoteAddress: o.remote ?? '127.0.0.1' } });
  return stream;
}

async function call(h: ReturnType<typeof createRecallOptionsRoutes>['options'], q: IncomingMessage, root: string) {
  const out = { status: 0, text: '' };
  const r = { writeHead(c: number) { out.status = c; return r; }, end(b?: string) { out.text = b ?? ''; } };
  await h(q, r as unknown as ServerResponse, {}, root);
  return { status: out.status, text: out.text, json: JSON.parse(out.text) as Record<string, unknown> };
}

const doc = (body: string) => ({ title: 't', description: '', body }) as unknown as CorpusDoc;
const TURKISH = 'Kullanıcı ayarlarını değiştirdiğinde panel yeniden yüklenir ve işlem sırasında hiçbir veri dışarı gönderilmez. Öğrenciler için güvenli bir çözüm.';

let tmp: string;
let home: string;
let root: string;

const routesWith = (docs: CorpusDoc[], hw = { totalMemBytes: 32 * GIB, cpuCount: 10, modelName: null as string | null }) =>
  createRecallOptionsRoutes({ home, loadCorpus: () => docs, hardware: () => hw });

beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, '');
  tmp = mkdtempSync(join(tmpdir(), 'dc-recall-options-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the guard', () => {
  it('refuses a foreign Origin', async () => {
    expect((await call(routesWith([]).options, get({ origin: 'https://evil.example' }), root)).status).toBe(403);
  });
  it('refuses DNS rebinding and a Host without a port', async () => {
    expect((await call(routesWith([]).options, get({ host: 'evil.example:4173', origin: 'http://evil.example:4173' }), root)).status).toBe(403);
    expect((await call(routesWith([]).options, get({ host: '127.0.0.1' }), root)).status).toBe(403);
  });
  it('refuses the hands-free cloud', async () => {
    vi.stubEnv('DREAMCONTEXT_CLOUD', '1');
    const r = await call(routesWith([]).options, get(), root);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('cloud_unavailable');
  });
  it('allows a same-origin read (no Origin) and a matching Origin', async () => {
    expect((await call(routesWith([]).options, get(), root)).status).toBe(200);
    expect((await call(routesWith([]).options, get({ origin: `http://${HOST}` }), root)).status).toBe(200);
  });
  it('needs a vault', async () => {
    expect((await call(routesWith([]).options, get(), '')).status).toBe(400);
  });
});

describe('the answer', () => {
  it('carries the measurements and a recommendation from the brain\'s language', async () => {
    const r = await call(routesWith([doc(TURKISH), doc(TURKISH)]).options, get(), root);
    expect(r.status).toBe(200);
    expect(r.json.measurements).toEqual(RECALL_MEASUREMENTS);
    expect(r.json.recommendation).toMatchObject({ option: 'cloud', reason: 'turkish-brain', keyPresent: false });
    expect(r.json.signals).toMatchObject({ languageMix: 'turkish', turkishSharePct: 100, machineClass: 'standard', keyPresent: false });
  });
  it('keeps the default when the corpus cannot be read', async () => {
    const routes = createRecallOptionsRoutes({
      home,
      loadCorpus: () => { throw new Error('/secret/path'); },
      hardware: () => ({ totalMemBytes: 32 * GIB, cpuCount: 10, modelName: null }),
    });
    const r = await call(routes.options, get(), root);
    expect(r.status).toBe(200);
    expect(r.json.recommendation).toMatchObject({ option: 'haiku', reason: 'no-language-signal' });
    expect(r.text).not.toContain('/secret/path');
  });
  it('says a key exists without ever returning it', async () => {
    setRecallCloudKey(KEY, 'manual', home);
    const r = await call(routesWith([doc(TURKISH)]).options, get(), root);
    expect(r.json.signals).toMatchObject({ keyPresent: true });
    expect(r.json.recommendation).toMatchObject({ keyPresent: true });
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain('PLANTED');
  });
  it('a light machine is told so', async () => {
    const r = await call(routesWith([doc(TURKISH)], { totalMemBytes: 8 * GIB, cpuCount: 8, modelName: null }).options, get(), root);
    expect(r.json.recommendation).toMatchObject({ note: 'light-machine', machineClass: 'light' });
  });
});
