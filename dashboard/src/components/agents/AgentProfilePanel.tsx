import { useEffect, useState } from 'react';
import { RequestError } from '../../api/client';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import {
  findAgent,
  useAgent,
  useAgents,
  useApproveAgent,
  useDeleteAgentIdentity,
  type AgentSummary,
  type AgentUsageAutomation,
} from '../../hooks/useAgents';
import { openAgentSurface } from '../../lib/agentSettings';
import { DELETE_ARM_MS, deleteAction } from '../../lib/agentDraft';
import { requestTalkToAgent } from '../../lib/talkToAgent';
import { AgentAvatar } from './AgentAvatar';
import { approvalChips, tx } from './AgentRosterCard';
import './AgentProfilePanel.css';

/**
 * The review text (`AgentDetail.review`, the same `field: value` lines the CLI prints) as a map.
 * A multi-line value is written as `field:` followed by lines indented two spaces.
 */
export function parseReviewFields(review: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of review.split('\n')) {
    if (current !== null && line.startsWith('  ')) {
      const prev = out.get(current) ?? '';
      out.set(current, prev ? `${prev}\n${line.slice(2)}` : line.slice(2));
      continue;
    }
    const m = /^([A-Za-z]+):(?: (.*))?$/.exec(line);
    if (!m) { current = null; continue; }
    current = m[1];
    out.set(current, m[2] ?? '');
  }
  return out;
}

/** One read-only call setting, as the profile shows it. `value` null ⇒ not set. */
export interface CallSettingRow {
  key: 'timeout' | 'outputDir' | 'review' | 'flow';
  value: string | null;
}

/** The call settings the review carries, in the profile's order. Read-only: nothing here edits them. */
export function callSettingRows(review: string): CallSettingRow[] {
  const fields = parseReviewFields(review);
  const read = (name: string): string | null => {
    const v = fields.get(name);
    return v === undefined || v === '' || v === '(none)' ? null : v;
  };
  return [
    { key: 'timeout', value: read('timeoutMinutes') },
    { key: 'outputDir', value: read('outputDir') },
    { key: 'review', value: read('review') },
    { key: 'flow', value: read('flow') },
  ];
}

/**
 * What a refused delete names. The 409 `agent_in_use` says which automations still run as the
 * agent; the profile already holds their titles, so it names them in words, falling back to the
 * slugs for any it does not know.
 */
export function inUseNames(agent: Pick<AgentSummary, 'usedBy'>, slugs?: readonly string[]): string[] {
  const titles = new Map(agent.usedBy.automations.map((a) => [a.slug, a.title]));
  const list = slugs && slugs.length > 0 ? slugs : agent.usedBy.automations.map((a) => a.slug);
  return list.map((s) => titles.get(s) ?? s);
}

/** Is this delete failure the in-use refusal? */
export function isAgentInUse(err: unknown): boolean {
  return err instanceof RequestError && err.status === 409 && err.code === 'agent_in_use';
}

/** The i18n key for why the agent may not run, or the plain "not approved" line. */
export function approvalReasonKey(reason: string | null): string {
  return reason ? `agents.approval.reason.${reason}` : 'agents.approval.runNo';
}

/** One automation's state line: paused, next run, or "when you call it". */
function automationWhen(a: AgentUsageAutomation, t: (k: string) => string, locale: string): string {
  if (!a.enabled) return t('agents.profile.usage.paused');
  if (!a.nextFireAt) return t('agents.profile.usage.onCall');
  const when = new Date(a.nextFireAt).toLocaleString(locale, {
    weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
  });
  return t('agents.profile.usage.next').replace('{time}', when);
}

/**
 * One agent's profile: who it is (editable through the identity dialog), where it works, its
 * read-only call settings, and approval for chat and approval to run, shown SEPARATELY. Approve
 * happens here, in place: the review (every field an approval grants) opens inside the panel,
 * and only the owner's click on Approve grants it. No browser dialog anywhere (they are silent
 * no-ops in the desktop app). No Run now and no Telegram on this page.
 */
