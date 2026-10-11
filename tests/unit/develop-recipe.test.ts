/**
 * The Develop run recipe (src/lib/develop-recipe.ts), printed by
 * `dreamcontext goal-live recipe develop`. The Develop briefing carries only the contract and
 * sends the lead here, so these lines ARE the procedure. Each assertion pins a rule a plan
 * review or a measurement paid for (task develop-mode-runs-like-goal-skill-…, R4-R11; v2:
 * task every-piece-of-work-gets-the-lightest-process-…, harness-plan-v2.md); a wording change
 * that keeps the rule passes, a change that drops it fails.
 *
 * What v1 pinned in recipe TEXT (the env strip, the spawn flags, the registry line shape,
 * liveness by kill -0 + ps) is now CODE in `dreamcontext builder` and is pinned by
 * tests/unit/builder-spawn.test.ts; here only the calls and when to make them remain.
 */
import { describe, it, expect } from 'vitest';
import { DEVELOP_RECIPE as R } from '../../src/lib/develop-recipe.js';

const lines = R.split('\n');
const goalLiveLines = lines.filter((l) => /dreamcontext goal-live\b|(?:^|\s|`)goal-live (?:actor|state|phase|start|clear)\b/.test(l));
const section = (from: string, to: string) => R.slice(R.indexOf(from), R.indexOf(to));

describe('builders are started by the CLI, never by a hand-written claude -p', () => {
  it('no line launches claude itself', () => {
    expect(R).not.toMatch(/nohup claude -p/);
    expect(R).not.toMatch(/claude -p "/);
    expect(R).not.toMatch(/--session-id "\$SID"/);
    expect(R).toMatch(/never by a `claude -p` line you\s+write/);
  });

  it('a run with 2+ lanes mints ONE base and forks from it; a single lane is spawned fresh', () => {
    expect(R).toContain('dreamcontext builder base "$S" --prompt-file "$ROOT/tmp/develop/$S/base.md"');
    expect(R).toMatch(/A run with 2\+ lanes in total forks every builder from ONE base session/);
    expect(R).toMatch(/A run that is a single lane has no base: it uses `builder spawn`/);
    expect(R).toMatch(/Over 150k tokens .*\n?.*--remint/);
  });

  it('the first fork of a wave is the canary; a miss switches the rest to fresh builders', () => {
    const forks = lines.filter((l) => /^\s+dreamcontext builder fork "\$S" wN-[A-Z] --owns /.test(l));
    expect(forks).toHaveLength(2);
    expect(forks[0]).toMatch(/--canary$/);
    expect(forks[1]).not.toContain('--canary');
    for (const f of forks) expect(f).toMatch(/--prompt-file "\$ROOT\/tmp\/develop\/\$S\/wN-[A-Z]\.md"/);
    expect(R).toMatch(/Exit 6 = a cache miss: start the other lanes with\s+`dreamcontext builder spawn`/);
  });

  it('never starts anything with run_in_background', () => {
    const mentions = lines.filter((l) => l.includes('run_in_background'));
    expect(mentions.length).toBeGreaterThan(0);
    for (const l of mentions) expect(l).toMatch(/Never|never|no run_in_background/);
  });

  it('builders are told never to call goal-live, and how to end', () => {
    expect(R).toMatch(/Builders never call goal-live/);
    expect(R).toMatch(/BUILDER:[\s\S]*Never call dreamcontext goal-live/);
    expect(R).toMatch(/files changed:/);
  });

  it('every builder call gets the Bash tool\'s 10-minute timeout (base, wait and test block)', () => {
    expect(R).toMatch(/Give every `dreamcontext builder` call the Bash tool's\s+`timeout: 600000`/);
  });
});

describe('the lead blocks on its children instead of ending its turn', () => {
  it('states the rule above every other one', () => {
    expect(R.indexOf('never end your turn while a builder or judge you started is still')).toBeGreaterThan(-1);
    expect(R.indexOf('ABOVE EVERY OTHER RULE')).toBeLessThan(R.indexOf('## 0.'));
    expect(R).toMatch(/the owner is not your scheduler/);
  });

  it('works in parallel, then ONE blocking wait with its three exits', () => {
    const wait = section('### 2d.', '### 2e.');
    expect(wait).toMatch(/While the lanes run, do what does not need their output/);
    expect(wait).toContain('dreamcontext builder wait "$S"');
    expect(wait).toMatch(/Exit 0 = every lane returned/);
    expect(wait).toMatch(/4 = the 9-minute slice ended with lanes still running: run it\s+again/);
    expect(wait).toMatch(/5 = one needs you/);
    expect(wait).toMatch(/`paused` \(usage limit\) = resume the\s+same lane later/);
  });
});

describe('the per-wave snapshot and scope (R4)', () => {
  it('seeds a task-keyed index in the git dir from the real index, then writes a tree', () => {
    expect(R).toContain('IDX="$(git rev-parse --absolute-git-dir)/dc-$S-wN.idx"');
    expect(R).toContain('REAL="$(git rev-parse --git-path index)"');
    expect(R).toContain('[ -f "$REAL" ] && cp "$REAL" "$IDX"');
    expect(R).toContain('GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree');
  });

  it('logs the start tree for a reopened lead, and diffs trees NUL-separated with quotePath off', () => {
    // START, not BASE: "base" is the builder base session now.
    expect(R).toContain('dreamcontext tasks log "$S" "wN start tree $START"');
    expect(R).toContain('git -c core.quotePath=false diff-tree -r -z --name-status "$START" "$NOW"');
    expect(R).not.toMatch(/\$BASE\b/);
  });

  it('classifies collisions and unclaimed paths; the end reviewer gets the union by name', () => {
    expect(R).toMatch(/COLLISION/);
    expect(R).toMatch(/unclaimed/);
    expect(R).toMatch(/tell the owner once/);
    expect(R).toMatch(/union of every wave's scope\s+no wave reviewer read, enumerated by name, with the wave-1 START tree/);
    expect(R).toMatch(/never a bare\s+`git diff`/);
    expect(R).toMatch(/status A are new: read them whole/);
    expect(R).toMatch(/fetches its own changes; never paste a diff/);
  });

  it('the earlier wave\'s builders must be gone before a snapshot is taken', () => {
    expect(R).toMatch(/no builder of an earlier wave is running \(`dreamcontext builder status "\$S"`\)/);
  });
});

describe('ONE check per wave, failures routed to the owning lane', () => {
  const check = section('### 2e.', '### 2f.');

  it('the lead checks the whole wave once, with the also-run list', () => {
    expect(check).toContain('dreamcontext builder test "$S" --wave N --related <every changed path> --also <also-run tests>');
    expect(check).toMatch(/SHOW its output/);
    expect(check).toMatch(/"NOT GREEN: no test covers"\s+line/);
    expect(check).toMatch(/75 = a check did not run: run it again/);
  });

  it('a failure resumes the owning lane with exactly its output, then re-runs only what failed', () => {
    expect(check).toContain('dreamcontext builder resume "$S" wN-L --message-file "$ROOT/tmp/develop/$S/wN-L-fix.md"');
    expect(check).toMatch(/write exactly its FAIL lines/);
    expect(check).toContain('dreamcontext builder test "$S" --wave N --failed --related <files the fix changed>');
    expect(check).toMatch(/the producer of a contract before its consumer/);
  });

  it('a lane that does not converge goes to the owner', () => {
    expect(check).toMatch(/`FAILED 2x`, or the CLI refusing a 4th resume = STOP and put it to the owner/);
  });

  it('a red under load is the machine, re-run before anyone is resumed', () => {
    expect(check).toMatch(/timeout under load is the machine/);
  });

  it('an "outside my files" report goes to the lane that owns that file', () => {
    expect(check).toMatch(/"outside my files" item in a report goes to the lane that owns that file, by resume/);
  });
});

describe('review where it pays (owner decision 15, 2026-10-11)', () => {
  it('the map marks contract and hot-path waves REVIEWED; every other wave waits for the end review', () => {
    const map = section('## 1.', '## 2.');
    expect(map).toMatch(/Mark a wave REVIEWED when it is a contract wave/);
    expect(map).toMatch(/money, auth, secrets, migrations, outbound messages/);
    expect(map).toMatch(/Every other wave is reviewed once, at the end of the run/);
  });

  it('states that it reverses the 2026-09-26 per-wave review', () => {
    expect(R).toMatch(/REVERSES the owner's 2026-09-26 call that a reviewer closes\s+every wave/);
  });

  it('a REVIEWED wave\'s reviewer runs in the same message as its tests', () => {
    expect(R).toMatch(/A REVIEWED wave\s+dispatches its reviewer \(2f\) in the SAME message as this call/);
    expect(section('### 2f.', '### 2g.')).toMatch(/not in the background/);
  });

  it('the end review runs alongside the final check and is skipped when every wave was reviewed', () => {
    const end = section('## 3.', '## 4.');
    expect(end).toMatch(/The end review and the final check run at the same time, dispatched in ONE message/);
    expect(end).toMatch(/A run whose every wave was REVIEWED skips it/);
    expect(end).toMatch(/a fresh end reviewer\s+re-checks only the previous findings and the fix/);
  });
});

describe('the base learns each wave before the next forks', () => {
  it('updates by resume after a green wave, write-ahead, never after the last', () => {
    const close = section('### 2g.', '## 3.');
    expect(close).toMatch(/Only when its check is GREEN and its reviewer \(if any\) passed/);
    expect(close).toContain('dreamcontext builder base "$S" --update "$ROOT/tmp/develop/$S/base-delta-wN.md" --wave N');
    expect(close).toMatch(/The delta is in the task log before the base reads it/);
    expect(close).toMatch(/No update after the last wave/);
  });
});

describe('goal-live call discipline (R11, R1, R10)', () => {
  it('every goal-live command ends in || true and nothing is chained after it with &&', () => {
    const commands = lines.filter((l) => /^\s+dreamcontext goal-live /.test(l));
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const l of commands) {
      expect(l, l).toMatch(/\|\| true\s*$/);
      expect(l.slice(l.indexOf('goal-live')), l).not.toContain('&&');
    }
    for (const l of goalLiveLines) expect(l.slice(l.indexOf('goal-live')), l).not.toContain('&&');
  });

  it('every wave-qualified actor names both --role and --wave', () => {
    const actors = goalLiveLines.filter((l) => /goal-live actor w[NM0-9]+-/.test(l));
    expect(actors.length).toBeGreaterThanOrEqual(2);
    for (const l of actors) {
      expect(l, l).toMatch(/--role (?:implementer|reviewer)/);
      expect(l, l).toMatch(/--wave [NM0-9]/);
    }
  });

  it('never enters impl or codereview after validate', () => {
    const at = R.indexOf('goal-live phase validate');
    expect(at).toBeGreaterThan(0);
    expect(R.slice(at)).not.toMatch(/goal-live phase (?:impl|codereview)/);
    expect(R).toMatch(/the phase STAYS validate/);
    expect(R).toContain('final-fix-reviewer');
  });

  it('a review FAIL re-enters impl and codereview for that wave, so the retry is a round on the map', () => {
    const fail = R.slice(R.indexOf('FAIL: re-enter the build'));
    expect(fail).toBeTruthy();
    const impl = fail.indexOf('dreamcontext goal-live phase impl --wave N || true');
    const review = fail.indexOf('dreamcontext goal-live phase codereview --wave N || true');
    const reviewer = fail.indexOf('goal-live actor wN-reviewer --kind fresh --role reviewer --wave N --round 2');
    expect(impl).toBeGreaterThan(0);
    expect(review).toBeGreaterThan(impl);
    expect(reviewer).toBeGreaterThan(review);
  });

  it('says each Bash call is a fresh shell, and how values cross calls', () => {
    expect(R).toMatch(/EACH BASH CALL IS A FRESH SHELL/);
    expect(R).toMatch(/pasting the literal value printed earlier|reading it back from the task log/);
  });

  it('a verdict is recorded before the next phase', () => {
    expect(R).toMatch(/Record the verdict BEFORE the next phase/);
    expect(R).toContain('dreamcontext goal-live state wN-reviewer=PASS --wave N || true');
  });
});

describe('closing by the Validation method (owner decisions 8 and 13)', () => {
  const end = section('## 3.', '## 4.');

  it('a command method runs once in the final check and closes the task with its result', () => {
    expect(end).toMatch(/the task's Validation\s+method when it is a command/);
    expect(end).toMatch(/A command that passed: .*phase done/);
    expect(end).toMatch(/completed "<what shipped \+ the command and its result>"/);
  });

  it('a manual or browser method goes to in_review and only OFFERS the validator', () => {
    expect(end).toMatch(/A manual or browser check: `dreamcontext tasks status "\$S" in_review/);
    expect(end).toMatch(/It runs ONLY when the owner asks for it/);
    expect(end.indexOf('When the owner asks:')).toBeLessThan(end.indexOf('goal-live phase validate'));
  });

  it('the validator proves the result with screenshots and a video', () => {
    expect(R).toMatch(/VALIDATOR: "[^"]*screenshots and a video/);
    expect(R).toMatch(/Flaky or skipped is FAIL/);
  });

  it('every validator verdict is also a task-log line', () => {
    expect(R).toContain('"validator PASS"');
    expect(R).toContain('"validator FAIL -> wM-L"');
  });

  it('the full suite is not in the loop: only when the Validation method names it', () => {
    expect(end).toMatch(/The\s+full suite runs only when the Validation method names it/);
  });
});

