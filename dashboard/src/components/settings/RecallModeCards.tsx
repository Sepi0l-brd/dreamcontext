import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { isCloudSurface } from '../../lib/cloudSurface';
import { useCloudRecallStatus, useDisableCloudRecall, type CloudTier } from '../../hooks/useCloudRecall';
import {
  useRecallOptions,
  type RecallLanguage,
  type RecallMeasurement,
  type RecallOptionId,
  type RecallOptions,
} from '../../hooks/useRecallOptions';
import type { RecallMode } from '../../hooks/useSleep';
import { MaturityTag } from '../common/MaturityTag';
import { SettingChoice } from './SettingRow';
import { EmbeddingModelCard } from './EmbeddingModelCard';
import { CloudRecallCard } from './CloudRecallCard';
import './RecallModeCards.css';

/**
 * Settings → Recall: every way of fetching memory back, side by side, with the same four facts for
 * each (accuracy per language, extra time, cost, what leaves this computer) and a personal
 * recommendation on top. The numbers are the server's (`GET /api/recall/options`); the words are i18n.
 *
 * Choosing keeps the existing mechanisms: `recall_mode` through the sleep settings, and the two cloud
 * tiers through the cloud-recall card (key, disclosure, consent, index) — which this reuses, not
 * reimplements. The default (Smart picker) does not change here.
 */

const MAIN_OPTIONS: readonly RecallOptionId[] = ['haiku', 'cloud', 'cloud-index', 'raw', 'off'];
const LANGUAGES: readonly RecallLanguage[] = ['tr', 'en', 'mixed'];
const DEFAULT_MODE: RecallMode = 'haiku';

function isCloudTier(id: RecallOptionId): id is CloudTier {
  return id === 'cloud' || id === 'cloud-index';
}

/** The ids that are a `recall_mode` of their own (the rest ride on `hybrid`). */
function isPlainMode(id: RecallOptionId): id is 'haiku' | 'raw' | 'off' {
  return id === 'haiku' || id === 'raw' || id === 'off';
}

