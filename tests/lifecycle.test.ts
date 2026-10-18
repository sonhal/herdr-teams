import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LAUNCHER, installShim } from '../src/core/shim.js';
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
// herdr v0.9.5 src/cli/pane/bindings.rs: report-metadata is Output::Quiet,
// so success prints nothing.
const metadata = { stdout: '' };
it('launches Codex with isolated identity, model, effort and attributed bootstrap', async () => {
  const db = setup();
  const fake = await fakeHerdr([
    location,
    started,
    metadata,
    prompted,
    jsonReply({ type: 'agent_info', agent: { ...agent, name: 'demo-alice' } }),
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
      'demo-alice',
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
      lifecycle.spawn('alice', { kind: 'codex', prompt: 'test', model: 'bad' }),
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
    jsonReply({ type: 'agent_info', agent: { ...agent, name: 'demo-alice' } }),
  ]);
  try {
    await new Lifecycle(db, new HerdrClient({ env: fake.env }), fake.env).spawn(
      'alice',
      { kind: 'codex', prompt: 'test' },
    );
    expect((await fake.calls())[0]).toContain('team:demo:2');
    expect((await fake.calls())[0]).toContain('--no-focus');
    expect(db.config().layout!.number).toBe(2);
  } finally {
    await fake.cleanup();
  }
});

describe('split placement', () => {
  const split = jsonReply({ type: 'pane_info', pane });
  const launched = [
    started,
    metadata,
    prompted,
    jsonReply({ type: 'agent_info', agent: { ...agent, name: 'demo-alice' } }),
  ];
  function leadTeam(layout?: { count: number; number: number }) {
    const db = setup();
    db.updateTeam((team) => {
      team.lead_pane_id = 'w1:p1';
      if (layout)
        team.layout = { tab_id: 'w1:t1', pane_id: 'w1:p7', ...layout };
    });
    return db;
  }
  async function spawn(db: Store, replies: Parameters<typeof fakeHerdr>[0]) {
    const fake = await fakeHerdr(replies);
    try {
      await new Lifecycle(
        db,
        new HerdrClient({ env: fake.env }),
        fake.env,
      ).spawn('alice', { kind: 'codex', prompt: 'test' });
      return (await fake.calls())[0]!;
    } finally {
      await fake.cleanup();
    }
  }

  it('puts the first teammate beside the lead in the lead’s tab', async () => {
    const db = leadTeam();
    const call = await spawn(db, [split, ...launched]);
    expect(call.slice(0, 6)).toEqual([
      'pane',
      'split',
      '--pane',
      'w1:p1',
      '--direction',
      'right',
    ]);
    expect(call).toContain('--no-focus');
    expect(db.config().layout).toMatchObject({
      pane_id: pane.pane_id,
      count: 1,
      number: 0,
    });
  });
  it('stacks later teammates below the last one in the lead’s tab', async () => {
    const db = leadTeam({ count: 1, number: 0 });
    const call = await spawn(db, [split, ...launched]);
    expect(call.slice(0, 6)).toEqual([
      'pane',
      'split',
      '--pane',
      'w1:p7',
      '--direction',
      'down',
    ]);
    expect(db.config().layout!.count).toBe(2);
  });
  it('overflows into a team tab once the lead’s tab holds four', async () => {
    const db = leadTeam({ count: 4, number: 0 });
    const call = await spawn(db, [location, ...launched]);
    expect(call).toContain('team:demo');
    expect(db.config().layout).toMatchObject({ count: 1, number: 1 });
  });
  it('uses a team tab when the lead pane is gone', async () => {
    const db = leadTeam();
    const fake = await fakeHerdr([
      // herdr v0.9.5: pane split on a missing pane exits 1 with this envelope.
      {
        exitCode: 1,
        stderr: JSON.stringify({
          id: 'cli:pane:split',
          error: { code: 'pane_not_found', message: 'pane not found' },
        }),
      },
      location,
      ...launched,
    ]);
    try {
      await new Lifecycle(
        db,
        new HerdrClient({ env: fake.env }),
        fake.env,
      ).spawn('alice', { kind: 'codex', prompt: 'test' });
      expect((await fake.calls())[1]).toContain('team:demo');
      expect(db.config().layout).toMatchObject({ count: 1, number: 1 });
    } finally {
      await fake.cleanup();
    }
  });
});

