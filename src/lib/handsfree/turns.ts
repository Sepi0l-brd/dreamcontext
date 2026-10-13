/**
 * Running work inside the in-scope roots at go (Go step 3): a running turn WAITS unless the
 * owner chose Cut (D4, AC12); an idle chat is cut without asking; every cut kills the whole
 * process group, and the git preflight re-runs after it.
 *
 * D22: the PROCESS TREE decides ({@link processTurnControl}); the dashboard's registries
 * (chat children, PTYs, detached runs; `src/server/routes/handsfree.ts`) only label what the
 * scan finds and give idle chats their cut-without-asking. The CLI uses the scan alone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathUnderAny } from '../automations/runner.js';
import type { ProcessRunner } from './git-snapshot.js';
import { handsfreeDir } from './trip-state.js';

export interface RunningWork {
  kind: 'chat' | 'pty' | 'detached' | 'process';
  id: string;
  cwd?: string;
  /** A running turn (wait or Cut). False = an idle chat child (cut without asking). */
  busy: boolean;
  /** The process id (scan entries). */
  pid?: number;
  /** A scan entry that descends from this process (the dashboard's own child tree). */
  fromSelf?: boolean;
  /** What runs (the leader's command line, shortened), so a wait can say what it waits for. */
  command?: string;
  /** How many scanned processes this entry stands for (the leader and its children: MCP servers, hooks). */
  members?: number;
}

// ---------------------------------------------------------------- the app's chat mirror

/**
 * The desktop app's live chat registry, mirrored to disk for the CLI (#4). The CLI cannot see
 * the server's registry, so a go run from a terminal (or the Chat run card) counted every
 * app-owned chat child and its MCP servers as running turns, forever. Each dashboard server
 * writes `live-chats/<its pid>.json` on every turn edge; a file whose server is gone is ignored.
 */
export interface LiveChatMirror {
  serverPid: number;
  chats: Array<{ pid: number; conversationId: string; projectRoot: string; busy: boolean }>;
}

export function liveChatMirrorDir(home?: string): string {
  return join(handsfreeDir(home), 'live-chats');
}

/** Alive AND ours: a pid another user now holds (EPERM) is a reused pid, not our server. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface MirroredChat { busy: boolean; conversationId: string; serverPid: number }

/**
 * Chat child pid -> its state, from every live server's mirror. Unreadable files are skipped
 * (those chats stay "running"). The scan trusts an entry only while that pid's parent is still
 * the server that wrote it, so a reused pid never inherits an old "idle".
 */
export function readLiveChatMirrors(home?: string, alive: (pid: number) => boolean = pidAlive): Map<number, MirroredChat> {
  const out = new Map<number, MirroredChat>();
  let names: string[] = [];
  try { names = readdirSync(liveChatMirrorDir(home)); } catch { return out; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const m = JSON.parse(readFileSync(join(liveChatMirrorDir(home), n), 'utf8')) as LiveChatMirror;
      if (!Number.isInteger(m?.serverPid) || m.serverPid <= 1 || `${m.serverPid}.json` !== n || !alive(m.serverPid) || !Array.isArray(m.chats)) continue;
      for (const c of m.chats) {
        if (Number.isInteger(c?.pid) && c.pid > 1 && typeof c.busy === 'boolean' && typeof c.conversationId === 'string') out.set(c.pid, { busy: c.busy, conversationId: c.conversationId, serverPid: m.serverPid });
      }
    } catch { /* torn or foreign: ignored */ }
  }
  return out;
}

export interface TurnControl {
  list(roots: string[]): Promise<RunningWork[]>;
  /** Cut the idle work (`all: false`) or everything (`all: true`); resolves once it exited. */
  cut(roots: string[], o: { all: boolean }): Promise<number>;
}

export const NO_TURNS: TurnControl = {
  list: async () => [],
  cut: async () => 0,
};

/** Realpath + case-insensitive (darwin/win32) containment: lane F's `pathUnderAny`. */
export function under(roots: string[], p: string): boolean {
  return pathUnderAny(p, roots);
}