function numberLocale(locale: string): string {
  return locale === 'tr' ? 'tr-TR' : 'en-US';
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), template);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function AccuracyBars({ m }: { m: RecallMeasurement }) {
  const { t } = useI18n();
  if (m.accuracyR5Pct === null) return <>{t('settings.recall.m.accuracy.none')}</>;
  const acc = m.accuracyR5Pct;
  return (
    <span className="recall-bars">
      {LANGUAGES.map((lang) => {
        const pct = Math.round(acc[lang]);
        const label = t(`settings.recall.m.lang.${lang}`);
        return (
          <span key={lang} className="recall-bar-row">
            <span className="recall-bar-label">{label}</span>
            <span className="recall-bar" role="meter" aria-label={`${label} ${pct}%`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span className="recall-bar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="recall-bar-pct">%{pct}</span>
          </span>
        );
      })}
    </span>
  );
}

function Metrics({ m }: { m: RecallMeasurement }) {
  const { t, locale } = useI18n();
  const fmt = (ms: number): string => (ms / 1000).toLocaleString(numberLocale(locale), { maximumFractionDigits: 1 });
  const sec = t('settings.recall.m.sec');
  const { min, max } = m.overheadP90Ms;
  let latency: string;
  if (max === 0) latency = t('settings.recall.m.latency.none');
  else if (min === max) latency = `~${fmt(max)} ${sec}`;
  else latency = `${fmt(min)}–${fmt(max)} ${sec}`;
  if (m.overheadIsEstimate) latency += ` (${t('settings.recall.m.latency.estimate')})`;

  const { indexOnceUsd, per1000QueriesUsd } = m.cost;
  let cost = t('settings.recall.m.cost.free');
  if (per1000QueriesUsd > 0) cost = fill(t('settings.recall.m.cost.cloud'), { per1000: usd(per1000QueriesUsd), index: usd(indexOnceUsd) });
  else if (indexOnceUsd > 0) cost = fill(t('settings.recall.m.cost.index'), { index: usd(indexOnceUsd) });

  return (
    <dl className="recall-metrics">
      <dt>{t('settings.recall.m.accuracy')}</dt>
      <dd><AccuracyBars m={m} /></dd>
      <dt>{t('settings.recall.m.latency')}</dt>
      <dd>{latency}</dd>
      <dt>{t('settings.recall.m.cost')}</dt>
      <dd>{cost}</dd>
      <dt>{t('settings.recall.m.egress')}</dt>
      <dd>{t(`settings.recall.m.egress.${m.egress}`)}</dd>
    </dl>
  );
}

function Recommendation({ options }: { options: RecallOptions }) {
  const { t } = useI18n();
  const { recommendation: r, measurements } = options;
  const byId = (id: RecallOptionId): RecallMeasurement | undefined => measurements.options.find((o) => o.id === id);
  const name = (id: RecallOptionId): string => t(`settings.recall.opt.${id}.label`);
  const pct = (id: RecallOptionId, lang: RecallLanguage): number => Math.round(byId(id)?.accuracyR5Pct?.[lang] ?? 0);

  const sentence = fill(t(`settings.recall.rec.${r.reason}`), {
    option: name(r.option),
    from: pct('haiku', 'tr'),
    to: pct('cloud', 'tr'),
    en: pct('raw', 'en'),
  });
  const keyLine = r.reason === 'turkish-brain' ? t(r.keyPresent ? 'settings.recall.rec.key_ready' : 'settings.recall.rec.key_needed') : '';
  const noteLine = r.note ? fill(t(`settings.recall.rec.note.${r.note}`), { option: name('cloud-index') }) : '';

  return (
    <section className="recall-rec" aria-label={t('settings.recall.rec.title')}>
      <span className="recall-rec-title">{t('settings.recall.rec.title')}</span>
      <p className="recall-rec-text">{[sentence, keyLine, noteLine].filter(Boolean).join(' ')}</p>
    </section>
  );
}

function Footnote({ options }: { options: RecallOptions }) {
  const { t, locale } = useI18n();
  const { queries, measuredOn } = options.measurements;
  const date = new Date(`${measuredOn}T00:00:00Z`).toLocaleDateString(numberLocale(locale), {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return (
    <p className="recall-foot">
      {fill(t('settings.recall.m.foot'), { total: queries.total, tr: queries.tr, en: queries.en, mixed: queries.mixed, date })}
    </p>
  );
}

export interface RecallModeCardsProps {
  recallMode: RecallMode;
  /** True while a recall-mode change is being saved. */
  saving: boolean;
  onSelectMode: (mode: RecallMode) => void;
}

export function RecallModeCards({ recallMode, saving, onSelectMode }: RecallModeCardsProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const cloudSurface = isCloudSurface();
  const { data: options, isError: optionsFailed } = useRecallOptions();
  const { data: cloud } = useCloudRecallStatus();
  const disable = useDisableCloudRecall();
  /** A cloud tier whose card is open for review, before it has consent. */
  const [openTier, setOpenTier] = useState<CloudTier | null>(null);

  const consentTier = cloud?.consent === 'valid' && cloud.tier !== 'local' ? cloud.tier : null;
  // Hybrid is the mode behind three cards: which one it is depends on the consent in force.
  const selected: RecallOptionId = recallMode === 'hybrid' ? (consentTier ?? 'hybrid') : recallMode;

  const select = (id: RecallOptionId): void => {
    if (isCloudTier(id)) {
      if (consentTier === id) { setOpenTier(null); onSelectMode('hybrid'); } else setOpenTier(id);
      return;
    }
    setOpenTier(null);
    if (id === 'hybrid') {
      // Local hybrid means no cloud: turn a cloud tier off first, then pick the mode.
      if (consentTier) disable.mutate(undefined, { onSuccess: () => onSelectMode('hybrid') });
      else onSelectMode('hybrid');
      return;
    }
    if (isPlainMode(id)) onSelectMode(id);
  };

  const refreshMode = (): void => { void queryClient.invalidateQueries({ queryKey: ['sleep'] }); };

  const card = (id: RecallOptionId): ReactNode => {
    const m = options?.measurements.options.find((o) => o.id === id);
    const recommended = options?.recommendation.option === id;
    const showCloud = isCloudTier(id) && (selected === id || openTier === id);
    return (
      <SettingChoice
        key={id}
        name="recall-mode"
        value={id}
        checked={selected === id}
        disabled={saving || disable.isPending}
        onSelect={() => select(id)}
        title={t(`settings.recall.opt.${id}.label`)}
        hint={t(`settings.recall.opt.${id}.hint`)}
        badge={(
          <>
            {id === DEFAULT_MODE && <MaturityTag label={t('settings.recall.opt.default')} />}
            {id === 'hybrid' && <MaturityTag label={t('settings.recall.experimental')} />}
            {recommended && <span className="recall-badge">{t('settings.recall.rec.badge')}</span>}
          </>
        )}
      >
        {m && <Metrics m={m} />}
        {id === 'hybrid' && selected === 'hybrid' && <EmbeddingModelCard />}
        {showCloud && isCloudTier(id) && (
          <CloudRecallCard
            tier={id}
            onEnabled={() => { setOpenTier(null); refreshMode(); }}
            onDisabled={() => { setOpenTier(null); onSelectMode(DEFAULT_MODE); }}
          />
        )}
      </SettingChoice>
    );
  };

  // The cloud tiers cannot be set from the hands-free cloud machine (the routes refuse it).
  const mainOptions = MAIN_OPTIONS.filter((id) => !(cloudSurface && isCloudTier(id)));

  return (
    <div className="recall-cards">
      {options && <Recommendation options={options} />}
      {optionsFailed && <p className="settings-field-hint">{t('settings.recall.m.unavailable')}</p>}
      <div className="setting-choices" role="radiogroup" aria-label={t('settings.nav.recall')}>
        {mainOptions.map(card)}
      </div>
      <details className="recall-advanced" open={selected === 'hybrid' || undefined}>
        <summary>{t('settings.recall.advanced')}</summary>
        <div className="setting-choices">{card('hybrid')}</div>
      </details>
      {options && <Footnote options={options} />}
    </div>
  );
}
