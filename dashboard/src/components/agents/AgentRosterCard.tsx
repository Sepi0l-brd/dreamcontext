import { useI18n } from '../../context/I18nContext';
import type { AgentSummary } from '../../hooks/useAgents';
import { AgentAvatar } from './AgentAvatar';

/** A translated string, or `fallback` when the key has no copy yet (the W4b rule: lanes add no keys). */
export function tx(t: (key: string) => string, key: string, fallback: string): string {
  const s = t(key);
  return s === key ? fallback : s;
}

/** How much of the project leans on this agent, per kind, plus the total. */
export function usageCounts(agent: Pick<AgentSummary, 'usedBy'>): {
  automations: number; boards: number; tasks: number; total: number;
} {
  const automations = agent.usedBy.automations.length;
  const boards = agent.usedBy.boards.length;
  const tasks = agent.usedBy.tasks.length;
  return { automations, boards, tasks, total: automations + boards + tasks };
}

/**
 * The two approval verdicts as two chips, in a fixed order: chat first, runs second. NEVER one
 * chip: a chat-approved agent that may not run must not read as "approved" (see `useAgents`).
 */
export function approvalChips(agent: Pick<AgentSummary, 'approvedForChat' | 'approvedToRun'>): {
  kind: 'chat' | 'run'; ok: boolean; labelKey: string;
}[] {
  return [
    { kind: 'chat', ok: agent.approvedForChat, labelKey: agent.approvedForChat ? 'agents.approval.chatOk' : 'agents.approval.chatNo' },
    { kind: 'run', ok: agent.approvedToRun, labelKey: agent.approvedToRun ? 'agents.approval.runOk' : 'agents.approval.runNo' },
  ];
}

/**
 * One agent on the roster: its face, name, model, the two approval chips and how much uses it.
 * The whole card is one button that opens the profile; nothing on it acts on the agent.
 */
export function AgentRosterCard({
  agent, selected, onOpen,
}: {
  agent: AgentSummary;
  selected: boolean;
  onOpen: (slug: string) => void;
}) {
  const { t } = useI18n();
  const counts = usageCounts(agent);
  const usage: string[] = [];
  if (counts.automations) usage.push(`${t('agents.profile.usage.automations')} ${counts.automations}`);
  if (counts.boards) usage.push(`${t('agents.profile.usage.boards')} ${counts.boards}`);
  if (counts.tasks) usage.push(`${t('agents.profile.usage.tasks')} ${counts.tasks}`);

  return (
    <button
      type="button"
      className={`agr-card${selected ? ' agr-card--on' : ''}`}
      onClick={() => onOpen(agent.slug)}
      aria-pressed={selected}
      title={t('agents.roster.open').replace('{name}', agent.title)}
      data-agent={agent.slug}
    >
      <AgentAvatar of="agent" slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={40} />
      <span className="agr-card-body">
        <span className="agr-card-head">
          <span className="agr-card-title">{agent.title}</span>
          {agent.shared && (
            <span className="agr-tag" title={t('agents.roster.sharedHint')}>{t('agents.roster.shared')}</span>
          )}
          {agent.implicit && (
            <span className="agr-tag" title={t('agents.roster.implicitHint')}>{t('agents.roster.implicit')}</span>
          )}
        </span>
        <span className="agr-card-model">{agent.model ?? t('agents.profile.modelDefault')}</span>
        <span className="agr-chips">
          {approvalChips(agent).map((chip) => (
            <span
              key={chip.kind}
              className={`agr-chip agr-chip--${chip.ok ? 'ok' : 'no'}`}
              data-approval={chip.kind}
            >
              <span className="agr-chip-mark" aria-hidden="true">{chip.ok ? '✓' : '!'}</span>
              {t(chip.labelKey)}
            </span>
          ))}
        </span>
        <span className="agr-card-usage">
          {usage.length > 0 ? usage.join(' · ') : t('agents.profile.usage.none')}
        </span>
      </span>
    </button>
  );
}
