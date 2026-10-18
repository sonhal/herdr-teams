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
      expect(stdout).toMatch(/^#\d+ pending: visible\n$/);
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
    'sample:\n  members: []\n',
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
    expect(stdout).toContain('\nname: custom\n');
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

async function startSample(home: string, argv: string[]) {
  mkdirSync(join(home, '.herdr'), { recursive: true });
  writeFileSync(join(home, '.herdr', 'teams.yaml'), 'sample:\n  members: []\n');
  vi.spyOn(process, 'cwd').mockReturnValue(home);
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [] }),
    jsonReply({ type: 'agent_list', agents: [] }),
  ]);
  let stdout = '',
    stderr = '';
  try {
    const code = await runCliAsync(argv, {
      version: 'test',
      env: { ...fake.env, HERDR_TEAMS_HOME: home },
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    return { code, stdout, stderr };
  } finally {
    await fake.cleanup();
  }
}

it('names each template instance after the template plus its ID prefix', async () => {
  const home = setup().home;
  const first = await startSample(home, ['--json', 'team', 'start', 'sample']);
  const second = await startSample(home, ['--json', 'team', 'start', 'sample']);
  expect(first.code).toBe(0);
  expect(second.code).toBe(0);
  const a = JSON.parse(first.stdout) as { id: string; name: string };
  const b = JSON.parse(second.stdout) as { id: string; name: string };
  expect(a.name).toBe(`sample-${a.id.slice(0, 4)}`);
  expect(b.name).toBe(`sample-${b.id.slice(0, 4)}`);
  expect(a.name).not.toBe(b.name);
  const listed = await startSample(home, ['--team', a.name, 'task', 'list']);
  expect(listed).toMatchObject({ code: 0, stderr: '' });
});

it('rejects --team on team start instead of using it as the name', async () => {
  const db = setup();
  const result = await startSample(db.home, [
    '--team',
    'custom',
    'team',
    'start',
    'sample',
  ]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('name it with --name');
  expect(Store.teams(db.home).map((t) => t.name)).toEqual(['dev']);
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
