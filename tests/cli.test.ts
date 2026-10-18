import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { describe, expect, it } from 'vitest';
import { createCli, runCli } from '../src/cli/index.js';
import { readIdentity, resolveTeamId } from '../src/cli/identity.js';

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

describe('CLI', () => {
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
  it('registers the supervise command the supervisor pane runs', () => {
    const names = createCli({ version: '0.1.0', env: {} }).commands.map((c) =>
      c.name(),
    );
    expect(names).toContain('supervise');
    expect(names).toContain('cleanup');
  });
  it('prints the supplied package version', () => {
    expect(run(['--version'])).toEqual({
      stdout: '0.1.0\n',
      stderr: '',
      exitCode: 0,
    });
  });
  it.each([
    ['--team', 'override', '--json', 'task', 'list'],
    ['task', '--team', 'override', 'list', '--json'],
    ['task', 'list', '--team', 'override', '--json'],
  ])('accepts global flags at every command depth: %j', (...argv) => {
    const home = mkdtempSync(join(tmpdir(), 'cli-'));
    const id = randomUUID();
    const db = new Store(home, id);
    db.create('lead', 'override');
    db.add('flag test');
    try {
      const result = run(
        argv.map((a) => (a === 'override' ? id : a)),
        {
          HERDR_TEAMS_HOME: home,
          HERDR_TEAMS_TEAM: 'default',
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject([
        { subject: 'flag test' },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      teamId: 'auth',
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
      teamId: 'override',
      agent: undefined,
      paneId: undefined,
    });
  });
  it("defaults to herdr's plugin state directory inside a herdr pane", () => {
    // herdr 143bf5f: src/plugin_paths.rs plugin_state_dir, src/config/io.rs state_dir.
    expect(readIdentity({ HERDR_ENV: '1', HOME: '/h' }).home).toBe(
      '/h/.local/state/herdr/plugins/herdr-teams',
    );
    expect(
      readIdentity({ HERDR_ENV: '1', HOME: '/h', XDG_STATE_HOME: '/s' }).home,
    ).toBe('/s/herdr/plugins/herdr-teams');
  });
  it('does not invent an identity outside a herdr pane', () => {
    expect(readIdentity({})).toEqual({
      home: undefined,
      teamId: undefined,
      agent: undefined,
      paneId: undefined,
    });
  });

  it('resolveTeamId passes a uuid through', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const id = randomUUID();
      new Store(home, id).create('lead', 'dev');
      expect(resolveTeamId(home, id)).toBe(id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolveTeamId resolves a unique display name to its id', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const id = randomUUID();
      new Store(home, id).create('lead', 'dev');
      expect(resolveTeamId(home, 'dev')).toBe(id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolveTeamId errors on an ambiguous display name', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-'));
    try {
      const a = randomUUID(),
        b = randomUUID();
      new Store(home, a).create('lead', 'dev');
      new Store(home, b).create('lead', 'dev');
      expect(() => resolveTeamId(home, 'dev')).toThrow(/ambiguous/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
