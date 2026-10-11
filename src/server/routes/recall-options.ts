import type { IncomingMessage, ServerResponse } from 'node:http';
import { cpus, homedir, totalmem } from 'node:os';
import type { CorpusDoc } from '../../lib/recall.js';
import { buildCorpusCached } from '../../lib/recall-corpus-cache.js';
import { recallCloudKeyInfo } from '../../lib/recall-cloud-config.js';
import { RECALL_MEASUREMENTS } from '../../lib/recall-measurements.js';
import {
  languageMixOf,
  machineClassOf,
  recommendRecall,
  turkishShareOf,
  type RecallSignals,
} from '../../lib/recall-recommendation.js';
import { sendError, sendJson } from '../middleware.js';
import { requireLocalDashboardRead } from './recall-cloud.js';
import { isCloud } from '../cloud-mode.js';

/**
 * `GET /api/recall/options` — what Settings → Recall shows besides the choice itself: the measured
 * numbers of every option (one source, `lib/recall-measurements`) and the personal recommendation.
 * Read-only, and guarded exactly like the cloud-recall status route it sits beside
 * ({@link requireLocalDashboardRead}). It reports whether a key EXISTS (a boolean inside the
 * signals), never the key, and it never carries a document's text: only the language share.
 */

export interface RecallOptionsRouteDeps {
  home?: string;
  loadCorpus: (root: string) => CorpusDoc[];
  hardware: () => { totalMemBytes: number; cpuCount: number; modelName: string | null };
}

const defaultDeps = (): RecallOptionsRouteDeps => ({
  loadCorpus: (root) => buildCorpusCached(root),
  // The Apple marketing name ("Air") is not cheap to learn (a system_profiler call is seconds);
  // memory and core count carry the same "light machine" signal.
  hardware: () => ({ totalMemBytes: totalmem(), cpuCount: cpus().length, modelName: null }),
});

export interface RecallOptionsRoutes {
  options: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, root: string) => Promise<void>;
}

export function createRecallOptionsRoutes(overrides: Partial<RecallOptionsRouteDeps> = {}): RecallOptionsRoutes {
  const deps = (): RecallOptionsRouteDeps => ({ ...defaultDeps(), ...overrides });

  const options: RecallOptionsRoutes['options'] = async (req, res, _params, root) => {
    if (!requireLocalDashboardRead(req)) {
      if (isCloud()) sendError(res, 403, 'cloud_unavailable', 'This is not available on the cloud machine.');
      else sendError(res, 403, 'forbidden', 'Recall options can only be read from the dashboard on this computer.');
      return;
    }
    if (!root) { sendError(res, 400, 'no_vault', 'No vault selected.'); return; }
    const d = deps();
    let turkishShare: number | null = null;
    try {
      turkishShare = turkishShareOf(d.loadCorpus(root));
    } catch (err) {
      // No honest language reading: the recommendation then keeps the default. Class and code only, never a message.
      console.error(`[recall-options] corpus read failed: ${err instanceof Error ? err.name : 'unexpected error'}`);
    }
    const signals: RecallSignals = {
      turkishShare,
      ...d.hardware(),
      keyPresent: recallCloudKeyInfo(d.home ?? homedir()).present,
    };
    sendJson(res, 200, {
      measurements: RECALL_MEASUREMENTS,
      recommendation: recommendRecall(signals),
      signals: {
        languageMix: languageMixOf(signals.turkishShare),
        turkishSharePct: signals.turkishShare === null ? null : Math.round(signals.turkishShare * 100),
        machineClass: machineClassOf(signals),
        keyPresent: signals.keyPresent,
      },
    });
  };

  return { options };
}

export const recallOptionsRoutes = createRecallOptionsRoutes();