export interface ProcessScanOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Signal a pid (negative = a process group). Injectable for tests. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** This process (the dashboard server or the CLI). */
  self?: number;
  /** How long a cut waits after SIGTERM before SIGKILL (default 5 s), and after SIGKILL. */
  graceMs?: number;
  /** The app's live chats by child pid (default: the on-disk mirrors under `home`). */
  liveChats?: () => Map<number, MirroredChat>;
  home?: string;
}

interface Found { pid: number; cwd: string; pgid: number | null; fromSelf: boolean }

/** Scanned processes grouped under the one that owns them: an app chat child, or the topmost scanned ancestor. */
interface Group { leader: number; cwd: string; command: string; members: Found[]; chat: MirroredChat | null; fromSelf: boolean }

const COMMAND_MAX = 160;

/** The id of the entry a failed process scan reports: running work that could not be checked. */
export const UNKNOWN_WORK_ID = 'unknown';

/**
 * D22: running work by the PROCESS TREE. Every process whose cwd is inside a scope root
 * (claude and every descendant, hooks included), whether or not it descends from this
 * process, found by an lsof cwd scan with lane F's realpath + case-insensitive containment.
 * Never listed or signalled: this process itself, its own process group, and its ancestors
 * (a claude that launched the CLI cannot finish before the CLI does; waiting on it would
 * deadlock and cutting it would kill the caller).
 * Cut = SIGTERM to each found process group, SIGKILL to each group after the grace even when
 * its leader already exited, then wait until every found pid is gone.
 */