export function AgentProfilePanel({
  slug, onClose, onEdit, onDeleted, onToast,
}: {
  slug: string;
  onClose: () => void;
  onEdit: (slug: string) => void;
  onDeleted: (slug: string) => void;
  onToast: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const { bus } = useVault();
  const roster = useAgents();
  const detail = useAgent(slug);
  const approve = useApproveAgent();
  const remove = useDeleteAgentIdentity();
  const agent = findAgent(roster.data, slug) ?? detail.data?.agent ?? null;

  const [reviewing, setReviewing] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [talkError, setTalkError] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);

  // A different agent opens on a clean panel: no half-finished review or armed delete carries over.
  useEffect(() => {
    setReviewing(false);
    setApproveError(null);
    setArmed(false);
    setDeleteError(null);
    setTalkError(null);
  }, [slug]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!agent) {
    const missing = !roster.isLoading && !detail.isLoading;
    return (
      <aside className="agp-panel" aria-label={t('agents.page.title')}>
        <div className="agp-panel-top">
          <span className="agp-muted">
            {missing ? tx(t, 'agents.profile.missing', 'This agent no longer exists.') : t('agents.page.loading')}
          </span>
          <button type="button" className="agp-btn" onClick={onClose}>{t('agents.profile.close')}</button>
        </div>
      </aside>
    );
  }

  const name = agent.title;
  const fullyApproved = agent.approvedForChat && agent.approvedToRun;

  const openReview = () => {
    setApproveError(null);
    setReviewing(true);
    // The review must be what Approve grants NOW, not a copy from when the panel opened.
    void detail.refetch();
  };

  const doApprove = () => {
    if (approve.isPending || detail.isFetching) return;
    approve.mutate(slug, {
      onSuccess: (fresh) => {
        setReviewing(false);
        onToast(t('agents.approval.approved').replace('{name}', fresh.title));
      },
      onError: (err) => setApproveError(t('agents.approval.failed').replace('{name}', name).replace('{reason}', (err as Error).message)),
    });
  };

  const talk = () => {
    if (talking) return;
    setTalkError(null);
    setTalking(true);
    void requestTalkToAgent(slug).then((accepted) => {
      setTalking(false);
      if (accepted) openAgentSurface(bus);
      else setTalkError(t('agents.profile.talkFailed'));
    });
  };

  const doDelete = () => {
    if (remove.isPending) return;
    if (deleteAction(armed) === 'arm') { setDeleteError(null); setArmed(true); return; }
    remove.mutate(slug, {
      onSuccess: () => {
        onToast(t('agents.profile.deleted').replace('{name}', name));
        onDeleted(slug);
      },
      onError: (err) => {
        setArmed(false);
        if (isAgentInUse(err)) {
          setDeleteError(t('agents.profile.deleteInUse').replace('{name}', name).replace('{list}', inUseNames(agent).join(', ')));
        } else {
          setDeleteError(t('agents.profile.deleteFailed').replace('{name}', name).replace('{reason}', (err as Error).message));
        }
      },
    });
  };

  const usage = agent.usedBy;
  const nothingUses = usage.automations.length + usage.boards.length + usage.tasks.length === 0;

  return (
    <aside className="agp-panel" aria-label={t('agents.profile.aria').replace('{name}', name)} data-agent-profile={slug}>
      <div className="agp-panel-top">
        <AgentAvatar of="agent" slug={agent.slug} title={name} hasPhoto={agent.hasPhoto} size={56} version={agent.hasPhoto ? detail.dataUpdatedAt : undefined} />
        <div className="agp-ident">
          <h2 className="agp-name">{name}</h2>
          <span className="agp-muted">
            {agent.model ?? t('agents.profile.modelDefault')}
            {' · '}
            {agent.effort ?? t('agents.profile.effortDefault')}
          </span>
        </div>
        <button type="button" className="agp-btn agp-btn--ghost" onClick={onClose}>{t('agents.profile.close')}</button>
      </div>

      <div className="agp-actions">
        <button
          type="button"
          className="agp-btn agp-btn--primary"
          onClick={talk}
          disabled={!agent.approvedForChat || talking}
          title={agent.approvedForChat ? t('agents.profile.talkHint').replace('{name}', name) : t('agents.approval.chatNo')}
        >
          {t('agents.profile.talk')}
        </button>
        <button type="button" className="agp-btn" onClick={() => onEdit(slug)}>{t('agents.profile.edit')}</button>
      </div>
      {talkError && <p className="agp-error" role="alert">{talkError}</p>}

      {/* Approval: two verdicts, two rows, never one. */}
      <section className="agp-section" aria-label={t('agents.approval.title')} data-approval-section>
        <h3 className="agp-h">{t('agents.approval.title')}</h3>
        {approvalChips(agent).map((chip) => (
          <div key={chip.kind} className="agp-approval-row" data-approval={chip.kind} data-approved={chip.ok}>
            <span className={`agr-chip agr-chip--${chip.ok ? 'ok' : 'no'}`}>
              <span className="agr-chip-mark" aria-hidden="true">{chip.ok ? '✓' : '!'}</span>
              {t(chip.labelKey)}
            </span>
            <span className="agp-muted">
              {chip.kind === 'chat'
                ? t('agents.approval.chatHint')
                : chip.ok ? t('agents.approval.runHint') : tx(t, approvalReasonKey(agent.approvalReason), t('agents.approval.runNo'))}
            </span>
          </div>
        ))}

        {!fullyApproved && !reviewing && (
          <button type="button" className="agp-btn" onClick={openReview}>{t('agents.approval.review')}</button>
        )}

        {reviewing && (
          <div className="agp-review" data-approval-review>
            <p className="agp-muted">{t('agents.approval.reviewLead')}</p>
            <pre className="agp-review-text">{detail.isFetching && !detail.data ? t('agents.page.loading') : detail.data?.review ?? ''}</pre>
            {approveError && <p className="agp-error" role="alert">{approveError}</p>}
            <div className="agp-review-foot">
              <button type="button" className="agp-btn" onClick={() => setReviewing(false)} disabled={approve.isPending}>
                {t('agents.approval.cancel')}
              </button>
              <button
                type="button"
                className="agp-btn agp-btn--primary"
                onClick={doApprove}
                disabled={approve.isPending || detail.isFetching || !detail.data}
              >
                {approve.isPending ? t('agents.approval.approving') : t('agents.approval.approve')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="agp-section" aria-label={t('agents.profile.prompt')}>
        <h3 className="agp-h">{t('agents.profile.prompt')}</h3>
        <p className="agp-prompt">{detail.data?.prompt ?? agent.description}</p>
        <dl className="agp-facts">
          <dt>{t('agents.profile.model')}</dt>
          <dd>{agent.model ?? t('agents.profile.modelDefault')}</dd>
          <dt>{t('agents.profile.effort')}</dt>
          <dd>{agent.effort ?? t('agents.profile.effortDefault')}</dd>
          <dt>{t('agents.profile.board')}</dt>
          <dd>{agent.whiteboard ?? t('agents.profile.noBoard')}</dd>
        </dl>
        {detail.data && (
          <p className="agp-muted">
            {detail.data.learning ? t('agents.profile.learning') : t('agents.profile.learningOff')}
          </p>
        )}
        {agent.shared && <p className="agp-muted">{t('agents.roster.sharedHint')}</p>}
        {agent.implicit && <p className="agp-muted">{t('agents.roster.implicitHint')}</p>}
      </section>

      <section className="agp-section" aria-label={t('agents.profile.usage')} data-usage>
        <h3 className="agp-h">{t('agents.profile.usage')}</h3>
        {nothingUses && <p className="agp-muted">{t('agents.profile.usage.none')}</p>}
        {usage.automations.length > 0 && (
          <div className="agp-usage">
            <h4 className="agp-h4">{t('agents.profile.usage.automations')}</h4>
            <ul className="agp-list">
              {usage.automations.map((a) => (
                <li key={a.slug} className="agp-list-row">
                  <span className="agp-list-name">{a.title}</span>
                  <span className="agp-muted">{automationWhen(a, t, locale)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {usage.boards.length > 0 && (
          <div className="agp-usage">
            <h4 className="agp-h4">{t('agents.profile.usage.boards')}</h4>
            <ul className="agp-list">
              {usage.boards.map((b) => (
                <li key={b} className="agp-list-row">
                  <button
                    type="button"
                    className="agp-link"
                    onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'whiteboards', id: b })}
                  >
                    {b}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {usage.tasks.length > 0 && (
          <div className="agp-usage">
            <h4 className="agp-h4">{t('agents.profile.usage.tasks')}</h4>
            <ul className="agp-list">
              {usage.tasks.map((task) => (
                <li key={task.slug} className="agp-list-row">
                  <button
                    type="button"
                    className="agp-link"
                    onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'tasks', id: task.slug })}
                  >
                    {task.name}
                  </button>
                  <span className="agp-muted">{task.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {agent.hasCallSettings && (
        <section className="agp-section" aria-label={t('agents.profile.callSettings')} data-call-settings>
          <h3 className="agp-h">{t('agents.profile.callSettings')}</h3>
          <p className="agp-muted">{t('agents.profile.callSettingsHint')}</p>
          {detail.data && (
            <dl className="agp-facts">
              {callSettingRows(detail.data.review).map((row) => (
                <CallSettingFact key={row.key} row={row} t={t} />
              ))}
            </dl>
          )}
        </section>
      )}

      <section className="agp-section agp-section--danger">
        <button
          type="button"
          className={`agp-btn agp-btn--danger${armed ? ' agp-btn--armed' : ''}`}
          onClick={doDelete}
          disabled={remove.isPending}
          data-delete-armed={armed}
        >
          {armed ? t('agents.profile.deleteConfirm').replace('{name}', name) : t('agents.profile.delete')}
        </button>
        {deleteError && <p className="agp-error" role="alert">{deleteError}</p>}
      </section>
    </aside>
  );
}

/** One call setting as a definition pair. A flow is named as set or not, never dumped as data. */
function CallSettingFact({ row, t }: { row: CallSettingRow; t: (k: string) => string }) {
  const none = tx(t, 'agents.profile.callSettingNone', 'None');
  let label: string;
  let value: string;
  switch (row.key) {
    case 'timeout':
      label = t('agents.profile.timeout');
      value = row.value ? t('agents.profile.timeoutValue').replace('{n}', row.value) : none;
      break;
    case 'outputDir':
      label = t('agents.profile.outputDir');
      value = row.value ?? none;
      break;
    case 'review':
      label = t('agents.profile.review');
      value = row.value ?? none;
      break;
    default:
      label = t('agents.profile.flow');
      value = row.value ? tx(t, 'agents.profile.flowSet', 'Set') : none;
  }
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