describe('install-shim action', () => {
  it('installs a launcher once, reports through herdr, and keeps foreign files', async () => {
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
      mkdirSync(bin);
      // A link from the earlier shim installer is replaced, not written through.
      symlinkSync(
        join(home, 'old-root', 'bin', 'herdr-teams'),
        join(bin, 'herdr-teams'),
      );
      expect(await run(bin)).toBe(0);
      expect(readFileSync(join(bin, 'herdr-teams'), 'utf8')).toBe(LAUNCHER);
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

  it('runs the version herdr reports as installed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shim-'));
    // herdr 0.9.5 `plugin list --plugin <id> --json`: the raw plugin_list response.
    const fake = await fakeHerdr([
      jsonReply({
        type: 'plugin_list',
        plugins: [{ plugin_id: 'herdr-teams', plugin_root: process.cwd() }],
      }),
      jsonReply({ type: 'plugin_list', plugins: [] }),
    ]);
    try {
      const launcher = installShim(home);
      const env = { ...process.env, HERDR_BIN_PATH: fake.binary };
      const installed = spawnSync(launcher, ['--version'], {
        env,
        encoding: 'utf8',
      });
      expect(installed.stdout.trim()).toBe(
        (
          JSON.parse(readFileSync('package.json', 'utf8')) as {
            version: string;
          }
        ).version,
      );
      expect(await fake.calls()).toEqual([
        ['plugin', 'list', '--plugin', 'herdr-teams', '--json'],
      ]);
      const missing = spawnSync(launcher, ['--version'], {
        env,
        encoding: 'utf8',
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('not installed');
    } finally {
      await fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('herdr agent names', () => {
  // herdr v0.9.5 src/app/agents.rs: agent names are unique per herdr session
  // and match ^[a-z][a-z0-9_-]{0,31}$; a duplicate fails with agent_name_taken.
  const named = { ...agent, name: 'demo-alice' };
  it('registers a teammate under its team’s name so teams can share member names', async () => {
    const db = setup();
    const fake = await fakeHerdr([
      location,
      started,
      metadata,
      jsonReply({ type: 'agent_prompted', agent: named }),
      jsonReply({ type: 'agent_info', agent: named }),
    ]);
    try {
      await new Lifecycle(
        db,
        new HerdrClient({ env: fake.env }),
        fake.env,
      ).spawn('alice', { kind: 'codex', prompt: 'test' });
      const calls = await fake.calls();
      expect(calls[1]!.slice(0, 3)).toEqual(['agent', 'start', 'demo-alice']);
      expect(calls[2]).toContain('alice');
      expect(calls[3]!.slice(0, 3)).toEqual(['agent', 'prompt', 'demo-alice']);
      expect(db.config().details!.alice).toMatchObject({
        agent_name: 'demo-alice',
        state: 'idle',
      });
    } finally {
      await fake.cleanup();
    }
  });
  it('tracks a teammate by its herdr name and keeps older unprefixed teammates', async () => {
    const db = setup();
    db.reserveMember('alice', {
      kind: 'codex',
      agent_name: 'demo-alice',
      pane_id: agent.pane_id,
      state: 'idle',
    });
    db.reserveMember('bob', {
      kind: 'codex',
      pane_id: 'w1:p3',
      state: 'idle',
    });
    const fake = await fakeHerdr([]);
    try {
      await syncMembers(db, new HerdrClient({ env: fake.env }), [
        { ...named, agent_status: 'working' },
        { ...agent, name: 'bob', pane_id: 'w1:p3', agent_status: 'working' },
        // Another team's alice under the bare name must not count.
        { ...agent, pane_id: agent.pane_id, name: 'alice' },
      ]);
      expect(db.config().details!.alice!.state).toBe('working');
      expect(db.config().details!.bob!.state).toBe('working');
    } finally {
      await fake.cleanup();
    }
  });
  it('rejects a team and member name too long for herdr before opening a pane', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lifecycle-'));
    homes.push(home);
    const db = new Store(home, 'a'.repeat(20));
    db.create('lead');
    const fake = await fakeHerdr([]);
    try {
      await expect(
        new Lifecycle(db, new HerdrClient({ env: fake.env }), fake.env).spawn(
          'b'.repeat(12),
          { kind: 'codex', prompt: 'test' },
        ),
      ).rejects.toThrow(/32 characters/);
      expect(await fake.calls()).toHaveLength(0);
      expect(db.config().details?.['b'.repeat(12)]).toBeUndefined();
    } finally {
      await fake.cleanup();
    }
  });
});
