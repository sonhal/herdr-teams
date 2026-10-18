import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCliAsync } from '../src/cli/index.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Store } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { syncMembers } from '../src/supervisor/lifecycle.js';
import { agent, pane } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-'));
  homes.push(home);
  const db = new Store(home, 'demo');
  db.create('lead');
  return db;
}
const location = jsonReply({ type: 'tab_created', root_pane: pane });
const started = jsonReply({ type: 'agent_started', agent, argv: ['codex'] });
const prompted = jsonReply({ type: 'agent_prompted', agent });
const metadata = jsonReply({ type: 'pane_info', pane });
it('launches Codex with isolated identity, model, effort and attributed bootstrap', async () => {
  const db = setup();
  const fake = await fakeHerdr([
    location,
    started,
    metadata,
    prompted,
    jsonReply({ type: 'agent_info', agent }),
  ]);
  try {
    const lifecycle = new Lifecycle(
      db,
      new HerdrClient({ env: fake.env }),
      fake.env,
    );
    await lifecycle.spawn('alice', {
      kind: 'codex',
      model: 'test-model',
      thinking: 'high',
      prompt: 'Implement tests',
    });
    const calls = await fake.calls();
    expect(calls[0]).toContain('--no-focus');
    expect(calls[0]).toContain('HERDR_TEAMS_AGENT=alice');
    expect(calls[1]).toEqual([
      'agent',
      'start',
      'alice',
      '--kind',
      'codex',
      '--pane',
      pane.pane_id,
      '--',
      '-m',
      'test-model',
      '-c',
      'model_reasoning_effort=high',
    ]);
    expect(calls[3]![3]).toContain('teammate in team "demo"');
    expect(db.config().details!.alice).toMatchObject({
      kind: 'codex',
      pane_id: pane.pane_id,
      state: 'idle',
    });
  } finally {
    await fake.cleanup();
  }
});
it('retains launch failures and gives the lead arguments and captured output', async () => {
  const db = setup();
  const fake = await fakeHerdr([
    location,
    { exitCode: 3, stderr: 'bad model' },
    { stdout: 'launch output' },
  ]);
  try {
    const lifecycle = new Lifecycle(
      db,
      new HerdrClient({ env: fake.env }),
      fake.env,
    );
    await expect(
      lifecycle.spawn('alice', { prompt: 'test', model: 'bad' }),
    ).rejects.toThrow();
    expect(db.config().details!.alice!.ended).toBe('failed-to-launch');
    expect(db.inbox('lead')[0]!.body).toContain('launch output');
    expect((await fake.calls()).some((c) => c[1] === 'close')).toBe(false);
  } finally {
    await fake.cleanup();
  }
});
it('waits for idle before exit, confirms disappearance, then closes and releases tasks', async () => {
  const db = setup();
  db.reserveMember('alice', {
    kind: 'codex',
    pane_id: pane.pane_id,
    state: 'working',
  });
  const task = db.add('work');
  db.change(task.id, 'claim', 'alice');
  const fake = await fakeHerdr([
    prompted,
    { stdout: 'finished' },
    jsonReply({ type: 'ok' }),
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    const lifecycle = new Lifecycle(db, client, fake.env);
    lifecycle.requestShutdown('alice');
    lifecycle.acceptShutdown('alice');
    await syncMembers(db, client, [{ ...agent, agent_status: 'working' }]);
    expect(await fake.calls()).toHaveLength(0);
    await syncMembers(db, client, [agent]);
    expect((await fake.calls())[0]).toEqual([
      'agent',
      'prompt',
      'alice',
      '/quit',
    ]);
    expect(db.config().details!.alice!.ended).toBeUndefined();
    await syncMembers(db, client, []);
    await syncMembers(db, client, []);
    expect(db.config().details!.alice!.ended).toBe('shut-down');
    expect(db.task(task.id)).toMatchObject({ status: 'pending', owner: null });
    expect(
      db.inbox('lead').filter((m) => m.body.includes('shut-down')),
    ).toHaveLength(1);
  } finally {
    await fake.cleanup();
  }
});
it('kill closes the pane and records exactly one terminal state', async () => {
  const db = setup();
  db.reserveMember('alice', {
    kind: 'codex',
    pane_id: pane.pane_id,
    state: 'idle',
  });
  const fake = await fakeHerdr([jsonReply({ type: 'ok' })]);
  try {
    await new Lifecycle(db, new HerdrClient({ env: fake.env }), fake.env).kill(
      'alice',
    );
    db.endMember('alice', 'crashed');
    expect(db.config().details!.alice!.ended).toBe('killed');
    expect(db.inbox('lead')).toHaveLength(1);
  } finally {
    await fake.cleanup();
  }
});

it('uses an overflow tab after four split members without stealing focus', async () => {
  const db = setup();
  db.updateTeam((team) => {
    team.layout = {
      tab_id: pane.tab_id,
      pane_id: pane.pane_id,
      count: 4,
      number: 1,
    };
  });
  const fake = await fakeHerdr([
    location,
    started,
    metadata,
    prompted,
    jsonReply({ type: 'agent_info', agent }),
  ]);
  try {
    await new Lifecycle(db, new HerdrClient({ env: fake.env }), fake.env).spawn(
      'alice',
      { prompt: 'test' },
    );
    expect((await fake.calls())[0]).toContain('team:demo:2');
    expect((await fake.calls())[0]).toContain('--no-focus');
    expect(db.config().layout!.number).toBe(2);
  } finally {
    await fake.cleanup();
  }
});

describe('install-shim action', () => {
  it('links the shim once, reports through herdr, and keeps foreign files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shim-'));
    const fake = await fakeHerdr([
      jsonReply({ type: 'ok' }),
      jsonReply({ type: 'ok' }),
      jsonReply({ type: 'ok' }),
    ]);
    const run = (directory: string) =>
      runCliAsync(['_action', 'install-shim', '--directory', directory], {
        version: 'test',
        env: { ...fake.env, HOME: home, HERDR_PLUGIN_ROOT: '/plugin-root' },
        stdout: () => {},
        stderr: () => {},
      });
    try {
      const bin = join(home, 'bin');
      expect(await run(bin)).toBe(0);
      expect(readlinkSync(join(bin, 'herdr-teams'))).toBe(
        '/plugin-root/bin/herdr-teams',
      );
      expect(await run(bin)).toBe(0);
      const other = join(home, 'other');
      mkdirSync(other);
      writeFileSync(join(other, 'herdr-teams'), 'mine');
      expect(await run(other)).toBe(1);
      expect(readFileSync(join(other, 'herdr-teams'), 'utf8')).toBe('mine');
      const titles = (await fake.calls()).map((c) => c[2]);
      expect(titles).toEqual([
        'herdr-teams command installed',
        'herdr-teams command installed',
        'herdr-teams command not installed',
      ]);
    } finally {
      await fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