describe('reopen and the wave map (R8, R10)', () => {
  it('start --mode develop adopts; a wave-map mismatch starts fresh', () => {
    expect(R).toContain('dreamcontext goal-live start --goal "$S" --mode develop || true');
    expect(R).toMatch(/ADOPTS/);
    expect(R).toMatch(/impl\.waves differs from\s+the task's wave map, start fresh/);
  });

  it('a reopen reads the sessions from the CLI and the open failures from the wave\'s state file', () => {
    const reopen = R.slice(R.indexOf('## 6.'));
    expect(reopen).toContain('dreamcontext builder status "$S"');
    expect(reopen).toMatch(/last `wN start tree` line/);
    expect(reopen).toMatch(/`test-wN\.json`[\s\S]*--failed/);
  });

  it('the mid-fix reopen rule: never re-validate an unreviewed fix', () => {
    expect(R).toMatch(/validator FAIL newer than any\s+final-fix-reviewer PASS/);
    expect(R).toMatch(/never re-validate an unreviewed fix/);
  });

  it('the wave map: max 3 lanes, disjoint files, a Plan-mode map used unchanged', () => {
    expect(R).toMatch(/at most 3 lanes a wave/);
    expect(R).toMatch(/DISJOINT files/);
    expect(R).toMatch(/used unchanged/);
  });

  it('the wave map has as few waves as the dependencies allow', () => {
    expect(R).toMatch(/as FEW\s+waves as the dependencies allow/);
    expect(R).toMatch(/Wave count = the longest dependency chain/);
    expect(R).toMatch(/A criterion goes in the EARLIEST wave whose\s+inputs exist/);
    expect(R).toMatch(/A file clash is never a reason for a new wave/);
    expect(R).toMatch(/never a test wave/);
    expect(R).toMatch(/never a closing wave of their own/);
    expect(R).toMatch(/A topic split \(server, then client, then docs\) is not a dependency/);
  });
});
