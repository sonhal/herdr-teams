import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCliAsync } from '../src/cli/index.js';
import { Config } from '../src/core/config.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Store } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { agent, pane } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';

const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'builtin-'));
  homes.push(home);
  const env = { ...process.env, XDG_CONFIG_HOME: join(home, 'global') };
  return { home, env, config: new Config(home, env) };
}
// herdr v0.9.5 src/app/agents.rs agent_target_error_body: agent get on a
// pane without an agent fails with agent_not_found, on stderr with exit 1.
const noAgent = {
  exitCode: 1,
  stderr: JSON.stringify({
    id: 'cli:agent:get',
    error: { code: 'agent_not_found', message: 'agent target w1:p1 not found' },
  }),
};

it('ships dev and research templates whose roles name no agent kind', () => {
  const { config } = setup();
  expect(config.catalog().map((t) => [t.name, t.source])).toEqual([
    ['dev', 'built-in'],
    ['research', 'built-in'],
  ]);
  for (const name of ['dev', 'research'])
    for (const member of config.template(name).members)
      expect(config.resolve(member).kind).toBeUndefined();
});

it('lets project templates and roles replace built-in ones', () => {
  const { home, config } = setup();
  mkdirSync(join(home, '.herdr', 'agents'), { recursive: true });
  writeFileSync(
    join(home, '.herdr', 'teams.yaml'),
    'dev:\n  members: [{name: solo, agent: developer}]\n',
  );
  writeFileSync(
    join(home, '.herdr', 'agents', 'developer.md'),
    '---\nkind: pi\n---\nProject developer',
  );
  expect(config.catalog().find((t) => t.name === 'dev')!.source).toBe(
    'project',
  );
  const [member] = config.template('dev').members;
  expect(config.resolve(member!)).toMatchObject({
    name: 'solo',
    kind: 'pi',
    instructions: 'Project developer',
  });
});

function team() {
  const home = mkdtempSync(join(tmpdir(), 'builtin-'));
  homes.push(home);
  const db = new Store(home, 'demo');
  db.create('lead');
  return db;
}

it("spawns the calling pane's agent kind when nothing names one", async () => {
  const db = team();
  const claude = { ...agent, pane_id: 'w1:p1', agent: 'claude' };
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_info', agent: claude }),
    jsonReply({ type: 'tab_created', root_pane: pane }),
    jsonReply({ type: 'agent_started', agent, argv: ['claude'] }),
    { stdout: '' },
    jsonReply({ type: 'agent_prompted', agent }),
    jsonReply({ type: 'agent_info', agent }),
  ]);
  try {
    const env = { ...fake.env, HERDR_PANE_ID: 'w1:p1' };
    await new Lifecycle(db, new HerdrClient({ env }), env).spawn('alice', {
      prompt: 'work',
    });
    const calls = await fake.calls();
    expect(calls[0]).toEqual(['agent', 'get', 'w1:p1']);
    expect(calls[2]).toEqual(expect.arrayContaining(['--kind', 'claude']));
    expect(db.config().details!.alice!.kind).toBe('claude');
  } finally {
    await fake.cleanup();
  }
});

it.each([
  ['no agent runs in the pane', [noAgent], /No agent runs in this pane/],
  [
    'the pane runs an agent herdr-teams cannot launch',
    [jsonReply({ type: 'agent_info', agent: { ...agent, agent: 'gemini' } })],
    /runs gemini, which herdr-teams cannot launch/,
  ],
  ['the caller is outside herdr', [], /Not in a herdr pane/],
])('requires --kind when %s', async (_, replies, message) => {
  const db = team();
  const fake = await fakeHerdr(replies);
  try {
    const env: NodeJS.ProcessEnv = { ...fake.env };
    delete env.HERDR_PANE_ID;
    if (replies.length) env.HERDR_PANE_ID = 'w1:p1';
    await expect(
      new Lifecycle(db, new HerdrClient({ env }), env).spawn('alice', {
        prompt: 'work',
      }),
    ).rejects.toThrow(message);
    expect(db.config().members).toEqual(['lead']);
    expect((await fake.calls()).length).toBe(replies.length);
  } finally {
    await fake.cleanup();
  }
});

it('creates no team when team start cannot resolve a kind', async () => {
  const { home, env } = setup();
  const fake = await fakeHerdr([noAgent]);
  let stderr = '';
  try {
    const code = await runCliAsync(['team', 'start', 'dev'], {
      version: 'test',
      env: {
        ...env,
        HERDR_BIN_PATH: fake.binary,
        HERDR_TEAMS_HOME: join(home, 'state'),
        HERDR_PANE_ID: 'w1:p1',
      },
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('pass --kind');
    expect(Store.teams(join(home, 'state'))).toEqual([]);
  } finally {
    await fake.cleanup();
  }
});
