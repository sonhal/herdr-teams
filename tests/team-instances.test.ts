import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { runCliAsync } from '../src/cli/index.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Store, newAgentName } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { agent, pane } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true }));
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'instances-'));
  homes.push(home);
  const db = new Store(home, randomUUID());
  db.create('lead', 'dev');
  db.updateTeam((team) => {
    team.supervisor = { mode: 'off' };
  });
  return db;
}

it.each(['flag', 'environment'])(
  'resolves a display name from the %s for commands and reconciliation',
  async (source) => {
    const db = setup();
    db.add('visible');
    const fake = await fakeHerdr([
      jsonReply({ type: 'agent_list', agents: [] }),
    ]);
    let stdout = '',
      stderr = '';
    try {
      const code = await runCliAsync(
        source === 'flag'
          ? ['task', 'list', '--team', 'dev']
          : ['task', 'list'],
        {
          version: 'test',
          env: {
            ...fake.env,
            HERDR_TEAMS_HOME: db.home,
            ...(source === 'environment' ? { HERDR_TEAMS_TEAM: 'dev' } : {}),
          },
          stdout: (s) => {
            stdout += s;
          },
          stderr: (s) => {
            stderr += s;
          },
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject([{ subject: 'visible' }]);
      expect(stderr).toBe('');
      expect(await fake.calls()).toEqual([['agent', 'list']]);
    } finally {
      await fake.cleanup();
    }
  },
);

it('rejects an ambiguous display name before running a command', async () => {
  const db = setup();
  new Store(db.home, randomUUID()).create('lead', 'dev');
  let stderr = '';
  expect(
    await runCliAsync(['--team', 'dev', 'task', 'list'], {
      version: 'test',
      env: { HERDR_TEAMS_HOME: db.home },
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    }),
  ).toBe(1);
  expect(stderr).toContain('ambiguous');
});

it('keeps the runtime name separate from the template name', async () => {
  const db = setup();
  mkdirSync(join(db.home, '.herdr'));
  writeFileSync(
    join(db.home, '.herdr', 'teams.yaml'),
    'sample:\n  supervisor: {mode: off}\n  members: []\n',
  );
  vi.spyOn(process, 'cwd').mockReturnValue(db.home);
  const fake = await fakeHerdr([jsonReply({ type: 'agent_list', agents: [] })]);
  let stdout = '',
    stderr = '';
  try {
    expect(
      await runCliAsync(['team', 'start', 'sample', '--name', 'custom'], {
        version: 'test',
        env: { ...fake.env, HERDR_TEAMS_HOME: db.home },
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ name: 'custom' });
    expect(stderr).toBe('');
    expect(
      Store.teams(db.home)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['custom', 'dev']);
  } finally {
    await fake.cleanup();
  }
});

it('launches and prompts distinct agents for same-name instances in one session', async () => {
  // herdr v0.9.5 requires session-wide unique names of at most 32 characters.
  const a = setup();
  const b = new Store(a.home, randomUUID());
  b.create('lead', 'dev');
  const client = new HerdrClient({ env: {} });
  let currentName = '';
  vi.spyOn(client, 'createLocation').mockResolvedValue(pane);
  const start = vi
    .spyOn(client, 'agentStart')
    .mockImplementation(async (options) => {
      currentName = options.name;
      return {
        type: 'agent_started',
        agent: { ...agent, name: currentName },
        argv: [],
      };
    });
  vi.spyOn(client, 'quiet').mockResolvedValue(undefined);
  const prompt = vi
    .spyOn(client, 'agentPrompt')
    .mockResolvedValue({ type: 'agent_prompted', agent });
  vi.spyOn(client, 'agentGet').mockImplementation(async () => ({
    type: 'agent_info',
    agent: { ...agent, name: currentName },
  }));
  for (const db of [a, b])
    await new Lifecycle(db, client, {
      HERDR_SOCKET_PATH: 'same-session',
    }).spawn('alice', { kind: 'codex', prompt: 'work' });
  const names = start.mock.calls.map(([options]) => options.name);
  expect(new Set(names).size).toBe(2);
  for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(prompt.mock.calls.map(([name]) => name)).toEqual(names);
  expect([a, b].map((db) => db.config().details!.alice!.agent_name)).toEqual(
    names,
  );
});

it('keeps a four-character suffix within herdr’s 32-character limit', () => {
  const id = randomUUID();
  const name = newAgentName('a'.repeat(20), 'b'.repeat(11), id);
  expect(name).toHaveLength(32);
  expect(name).toMatch(/^[a-z][a-z0-9_-]*-[0-9a-f]{4}$/);
  expect(newAgentName('a'.repeat(20), 'b'.repeat(11), id)).toBe(name);
});
