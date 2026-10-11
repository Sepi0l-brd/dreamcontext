import { describe, it, expect } from 'vitest';
import { DREAMCONTEXT_AUTO_MODE, autoModeSettings } from '../../src/lib/auto-mode-rules.js';
import { FAN_OUT_RECIPE } from '../../src/lib/develop-recipe.js';
import { builderArgv, builderEnv } from '../../src/lib/builder-spawn.js';

describe('dreamcontext auto-mode carve-outs', () => {
  it('extends the shipped rules instead of replacing them', () => {
    expect(DREAMCONTEXT_AUTO_MODE.allow[0]).toBe('$defaults');
    expect(autoModeSettings()).toEqual({ autoMode: DREAMCONTEXT_AUTO_MODE });
  });

  // Drift guard: the carve-out names the builder launch by its marks — if the recipe stops
  // using one, the rule describes a shape nobody launches and the classifier blocks again.
  // Builders are launched only by the opt-in fan-out recipe since 2026-10-11 (the lead builds).
  it.each(['dreamcontext builder', 'DREAMCONTEXT_SPAWNED=develop', 'acceptEdits', '--allowedTools', 'tmp/develop/', 'claude -p', '--resume'])(
    'the rule and the Develop fan-out recipe share the mark %s',
    (mark) => {
      expect(DREAMCONTEXT_AUTO_MODE.allow[1]).toContain(mark);
      expect(FAN_OUT_RECIPE).toContain(mark);
    },
  );

  // ...and the launch the CLI actually makes still has the shape the rule describes.
  it('the CLI\'s builder argv and env carry the marks the rule names', () => {
    const rule = DREAMCONTEXT_AUTO_MODE.allow[1];
    const fork = builderArgv('p', { kind: 'fork', from: 'a', sessionId: 'b' }, { model: 'm', effort: 'medium' });
    expect(fork).toEqual(expect.arrayContaining(['--resume', '--fork-session', '--permission-mode', 'acceptEdits', '--allowedTools', '-p']));
    expect(rule).toContain('--fork-session');
    expect(builderEnv({}, '-').DREAMCONTEXT_SPAWNED).toBe('develop');
    expect(fork).not.toContain('bypassPermissions');
  });
});
