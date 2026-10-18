import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { readIdentity } from '../src/cli/identity.js';

function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = runCli(argv, {
    version: '0.1.0',
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { stdout, stderr, exitCode };
}

describe('CLI skeleton', () => {
  it.each([{ argv: [] }, { argv: ['--help'] }])(
    'prints help for %j without executing a command',
    ({ argv }) => {
      const result = run(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      for (const command of [
        'team',
        'task',
        'msg',
        'plan',
        'worktree',
        'board',
      ])
        expect(result.stdout).toContain(command);
      expect(result.stdout).toContain('--team');
      expect(result.stdout).toContain('--json');
    },
  );
  it('prints the supplied package version', () => {
    expect(run(['--version'])).toEqual({
      stdout: '0.1.0\n',
      stderr: '',
      exitCode: 0,
    });
  });
  it.each([
    ['team'],
    ['team', 'start', 'template'],
    ['team', 'save', 'template'],
    ['plan', 'submit', '1', '--file', 'plan.md'],
    ['plan', 'approve', '1'],
    ['plan', 'reject', '1'],
    ...['status', 'log', 'board'].map((name) => [name]),
    ['_action', 'start-team'],
    ['_action', 'open-board'],
  ])('exposes a side-effect-free placeholder for %j', (...argv) => {
    const result = run(argv);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('not implemented');
    expect(result.stdout).toContain('PLAN §');
    expect(result.stderr).toBe('');
  });
  it.each([
    ['--team', 'override', '--json', 'plan', 'approve', '1'],
    ['plan', '--team', 'override', 'approve', '1', '--json'],
    ['plan', 'approve', '1', '--team', 'override', '--json'],
  ])('accepts global flags at every command depth: %j', (...argv) => {
    const result = run(argv, {
      HERDR_TEAMS_TEAM: 'default',
      HERDR_TEAMS_AGENT: 'alice',
      HERDR_TEAMS_HOME: '/state',
      HERDR_PANE_ID: 'w1:p2',
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'plan approve',
      status: 'not implemented',
      identity: {
        team: 'override',
        agent: 'alice',
        home: '/state',
        paneId: 'w1:p2',
      },
    });
  });
  it('uses environment identity when --team is omitted', () => {
    const result = run(['status', '--json'], {
      HERDR_TEAMS_TEAM: 'auth',
      HERDR_PLUGIN_STATE_DIR: '/plugin-state',
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      identity: { team: 'auth', home: '/plugin-state' },
    });
  });
  it.each([['nonsense'], ['team', 'nonsense'], ['--team']])(
    'reports usage errors for %j',
    (...argv) => {
      expect(run(argv)).toMatchObject({ exitCode: 2, stdout: '' });
      expect(run(argv).stderr).toContain('error:');
    },
  );
  it('shows nested help without running the stub', () => {
    const result = run(['task', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dep');
    expect(result.stdout).not.toContain('task: not implemented');
  });
});

describe('identity (PLAN §4.2–4.3)', () => {
  it('reads only the identity variables and falls back to the plugin state directory', () => {
    expect(
      readIdentity({
        HERDR_PLUGIN_STATE_DIR: '/fallback',
        HERDR_TEAMS_TEAM: 'auth',
        HERDR_TEAMS_AGENT: 'alice',
        HERDR_PANE_ID: 'w1:p2',
        UNRELATED: 'ignored',
      }),
    ).toEqual({
      home: '/fallback',
      team: 'auth',
      agent: 'alice',
      paneId: 'w1:p2',
    });
  });
  it('prefers explicit home and team overrides', () => {
    expect(
      readIdentity(
        {
          HERDR_TEAMS_HOME: '/explicit',
          HERDR_PLUGIN_STATE_DIR: '/fallback',
          HERDR_TEAMS_TEAM: 'auth',
        },
        'override',
      ),
    ).toEqual({
      home: '/explicit',
      team: 'override',
      agent: undefined,
      paneId: undefined,
    });
  });
  it('does not invent an identity outside a herdr pane', () => {
    expect(readIdentity({})).toEqual({
      home: undefined,
      team: undefined,
      agent: undefined,
      paneId: undefined,
    });
  });
});