export function processTurnControl(run: ProcessRunner, o: ProcessScanOptions = {}): TurnControl {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const kill = o.kill ?? ((pid: number, sig: NodeJS.Signals | 0) => { process.kill(pid, sig); });
  const self = o.self ?? process.pid;
  const grace = o.graceMs ?? 5000;
  const liveChats = o.liveChats ?? (() => readLiveChatMirrors(o.home));
  const table = async (): Promise<Map<number, { ppid: number; pgid: number; command: string }>> => {
    const res = await run('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { cwd: '/', timeoutMs: 15_000 }).catch(() => null);
    const m = new Map<number, { ppid: number; pgid: number; command: string }>();
    for (const line of res?.stdout.toString().split('\n') ?? []) {
      const r = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
      if (r && Number(r[1]) > 0) m.set(Number(r[1]), { ppid: Number(r[2]), pgid: Number(r[3]), command: r[4].trim() });
    }
    return m;
  };
  const scan = async (roots: string[]): Promise<{ found: Found[]; groups: Group[]; ownGroup: number | null; unknown?: true }> => {
    const res = await run('lsof', ['-a', '-d', 'cwd', '-F', 'pn'], { cwd: '/', timeoutMs: 30_000 }).catch(() => null);
    // Fail CLOSED: a scan that failed or timed out is "unknown running work", never "nothing".
    if (!res || res.signal || (res.code !== 0 && res.code !== 1)) return { found: [], groups: [], ownGroup: null, unknown: true };
    const hits: Array<{ pid: number; cwd: string }> = [];
    let pid = 0;
    for (const line of res.stdout.toString().split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0 && pid !== self && under(roots, line.slice(1))) hits.push({ pid, cwd: line.slice(1) });
    }
    const t = await table();
    const ownGroup = t.get(self)?.pgid ?? null;
    if (!hits.length) return { found: [], groups: [], ownGroup };
    const ancestors = new Set<number>();
    for (let cur = t.get(self)?.ppid ?? 0, i = 0; cur > 1 && i < 256; i++) { ancestors.add(cur); cur = t.get(cur)?.ppid ?? 0; }
    const fromSelf = (p: number) => {
      for (let cur = t.get(p)?.ppid ?? 0, i = 0; cur > 1 && i < 256; i++) { if (cur === self) return true; cur = t.get(cur)?.ppid ?? 0; }
      return false;
    };
    const found = hits
      .filter((h) => !ancestors.has(h.pid) && (ownGroup === null || t.get(h.pid)?.pgid !== ownGroup))
      .map((h) => ({ ...h, pgid: t.get(h.pid)?.pgid ?? null, fromSelf: fromSelf(h.pid) }));
    // Group: an MCP server, a hook or a tool child belongs to the chat (or the topmost scanned
    // process) above it, so the wait names 2 sessions, not 14 processes.
    const chats = new Map<number, MirroredChat>();
    // Only a chat whose parent is still the server that mirrored it (pid reuse never inherits "idle").
    if (found.length) for (const [pid, c] of liveChats()) if (t.get(pid)?.ppid === c.serverPid) chats.set(pid, c);
    const foundPids = new Set(found.map((f) => f.pid));
    const groups = new Map<number, Group>();
    for (const f of found) {
      let leader = f.pid;
      let chatPid: number | null = chats.has(f.pid) ? f.pid : null;
      for (let cur = t.get(f.pid)?.ppid ?? 0, i = 0; cur > 1 && i < 256 && chatPid === null; i++) {
        if (chats.has(cur)) chatPid = cur;
        else if (foundPids.has(cur)) leader = cur;
        cur = t.get(cur)?.ppid ?? 0;
      }
      if (chatPid !== null) leader = chatPid;
      let g = groups.get(leader);
      if (!g) {
        const cmd = t.get(leader)?.command ?? '';
        g = {
          leader, cwd: found.find((x) => x.pid === leader)?.cwd ?? f.cwd,
          command: cmd.length > COMMAND_MAX ? `${cmd.slice(0, COMMAND_MAX - 1)}…` : cmd,
          members: [], chat: chatPid !== null ? chats.get(chatPid)! : null, fromSelf: false,
        };
        groups.set(leader, g);
      }
      g.members.push(f);
      g.fromSelf ||= f.fromSelf;
    }
    return { found, groups: [...groups.values()], ownGroup };
  };
  const alive = (pid: number) => { try { kill(pid, 0); return true; } catch { return false; } };
  const signalAll = (found: Found[], sig: NodeJS.Signals, ownGroup: number | null) => {
    const groups = new Set<number>();
    for (const f of found) {
      if (f.pgid && f.pgid > 1 && f.pgid !== ownGroup) groups.add(f.pgid);
      else { try { kill(f.pid, sig); } catch { /* gone */ } }
    }
    // The whole group, even when its leader already exited (its hook children may not have).
    for (const g of groups) { try { kill(-g, sig); } catch { /* group gone */ } }
  };
  const waitGone = async (found: Found[], ms: number) => {
    for (let waited = 0; waited < ms && found.some((f) => alive(f.pid)); waited += 100) await sleep(100);
  };
  return {
    async list(roots) {
      const r = await scan(roots);
      if (r.unknown) return [{ kind: 'process' as const, id: UNKNOWN_WORK_ID, busy: true }];
      // An app chat between turns is idle (cut without asking); everything else is a running turn.
      return r.groups.map((g) => ({
        kind: g.chat ? 'chat' as const : 'process' as const,
        id: g.chat ? g.chat.conversationId : String(g.leader),
        pid: g.leader, cwd: g.cwd, busy: g.chat ? g.chat.busy : true, fromSelf: g.fromSelf,
        ...(g.command ? { command: g.command } : {}), members: g.members.length,
      }));
    },
    async cut(roots, c) {
      const { groups, ownGroup } = await scan(roots);
      // Idle cut: only app chats the mirror shows between turns (read fresh by this scan).
      const hit = c.all ? groups : groups.filter((g) => g.chat && !g.chat.busy);
      const found = hit.flatMap((g) => g.members);
      if (!found.length) return 0;
      signalAll(found, 'SIGTERM', ownGroup);
      await waitGone(found, grace);
      signalAll(found, 'SIGKILL', ownGroup);
      await waitGone(found, Math.max(grace, 1000) * 2);
      return hit.length;
    },
  };
}

/** Two controls as one: listed side by side, cut in order. */
export function combineTurnControls(...cs: TurnControl[]): TurnControl {
  return {
    list: async (roots) => (await Promise.all(cs.map((c) => c.list(roots)))).flat(),
    cut: async (roots, o) => {
      let n = 0;
      for (const c of cs) n += await c.cut(roots, o);
      return n;
    },
  };
}
