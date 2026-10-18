import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { checkAdvisories, screenHash } from '../src/supervisor/advisories.js';
import { applyEvent } from '../src/supervisor/events.js';
import { reconcile } from '../src/supervisor/delivery.js';
import { runCliAsync } from '../src/cli/index.js';
import { agent, pane } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup(state = 'working') {
  const home = mkdtempSync(join(tmpdir(), 'supervision-'));
  homes.push(home);
  const db = new Store(home, randomUUID());
  db.create('lead', 'demo');
  db.reserveMember('alice', {
    kind: 'codex',
    pane_id: pane.pane_id,
    state,
    state_since: 0,
    progress_at: 0,
    screen_hash: screenHash('unchanged'),
  });
  return db;
}
it('raises one no-progress advisory and one recovered notice', async () => {
  const db = setup();
  const fake = await fakeHerdr([
    { stdout: 'unchanged' },
    { stdout: 'unchanged' },
    { stdout: 'changed' },
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await checkAdvisories(db, client, 600001);
    await checkAdvisories(db, client, 630001);
    await checkAdvisories(db, client, 660001);
    expect(db.inbox('lead')).toHaveLength(2);
    expect(db.inbox('lead')[0]!.body).toContain('no-progress');
    expect(db.inbox('lead')[1]!.body).toContain('recovered');
    expect(db.config().details!.alice!.advisory).toBeNull();
  } finally {
    await fake.cleanup();
  }
});
it('keeps interactive advisories on the board only', async () => {
  const db = setup();
  db.patchMember('alice', { interactive: true });
  const fake = await fakeHerdr([{ stdout: 'unchanged' }]);
  try {
    await checkAdvisories(db, new HerdrClient({ env: fake.env }), 600001);
    expect(db.inbox('lead')).toHaveLength(0);
    expect(db.config().details!.alice!.advisory).toBe('no-progress');
  } finally {
    await fake.cleanup();
  }
});
it('notifies a human once when input is needed', async () => {
  const db = setup('blocked');
  const fake = await fakeHerdr([
    { stdout: 'unchanged' },
    jsonReply({ type: 'ok' }),
    { stdout: 'unchanged' },
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await checkAdvisories(db, client, 120001);
    await checkAdvisories(db, client, 150001);
    expect(
      (await fake.calls()).filter((c) => c[0] === 'notification'),
    ).toHaveLength(1);
    expect(db.inbox('lead')).toHaveLength(1);
  } finally {
    await fake.cleanup();
  }
});
it('counts team activity as progress and ignores spinner-only output', async () => {
  expect(screenHash('⠋ building')).toBe(screenHash('⠙ building'));
  const db = setup();
  db.patchMember('alice', { last_activity: 590000 });
  const fake = await fakeHerdr([{ stdout: 'unchanged' }]);
  try {
    await checkAdvisories(db, new HerdrClient({ env: fake.env }), 600001);
    expect(db.inbox('lead')).toHaveLength(0);
  } finally {
    await fake.cleanup();
  }
});
it('tracks focus and pane moves using the verified event shape', () => {
  const db = setup();
  applyEvent(
    db,
    { event: 'pane.focused', data: { pane_id: pane.pane_id } },
    100,
  );
  applyEvent(db, {
    event: 'pane.moved',
    data: {
      previous_pane_id: pane.pane_id,
      pane: { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1' },
    },
  });
  expect(db.config().details!.alice).toMatchObject({
    focused_at: 100,
    pane_id: 'w2:p1',
    workspace_id: 'w2',
  });
});
it('delivers urgent mail while working without skipping older ordinary mail', async () => {
  const db = setup();
  const ordinary = db.send('lead', 'alice', 'ordinary');
  db.send('lead', 'alice', 'urgent', true);
  const working = { ...agent, agent_status: 'working', completion_seq: 0 };
  const idle = { ...agent, completion_seq: 0 };
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [working] }),
    jsonReply({ type: 'agent_info', agent: working }),
    jsonReply({ type: 'agent_prompted', agent: working }),
    jsonReply({ type: 'agent_list', agents: [idle] }),
    jsonReply({ type: 'agent_info', agent: idle }),
    jsonReply({ type: 'agent_prompted', agent: idle }),
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await reconcile(db, client);
    expect(db.deliveryState().cursors.alice).toBeUndefined();
    await reconcile(db, client);
    const prompts = (await fake.calls()).filter((c) => c[1] === 'prompt');
    expect(prompts[0]![3]).toContain('urgent');
    expect(prompts[0]![3]).not.toContain('ordinary');
    expect(prompts[1]![3]).toContain(ordinary.body);
    expect(prompts[1]![3]).not.toContain('urgent');
  } finally {
    await fake.cleanup();
  }
});
it('refuses to interrupt a blocked Codex agent', async () => {
  const db = setup('blocked');
  const fake = await fakeHerdr([
    jsonReply({
      type: 'agent_info',
      agent: { ...agent, agent_status: 'blocked' },
    }),
  ]);
  try {
    let stderr = '';
    const code = await runCliAsync(['interrupt', 'alice'], {
      version: 'test',
      env: {
        ...fake.env,
        HERDR_TEAMS_HOME: db.home,
        HERDR_TEAMS_TEAM: db.team,
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('blocked');
    expect((await fake.calls()).some((c) => c[1] === 'send-keys')).toBe(false);
  } finally {
    await fake.cleanup();
  }
});

it('subscribes to socket events and resubscribes after events_lost', async () => {
  const { createServer } = await import('node:net');
  const { supervise } = await import('../src/supervisor/runtime.js');
  const db = setup();
  const socketPath = join(db.home, 'herdr.sock');
  const controller = new AbortController();
  let subscriptions = 0;
  let snapshots = 0;
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString()) as { method: string };
      expect(request.method).toBe('events.subscribe');
      subscriptions++;
      if (subscriptions === 1)
        socket.end(JSON.stringify({ error: { code: 'events_lost' } }) + '\n');
      else {
        controller.abort();
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const client = new HerdrClient({
    runner: async (_binary, argv) => {
      let result: unknown;
      if (argv[0] === 'session') {
        snapshots++;
        result = { type: 'session_snapshot', snapshot: {} };
      } else if (argv[0] === 'agent' && argv[1] === 'list')
        result = {
          type: 'agent_list',
          agents: [{ ...agent, completion_seq: 0, agent_status: 'working' }],
        };
      else return { stdout: 'unchanged', stderr: '', exitCode: 0 };
      return {
        stdout: JSON.stringify({ id: 'test', result }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await supervise(
      db,
      client,
      { HERDR_SOCKET_PATH: socketPath },
      controller.signal,
      () => {},
    );
    expect(subscriptions).toBe(2);
    expect(snapshots).toBeGreaterThanOrEqual(1);
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('does not open a supervisor for a team with no live members', async () => {
  const { ensureSupervisor } = await import('../src/supervisor/runtime.js');
  const db = setup();
  db.endMember('alice', 'shut-down');
  const fake = await fakeHerdr([]);
  try {
    await ensureSupervisor(db, new HerdrClient({ env: fake.env }));
    expect(db.config().supervisor?.pane_id).toBeUndefined();
    expect(await fake.calls()).toHaveLength(0);
  } finally {
    await fake.cleanup();
  }
});

it('closes its own pane and exits when no live members remain', async () => {
  const { createServer } = await import('node:net');
  const { supervise } = await import('../src/supervisor/runtime.js');
  const db = setup();
  db.endMember('alice', 'shut-down');
  const paneId = 'w9:pQ';
  db.updateTeam((team) => {
    team.supervisor = { mode: 'tab', pane_id: paneId };
  });
  const socketPath = join(db.home, 'herdr.sock');
  const controller = new AbortController();
  const calls: string[][] = [];
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString()) as { method: string };
      expect(request.method).toBe('events.subscribe');
      socket.write(
        JSON.stringify({
          id: 'herdr-teams-supervisor',
          result: { type: 'subscription_started' },
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const client = new HerdrClient({
    runner: async (_binary, argv) => {
      calls.push([...argv]);
      let result: unknown;
      if (argv[0] === 'session')
        result = { type: 'session_snapshot', snapshot: {} };
      else if (argv[0] === 'agent' && argv[1] === 'list')
        result = { type: 'agent_list', agents: [] };
      else return { stdout: '', stderr: '', exitCode: 0 };
      return {
        stdout: JSON.stringify({ id: 'test', result }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await supervise(
      db,
      client,
      { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: paneId },
      controller.signal,
      () => {},
    );
    expect(
      calls.some((c) => c[0] === 'pane' && c[1] === 'close' && c[2] === paneId),
    ).toBe(true);
    expect(db.config().supervisor?.pane_id).toBeUndefined();
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  [['steer', 'alice', 'stop that']],
  [['msg', 'send', 'alice', 'stop that', '--urgent']],
])('refuses urgent input from a teammate: %j', async (argv) => {
  const db = setup();
  db.addMember('bob');
  let stderr = '';
  const code = await runCliAsync(argv, {
    version: 'test',
    env: {
      HERDR_BIN_PATH: '/nonexistent/herdr',
      HERDR_TEAMS_HOME: db.home,
      HERDR_TEAMS_TEAM: db.team,
      HERDR_TEAMS_AGENT: 'bob',
    },
    stdout: () => {},
    stderr: (s) => {
      stderr += s;
    },
  });
  expect(code).toBe(1);
  expect(stderr).toContain('Only the lead');
  expect(db.inbox('alice')).toEqual([]);
});

it('lets a teammate send ordinary mail', async () => {
  const db = setup();
  db.addMember('bob');
  const code = await runCliAsync(['msg', 'send', 'alice', 'hello'], {
    version: 'test',
    env: {
      HERDR_BIN_PATH: '/nonexistent/herdr',
      HERDR_TEAMS_HOME: db.home,
      HERDR_TEAMS_TEAM: db.team,
      HERDR_TEAMS_AGENT: 'bob',
    },
    stdout: () => {},
    stderr: () => {},
  });
  expect(code).toBe(0);
  expect(db.inbox('alice')).toMatchObject([{ from: 'bob', urgent: false }]);
});
