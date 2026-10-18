import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Store, newAgentName } from '../src/core/store.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { HerdrClient } from '../src/herdr/index.js';
import { reconcile } from '../src/runtime/delivery.js';
import { applyEvent } from '../src/runtime/events.js';
import { runCliAsync } from '../src/cli/index.js';
import { agent, pane } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';

const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'issue13-'));
  homes.push(home);
  const db = new Store(home, randomUUID());
  db.create('lead', 'demo');
  db.reserveMember('alice', {
    kind: 'claude',
    pane_id: pane.pane_id,
    tab_id: pane.tab_id,
    state: 'idle',
    started_at: 1,
  });
  return db;
}
// herdr v0.9.5, 143bf5fd: schema/{agents,panes,events}.rs and server.rs.
function harness() {
  let live = { ...agent, completion_seq: 0 };
  let output = 'current output';
  let notificationFails = false;
  let closeFails = false;
  const calls: string[][] = [];
  const client = new HerdrClient({
    runner: async (_bin, argv) => {
      calls.push([...argv]);
      if (argv[0] === 'pane' && argv[1] === 'read')
        return { stdout: output, stderr: '', exitCode: 0 };
      if (
        (notificationFails && argv[0] === 'notification') ||
        (closeFails && argv[1] === 'close')
      )
        return {
          stdout: '',
          stderr: JSON.stringify({
            id: 'test',
            error: {
              code: closeFails ? 'pane_not_found' : 'notification_failed',
              message: 'unavailable',
            },
          }),
          exitCode: 1,
        };
      const result =
        argv[1] === 'list'
          ? { type: 'agent_list', agents: [live] }
          : argv[1] === 'get'
            ? { type: 'agent_info', agent: live }
            : argv[1] === 'prompt'
              ? { type: 'agent_prompted', agent: live }
              : argv[1] === 'split'
                ? { type: 'pane_info', pane: { ...pane, pane_id: 'w1:p3' } }
                : argv[1] === 'create'
                  ? {
                      type: 'tab_created',
                      root_pane: { ...pane, pane_id: 'w1:p3' },
                    }
                  : argv[1] === 'start'
                    ? { type: 'agent_started', agent: live, argv: ['claude'] }
                    : { type: 'ok' };
      return {
        stdout: JSON.stringify({ id: 'test', result }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  return {
    client,
    calls,
    setLive: (value: typeof live) => {
      live = value;
    },
    setOutput: (value: string) => {
      output = value;
    },
    failNotification: () => {
      notificationFails = true;
    },
    failClose: () => {
      closeFails = true;
    },
  };
}

it('does not repeat the teammate’s own message to the lead in its turn report', async () => {
  const db = setup();
  const h = harness();
  db.send('alice', 'lead', 'dev online: all good');
  h.setLive({ ...agent, completion_seq: 1 });
  h.setOutput('pane echo of dev online: all good');
  await reconcile(db, h.client);
  const reports = db.inbox('lead').filter((m) => m.kind === 'report');
  expect(reports).toHaveLength(1);
  expect(reports[0]!.body).toContain('Turn completed');
  expect(reports[0]!.body).not.toContain('all good');
  expect(h.calls.some((c) => c[1] === 'read')).toBe(false);
});

it('does not reuse a direct message in subsequent turn reports', async () => {
  const db = setup();
  const h = harness();
  db.send('alice', 'lead', 'first turn message');
  h.setLive({ ...agent, completion_seq: 1 });
  await reconcile(db, h.client);
  h.setLive({ ...agent, completion_seq: 2 });
  h.setOutput('second turn output');
  await reconcile(db, h.client);
  const reports = db.inbox('lead').filter((m) => m.kind === 'report');
  expect(reports).toHaveLength(2);
  expect(reports[1]!.body).toContain('second turn output');
  expect(reports[1]!.body).not.toContain('first turn message');
});

it('reports every new completion after a member respawns', async () => {
  const db = setup();
  const h = harness();
  h.setLive({ ...agent, completion_seq: 4 });
  await reconcile(db, h.client);
  db.endMember('alice', 'killed');
  db.reserveMember('alice', {
    kind: 'claude',
    pane_id: 'w1:p3',
    state: 'idle',
    started_at: 2,
  });
  for (const completion_seq of [1, 2, 3]) {
    h.setLive({ ...agent, pane_id: 'w1:p3', completion_seq });
    await reconcile(db, h.client);
  }
  expect(db.inbox('lead').filter((m) => m.kind === 'report')).toHaveLength(4);
  expect(db.deliveryState().idle_hooks!.alice).toBe(3);
});

it('splits a surviving pane after killing the latest split member', async () => {
  const db = setup();
  const h = harness();
  db.reserveMember('bob', {
    kind: 'claude',
    state: 'idle',
    pane_id: 'w1:p9',
    tab_id: pane.tab_id,
  });
  db.updateTeam((t) => {
    t.layout = { tab_id: pane.tab_id, pane_id: 'w1:p9', count: 2, number: 1 };
  });
  const lifecycle = new Lifecycle(db, h.client, {});
  await lifecycle.kill('bob');
  h.setLive({
    ...agent,
    name: newAgentName('demo', 'carol', db.id),
    pane_id: 'w1:p3',
    completion_seq: 0,
  });
  await lifecycle.spawn('carol', { kind: 'codex', prompt: 'work' });
  expect(h.calls.find((c) => c[1] === 'split')).toContain(pane.pane_id);
  expect(db.config().layout!.count).toBe(2);
});

it('records a kill when the pane has already disappeared', async () => {
  const db = setup();
  const h = harness();
  h.failClose();
  const task = db.add('active');
  db.change(task.id, 'claim', 'alice');
  await new Lifecycle(db, h.client, {}).kill('alice');
  expect(db.config().details!.alice!.ended).toBe('killed');
  expect(db.task(task.id).owner).toBeNull();
});

it('done accepts shutdown for idle members and closes their panes', async () => {
  const db = setup();
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_info', agent }),
    jsonReply({ type: 'agent_prompted', agent }),
    jsonReply({ type: 'ok' }),
    jsonReply({ type: 'agent_list', agents: [] }),
  ]);
  try {
    const code = await runCliAsync(['done'], {
      version: 'test',
      env: {
        ...fake.env,
        HERDR_TEAMS_HOME: db.home,
        HERDR_TEAMS_TEAM: db.team,
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(db.config().details!.alice!.ended).toBe('shut-down');
    expect(db.config().details!.alice!.shutdown_accepted).toBe(true);
  } finally {
    await fake.cleanup();
  }
});

it('done --force continues past a missing pane and closes the others', async () => {
  const db = setup();
  db.reserveMember('bob', { kind: 'claude', pane_id: 'w1:p3', state: 'idle' });
  const fake = await fakeHerdr([
    {
      exitCode: 1,
      stderr: JSON.stringify({
        id: 'test',
        error: { code: 'pane_not_found', message: 'gone' },
      }),
    },
    { stdout: JSON.stringify({ id: 'test', result: { type: 'ok' } }) },
    {
      stdout: JSON.stringify({
        id: 'test',
        result: { type: 'agent_list', agents: [] },
      }),
    },
  ]);
  try {
    const code = await runCliAsync(['done', '--force'], {
      version: 'test',
      env: {
        ...fake.env,
        HERDR_TEAMS_HOME: db.home,
        HERDR_TEAMS_TEAM: db.team,
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(db.config().details!.bob!.ended).toBe('killed');
    expect(db.config().details!.alice!.ended).toBe('killed');
  } finally {
    await fake.cleanup();
  }
});

it('starts assigned tasks before unassigned work and announces the assignment', async () => {
  const db = setup();
  const h = harness();
  const unassigned = db.add('unassigned');
  const assigned = db.add('assigned');
  db.change(assigned.id, 'assign', 'lead', 'alice');
  expect(db.inbox('alice').some((m) => m.body.includes('assigned'))).toBe(true);
  await reconcile(db, h.client);
  await reconcile(db, h.client);
  expect(db.task(assigned.id).status).toBe('in_progress');
  expect(db.task(unassigned.id).owner).toBeNull();
  expect(
    h.calls
      .filter((c) => c[1] === 'prompt')
      .some((c) => c[3]!.includes(`claimed task #${assigned.id}`)),
  ).toBe(true);
});

it('sends only one Esc while urgent mail waits, including after a retry', async () => {
  const db = setup();
  const h = harness();
  db.send('lead', 'alice', 'urgent', true);
  h.setLive({ ...agent, completion_seq: 0, agent_status: 'working' });
  await reconcile(db, h.client);
  await reconcile(db, h.client);
  db.send('lead', 'alice', 'another urgent message', true);
  await reconcile(db, h.client);
  expect(h.calls.filter((c) => c[1] === 'send-keys')).toHaveLength(1);
  h.setLive({ ...agent, completion_seq: 0 });
  await reconcile(db, h.client);
  h.setLive({ ...agent, completion_seq: 0, agent_status: 'working' });
  db.send('lead', 'alice', 'new turn', true);
  await reconcile(db, h.client);
  expect(h.calls.filter((c) => c[1] === 'send-keys')).toHaveLength(2);
});

it('event hooks reconcile despite a legacy supervisor readiness file', async () => {
  const db = setup();
  const socket = join(db.home, 'herdr.sock');
  db.bindSession(socket);
  const lock = join(db.root, 'locks', 'supervisor');
  mkdirSync(lock);
  writeFileSync(join(lock, 'ready'), String(process.pid));
  const fake = await fakeHerdr([
    jsonReply({
      type: 'agent_list',
      agents: [{ ...agent, completion_seq: 0 }],
    }),
    jsonReply({ type: 'ok' }),
  ]);
  try {
    const code = await runCliAsync(['_hook', 'event'], {
      version: 'test',
      env: {
        ...fake.env,
        HERDR_TEAMS_HOME: db.home,
        HERDR_SOCKET_PATH: socket,
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          event: 'pane.focused',
          data: { pane_id: pane.pane_id },
        }),
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect((await fake.calls())[0]).toEqual(['agent', 'list']);
  } finally {
    await fake.cleanup();
  }
});

it('event shim invokes delivery regardless of legacy supervisor files', () => {
  const db = setup();
  const lock = join(db.root, 'locks', 'supervisor');
  mkdirSync(lock);
  const ready = join(lock, 'ready');
  writeFileSync(ready, String(process.pid));
  const bin = join(db.home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf fallback');
  chmodSync(join(bin, 'node'), 0o755);
  const run = () =>
    execFileSync(
      'sh',
      [fileURLToPath(new URL('../bin/herdr-teams-event', import.meta.url))],
      {
        env: {
          ...process.env,
          HERDR_TEAMS_HOME: db.home,
          PATH: `${bin}:${process.env.PATH}`,
        },
        encoding: 'utf8',
      },
    );
  expect(run()).toBe('fallback');
  writeFileSync(ready, '99999999');
  expect(run()).toBe('fallback');
  rmSync(ready);
  expect(run()).toBe('fallback');
});

it('handles the v0.9.5 generic event names for moved and focused panes', () => {
  const db = setup();
  applyEvent(
    db,
    { event: 'pane_focused', data: { pane_id: pane.pane_id } },
    100,
  );
  applyEvent(db, {
    event: 'pane_moved',
    data: {
      previous_pane_id: pane.pane_id,
      pane: { ...pane, pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1' },
    },
  });
  expect(db.config().details!.alice).toMatchObject({
    focused_at: 100,
    pane_id: 'w2:p1',
  });
});

it('keeps an interrupt attempt durable when send-keys fails', async () => {
  const db = setup();
  const h = harness();
  h.setLive({ ...agent, completion_seq: 0, agent_status: 'working' });
  db.send('lead', 'alice', 'urgent', true);
  h.client.sendKeys = async () => {
    throw new Error('connection lost');
  };
  await expect(reconcile(db, h.client)).rejects.toThrow('connection lost');
  h.client.sendKeys = async () => {
    throw new Error('must not repeat Esc');
  };
  await reconcile(db, h.client);
  expect(db.deliveryState().cursors.alice).toBeUndefined();
});

it('done --force attempts other members after an unexpected close failure', async () => {
  const db = setup();
  db.reserveMember('bob', { kind: 'claude', pane_id: 'w1:p3', state: 'idle' });
  const fake = await fakeHerdr([
    { exitCode: 3, stderr: 'close unavailable' },
    { stdout: JSON.stringify({ id: 'test', result: { type: 'ok' } }) },
  ]);
  try {
    const code = await runCliAsync(['done', '--force'], {
      version: 'test',
      env: {
        ...fake.env,
        HERDR_TEAMS_HOME: db.home,
        HERDR_TEAMS_TEAM: db.team,
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(1);
    expect(db.config().details!.alice!.ended).toBeUndefined();
    expect(db.config().details!.bob!.ended).toBe('killed');
    expect(await fake.calls()).toHaveLength(2);
  } finally {
    await fake.cleanup();
  }
});
