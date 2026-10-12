import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

/**
 * Agents: the dashboard's read and write surface over `/api/agents*` (`src/server/routes/agents.ts`).
 *
 * An AGENT is who does the work (a name, a face, a prompt, a model); an AUTOMATION is when and
 * what it is asked to do, and picks an agent. Every list here is the server's own
 * `listAgentTargets`, so a never-split legacy automation shows up as an agent too (`implicit`).
 *
 * TWO VERDICTS, NEVER ONE. `approvedForChat` says Chat, card chat and sub-agents may speak as it
 * (a bound automation's approval lends this); `approvedToRun` says something may EXECUTE its call
 * target here (a task assignment), which needs this Mac's direct grant. A surface that collapses
 * the two would let a chat-approved agent look runnable, which is exactly what the split exists
 * to stop. The shapes are hand-mirrored, like every hook in this folder: the dashboard has no
 * import path into `src/` for route types.
 */

/** Mirrors `EffortLevel`. */
export type AgentEffort = 'low' | 'medium' | 'high';

/** One automation that runs as this agent. */
export interface AgentUsageAutomation {
  slug: string;
  title: string;
  enabled: boolean;
  /** Null when paused, on-call, or without a valid schedule. */
  nextFireAt: string | null;
}

/** One task assigned to this agent. */
export interface AgentUsageTask {
  slug: string;
  name: string;
  status: string;
}

/** One row of `GET /api/agents` — mirrors `AgentSummary`. */
export interface AgentSummary {
  slug: string;
  title: string;
  /** Server-checked: the photo resolves inside the photos dir right now. False ⇒ initials. */
  hasPhoto: boolean;
  /** Its prompt, capped server-side: who it is, in the owner's words. */
  description: string;
  model: string | null;
  effort: AgentEffort | null;
  /** Its home board, or null. */
  whiteboard: string | null;
  shared: boolean;
  approvedForChat: boolean;
  approvedToRun: boolean;
  /** Why it may not run, when `approvedToRun` is false. */
  approvalReason: string | null;
  /** Synthesised from a not-yet-split legacy automation file. */
  implicit: boolean;
  /** Its call settings differ from the defaults (shown read-only, never edited here). */
  hasCallSettings: boolean;
  usedBy: {
    automations: AgentUsageAutomation[];
    boards: string[];
    tasks: AgentUsageTask[];
  };
}

/** `GET /api/agents/:slug` — the summary, the full prompt, and the call-target review: every
 *  hashed field, call settings included, exactly what an Approve grants. */
export interface AgentDetail {
  agent: AgentSummary;
  prompt: string;
  learning: boolean;
  /** `field: value` lines, the same text the CLI's review prints. */
  review: string;
}

/** What creating an agent sends. Identity only: nothing here edits call settings. */
export interface AgentIdentityDraft {
  title: string;
  prompt: string;
  slug?: string;
  model?: string | null;
  effort?: AgentEffort | null;
  whiteboard?: string | null;
  learning?: boolean;
}

/** An identity edit: every field optional, so a dialog that omits one never blanks it. */
export type AgentIdentityPatch = Partial<Omit<AgentIdentityDraft, 'slug'>>;

/** Everything an agent change can move: its row, its detail, the automations that run as it
 *  (their summaries carry its title and approval), and the tasks assigned to it. */
function invalidateAgent(queryClient: QueryClient, slug?: string): void {
  queryClient.invalidateQueries({ queryKey: ['agents'] });
  if (slug) queryClient.invalidateQueries({ queryKey: ['agents', slug] });
  queryClient.invalidateQueries({ queryKey: ['automations'] });
}

/** The roster. `enabled: false` reads nothing (a surface that only sometimes needs it). */
export function useAgents(opts: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ agents: AgentSummary[] }>('/agents').then((r) => r.agents),
    retry: 0,
    enabled: opts.enabled ?? true,
  });
}

/** One agent: summary, full prompt, and the review an Approve grants. */
export function useAgent(slug: string | null, opts: { fresh?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ['agents', slug],
    queryFn: () => api.get<AgentDetail>(`/agents/${encodeURIComponent(slug ?? '')}`),
    enabled: !!slug,
    retry: 0,
    // `fresh`: an edit dialog writes back what it read, so it must never start from a copy.
    ...(opts.fresh ? { refetchOnMount: 'always' as const } : {}),
  });
}

/** Create an agent. The server grants it on this machine (the local author consents). */
export function useCreateAgentIdentity() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (draft: AgentIdentityDraft) =>
      api.post<{ agent: AgentSummary }>('/agents', draft).then((r) => r.agent),
    onSuccess: (agent) => invalidateAgent(queryClient, agent.slug),
  });
}

/**
 * Edit an agent's identity. The server re-approves exactly what was directly approved before and
 * is still what this edit produced; nothing else. A 409 `prompt_truncated` arrives as a
 * `RequestError` with that code.
 */
export function useUpdateAgentIdentity() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: AgentIdentityPatch }) =>
      api.post<{ agent: AgentSummary }>(`/agents/${encodeURIComponent(slug)}/update`, patch).then((r) => r.agent),
    onSuccess: (_agent, { slug }) => invalidateAgent(queryClient, slug),
  });
}

/** Delete an agent. Refused with 409 `agent_in_use` while an automation still runs as it. */
export function useDeleteAgentIdentity() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ ok: true; slug: string }>(`/agents/${encodeURIComponent(slug)}/delete`, {}),
    onSuccess: (_data, slug) => {
      invalidateAgent(queryClient, slug);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Upload an agent's photo as raw bytes. The photo is unhashed: it never re-approves or blocks. */
export function useUploadAgentIdentityPhoto() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, bytes }: { slug: string; bytes: Blob }) =>
      api.postBytes<{ agent: AgentSummary }>(`/agents/${encodeURIComponent(slug)}/photo`, bytes).then((r) => r.agent),
    onSuccess: (_agent, { slug }) => invalidateAgent(queryClient, slug),
  });
}

/**
 * Approve the agent's CALL target as it stands right now, on this machine. Fired only after the
 * owner has seen the review (`AgentDetail.review`) in place; never from a browser dialog. Returns
 * the fresh summary, so "Approve and assign" can check `approvedToRun` before it assigns.
 */
export function useApproveAgent() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ agent: AgentSummary }>(`/agents/${encodeURIComponent(slug)}/approve`, {}).then((r) => r.agent),
    onSuccess: (_agent, slug) => {
      invalidateAgent(queryClient, slug);
      // The approval can lift a blocked automation's gate too.
      queryClient.invalidateQueries({ queryKey: ['automations-feed'] });
    },
  });
}

/** The agents a picker may offer for conversation (Chat, sub-agents, the whiteboard). */
export function chatReadyAgents(agents: readonly AgentSummary[] | undefined): AgentSummary[] {
  return (agents ?? []).filter((a) => a.approvedForChat);
}

/** One agent by slug from the roster, or null. */
export function findAgent(agents: readonly AgentSummary[] | undefined, slug: string | null | undefined): AgentSummary | null {
  if (!slug) return null;
  return (agents ?? []).find((a) => a.slug === slug) ?? null;
}
