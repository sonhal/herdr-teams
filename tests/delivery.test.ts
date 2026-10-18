import { addMember } from './helpers/members.js';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { runCliAsync } from '../src/cli/index.js';
import { MAX_MESSAGE_BYTES, Store } from '../src/core/store.js';
import { Hooks } from '../src/core/hooks.js';
import { HerdrClient } from '../src/herdr/index.js';
import { reconcile } from '../src/runtime/delivery.js';
import { agent } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';

const homes: string[] = [];
afterEach(() =>
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'delivery-'));
  homes.push(home);
  const db = new Store(home, randomUUID());
  db.create('lead', 'demo');
  addMember(db, 'alice');
  return db;
}
const idle = { ...agent, completion_seq: 0 };
const list = (status = 'idle') =>
  jsonReply({
    type: 'agent_list',
    agents: [{ ...idle, agent_status: status }],
  });
const get = jsonReply({ type: 'agent_info', agent: idle });
const prompted = jsonReply({ type: 'agent_prompted', agent: idle });

it('batches waiting mail and duplicate reconciliation does not redeliver', async () => {
  const db = setup();
  db.send('lead', 'alice', 'first');
  db.send('lead', 'alice', 'second');
  const fake = await fakeHerdr([list(), get, prompted, list()]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await reconcile(db, client);
    await reconcile(db, client);
    const prompts = (await fake.calls()).filter((c) => c[1] === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]![3]).toContain('first');
    expect(prompts[0]![3]).toContain('second');
    expect(prompts[0]![3]).toContain('teammate, not the user');
  } finally {
    await fake.cleanup();
  }
});

it.each(['working', 'blocked', 'unknown'])(
  'does not prompt a %s recipient',
  async (status) => {
    const db = setup();
    db.send('lead', 'alice', 'waiting');
    const fake = await fakeHerdr([list(status)]);
    try {
      await reconcile(db, new HerdrClient({ env: fake.env }));
      expect(await fake.calls()).toHaveLength(1);
      expect(db.deliveryState().cursors).toEqual({});
    } finally {
      await fake.cleanup();
    }
  },
);

it('keeps mail pending after prompt failure', async () => {
  const db = setup();
  db.send('lead', 'alice', 'retry');
  const fake = await fakeHerdr([
    list(),
    get,
    { exitCode: 3, stderr: 'failed' },
    list(),
    get,
    prompted,
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await expect(reconcile(db, client)).rejects.toThrow();
    expect(db.deliveryState().cursors).toEqual({});
    await reconcile(db, client);
    expect(db.deliveryState().cursors.alice).toBeDefined();
  } finally {
    await fake.cleanup();
  }
});

it('claims only an unblocked task and queues its prompt durably', async () => {
  const db = setup();
  const first = db.add('first');
  const blocked = db.add('blocked');
  db.dependency(blocked.id, first.id);
  const fake = await fakeHerdr([list(), get, prompted]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    expect(db.task(first.id)).toMatchObject({
      owner: 'alice',
      status: 'in_progress',
    });
    expect(db.task(blocked.id).owner).toBeNull();
    expect(db.inbox('alice')[0]!.body).toContain('first');
  } finally {
    await fake.cleanup();
  }
});

it('coalesces completed-turn reports using completion sequence', async () => {
  const db = setup();
  const completed = jsonReply({ type: 'agent_list', agents: [agent] });
  const fake = await fakeHerdr([
    completed,
    { stdout: 'Codex result' },
    completed,
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await reconcile(db, client);
    await reconcile(db, client);
    expect(db.inbox('lead')).toHaveLength(1);
    expect(db.inbox('lead')[0]!.body).toContain('Codex result');
  } finally {
    await fake.cleanup();
  }
});

it('rechecks live state before prompting', async () => {
  const db = setup();
  db.send('lead', 'alice', 'waiting');
  const fake = await fakeHerdr([
    list(),
    jsonReply({
      type: 'agent_info',
      agent: { ...idle, agent_status: 'blocked' },
    }),
  ]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    expect((await fake.calls()).some((c) => c[1] === 'prompt')).toBe(false);
    expect(db.deliveryState().cursors).toEqual({});
  } finally {
    await fake.cleanup();
  }
});

it('does not recursively quote generated reports on later turns', async () => {
  const db = setup();
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [agent] }),
    { stdout: 'first output' },
    jsonReply({
      type: 'agent_list',
      agents: [{ ...agent, completion_seq: 5 }],
    }),
    { stdout: 'second output' },
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await reconcile(db, client);
    await reconcile(db, client);
    expect(db.inbox('lead')[1]!.body).toContain('second output');
    expect(db.inbox('lead')[1]!.body).not.toContain('first output');
  } finally {
    await fake.cleanup();
  }
});

it('startup hooks flush mail without a team identity', async () => {
  const db = setup();
  db.bindSession('session-a.sock');
  db.send('lead', 'alice', 'restart mail');
  const fake = await fakeHerdr([list(), get, prompted]);
  try {
    expect(
      await runCliAsync(['_hook', 'startup'], {
        version: '0.1.0',
        env: {
          ...fake.env,
          HERDR_TEAMS_HOME: db.home,
          HERDR_SOCKET_PATH: 'session-a.sock',
        },
      }),
    ).toBe(0);
    expect(db.deliveryState().cursors.alice).toBeDefined();
  } finally {
    await fake.cleanup();
  }
});

it('supports valid member names that match object prototype properties', async () => {
  const db = setup();
  addMember(db, 'constructor');
  const recipient = { ...idle, name: 'constructor' };
  db.send('lead', 'constructor', 'valid name');
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [recipient] }),
    jsonReply({ type: 'agent_info', agent: recipient }),
    jsonReply({ type: 'agent_prompted', agent: recipient }),
  ]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    expect(db.deliveryState().cursors.constructor).toBeDefined();
  } finally {
    await fake.cleanup();
  }
});

it('does not prompt a replacement agent that took over the pane', async () => {
  const db = setup();
  db.send('lead', 'alice', 'private mail');
  const fake = await fakeHerdr([
    list(),
    jsonReply({ type: 'agent_info', agent: { ...idle, name: 'other' } }),
  ]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    expect((await fake.calls()).some((c) => c[1] === 'prompt')).toBe(false);
    expect(db.deliveryState().cursors).toEqual({});
  } finally {
    await fake.cleanup();
  }
});

function team(home: string, name: string, socket: string) {
  const db = new Store(home, randomUUID());
  db.create('lead', name);
  db.updateTeam((config) => {
    config.herdr_socket = socket;
    config.lead_pane_id = idle.pane_id;
  });
  return db;
}

it('reconciles only the selected team after a command', async () => {
  const alpha = setup();
  alpha.bindSession('session-a.sock');
  const beta = team(alpha.home, 'beta', 'session-a.sock');
  beta.reserveMember('bob', {
    kind: 'codex',
    pane_id: 'w1:p9',
    state: 'working',
  });
  const task = beta.add('beta work');
  beta.change(task.id, 'claim', 'bob');
  beta.send('bob', 'lead', 'beta lead mail');
  const fake = await fakeHerdr([list('working')]);
  try {
    expect(
      await runCliAsync(['--team', alpha.id, 'task', 'list'], {
        version: '0.1.0',
        env: {
          ...fake.env,
          HERDR_TEAMS_HOME: alpha.home,
          HERDR_SOCKET_PATH: 'session-a.sock',
        },
        stdout: () => {},
      }),
    ).toBe(0);
    expect(await fake.calls()).toEqual([['agent', 'list']]);
    expect(beta.config().details!.bob!.ended).toBeUndefined();
    expect(beta.task(task.id).status).toBe('in_progress');
    expect(beta.deliveryState().cursors).toEqual({});
  } finally {
    await fake.cleanup();
  }
});

it('startup hooks skip teams that belong to another herdr session', async () => {
  const db = setup();
  db.bindSession('session-a.sock');
  const other = team(db.home, 'beta', 'session-b.sock');
  other.send('lead', 'lead', 'other session mail');
  db.send('lead', 'alice', 'restart mail');
  const fake = await fakeHerdr([list(), get, prompted]);
  try {
    expect(
      await runCliAsync(['_hook', 'startup'], {
        version: '0.1.0',
        env: {
          ...fake.env,
          HERDR_TEAMS_HOME: db.home,
          HERDR_SOCKET_PATH: 'session-a.sock',
        },
      }),
    ).toBe(0);
    expect(db.deliveryState().cursors.alice).toBeDefined();
    expect(other.deliveryState().cursors).toEqual({});
    expect(await fake.calls()).toHaveLength(3);
  } finally {
    await fake.cleanup();
  }
});

it('delivers lead mail to whichever agent runs in the lead pane', async () => {
  const db = team(
    mkdtempSync(join(tmpdir(), 'delivery-')),
    'demo',
    'session-a.sock',
  );
  homes.push(db.home);
  addMember(db, 'alice');
  db.send('alice', 'lead', 'for the lead');
  const lead = { ...idle, name: 'renamed-by-user' };
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [lead] }),
    jsonReply({ type: 'agent_info', agent: lead }),
    jsonReply({ type: 'agent_prompted', agent: lead }),
  ]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    const prompts = (await fake.calls()).filter((c) => c[1] === 'prompt');
    expect(prompts.map((c) => c[2])).toEqual([idle.pane_id]);
    expect(db.deliveryState().cursors.lead).toBeDefined();
  } finally {
    await fake.cleanup();
  }
});

it('rejects message bodies that cannot be passed as one argument', () => {
  const db = setup();
  expect(() => db.send('lead', 'alice', 'x'.repeat(200 * 1024))).toThrow(
    /bytes/,
  );
  expect(db.inbox('alice')).toEqual([]);
});

it('bounds each prompt and keeps delivering to other members', async () => {
  const db = setup();
  addMember(db, 'bob');
  // Mail written before the size limit existed.
  appendFileSync(
    join(db.root, 'inboxes', 'alice.jsonl'),
    JSON.stringify({
      id: 'legacy',
      from: 'lead',
      to: 'alice',
      body: 'x'.repeat(200 * 1024),
      urgent: false,
      createdAt: new Date().toISOString(),
    }) + '\n',
  );
  db.send('lead', 'bob', 'hello bob');
  const bob = { ...idle, name: 'bob', pane_id: 'w1:p3' };
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [idle, bob] }),
    get,
    { exitCode: 3, stderr: 'alice failed' },
    jsonReply({ type: 'agent_info', agent: bob }),
    jsonReply({ type: 'agent_prompted', agent: bob }),
  ]);
  try {
    await expect(
      reconcile(db, new HerdrClient({ env: fake.env })),
    ).rejects.toThrow(/alice/);
    const prompts = (await fake.calls()).filter((c) => c[1] === 'prompt');
    expect(prompts.map((c) => c[2])).toEqual(['w1:p2', 'w1:p3']);
    for (const prompt of prompts)
      expect(Buffer.byteLength(prompt[3]!)).toBeLessThan(128 * 1024);
    expect(db.deliveryState().cursors.bob).toBeDefined();
    expect(db.deliveryState().cursors.alice).toBeUndefined();
  } finally {
    await fake.cleanup();
  }
});

it('splits a large backlog into prompts that fit one argument', async () => {
  const db = setup();
  for (let i = 0; i < 6; i++)
    db.send('lead', 'alice', `${i}`.repeat(30 * 1024));
  const fake = await fakeHerdr([list(), get, prompted, list(), get, prompted]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await reconcile(db, client);
    await reconcile(db, client);
    const prompts = (await fake.calls()).filter((c) => c[1] === 'prompt');
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts)
      expect(Buffer.byteLength(prompt[3]!)).toBeLessThan(128 * 1024);
    expect(db.deliveryState().cursors.alice).toBe(db.inbox('alice').at(-1)!.id);
  } finally {
    await fake.cleanup();
  }
});

it('presses Esc once per urgent message for a working agent', async () => {
  const db = setup();
  db.reserveMember('bob', {
    kind: 'claude',
    pane_id: 'w1:p3',
    state: 'working',
  });
  db.send('lead', 'bob', 'stop and listen', true);
  const bob = {
    ...idle,
    name: 'bob',
    pane_id: 'w1:p3',
    agent_status: 'working',
  };
  const working = jsonReply({ type: 'agent_list', agents: [bob] });
  const info = jsonReply({ type: 'agent_info', agent: bob });
  const fake = await fakeHerdr([
    working,
    info,
    jsonReply({ type: 'keys_sent' }),
    working,
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await reconcile(db, client);
    await reconcile(db, client);
    const keys = (await fake.calls()).filter((c) => c[1] === 'send-keys');
    expect(keys).toHaveLength(1);
  } finally {
    await fake.cleanup();
  }
});

it('creates a team from an ordinary herdr pane in the hooks’ state home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'delivery-'));
  homes.push(home);
  const state = join(
    home,
    '.local',
    'state',
    'herdr',
    'plugins',
    'herdr-teams',
  );
  const fake = await fakeHerdr([jsonReply({ type: 'agent_list', agents: [] })]);
  try {
    let stdout = '';
    let stderr = '';
    const env = {
      HERDR_BIN_PATH: fake.binary,
      HERDR_ENV: '1',
      HOME: home,
      HERDR_SOCKET_PATH: 'session-a.sock',
      HERDR_PANE_ID: 'w1:p1',
    };
    expect(
      await runCliAsync(['team', 'create', 'demo'], {
        version: '0.1.0',
        env,
        stdout: (s) => {
          stdout += s;
        },
        stderr: (s) => {
          stderr += s;
        },
      }),
    ).toBe(0);
    expect(stderr).toBe('');
    const id = JSON.parse(stdout).id as string;
    expect(new Store(state, id).config()).toMatchObject({
      herdr_socket: 'session-a.sock',
      lead_pane_id: 'w1:p1',
    });
    expect(await fake.calls()).toHaveLength(1);
  } finally {
    await fake.cleanup();
  }
});

it('warns when a team is created outside the hooks’ state home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'delivery-'));
  homes.push(home);
  let stdout = '';
  let stderr = '';
  await runCliAsync(['team', 'create', 'demo'], {
    version: '0.1.0',
    env: {
      HERDR_BIN_PATH: '/nonexistent/herdr',
      HERDR_ENV: '1',
      HOME: home,
      HERDR_TEAMS_HOME: join(home, 'elsewhere'),
    },
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  expect(stderr).toContain('startup and event hooks read');
  const id = JSON.parse(stdout).id as string;
  expect(new Store(join(home, 'elsewhere'), id).config().name).toBe('demo');
});

it('clips large hook output instead of failing after the hook ran', () => {
  const db = setup();
  new Hooks(db, {}).failure('alice', undefined, {
    code: 1,
    stderr: 'x'.repeat(200 * 1024),
  });
  const advisory = db.inbox('lead').at(-1)!;
  expect(Buffer.byteLength(advisory.body)).toBeLessThanOrEqual(
    MAX_MESSAGE_BYTES,
  );
  expect(advisory.body).toContain('bytes omitted');
});

it('delivers to a teammate under its herdr name, not a same-named agent of another team', async () => {
  const db = setup();
  db.updateTeam((team) => {
    team.details = {
      alice: {
        kind: 'codex',
        agent_name: 'demo-alice',
        pane_id: idle.pane_id,
        state: 'idle',
      },
    };
  });
  db.send('lead', 'alice', 'hello');
  const ours = { ...idle, name: 'demo-alice' };
  const fake = await fakeHerdr([
    jsonReply({
      type: 'agent_list',
      agents: [{ ...idle, name: 'alice', pane_id: 'w1:p9' }, ours],
    }),
    jsonReply({ type: 'agent_info', agent: ours }),
    jsonReply({ type: 'agent_prompted', agent: ours }),
  ]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    const prompts = (await fake.calls()).filter((c) => c[1] === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]![2]).toBe(idle.pane_id);
    expect(prompts[0]![3]).toContain('hello');
  } finally {
    await fake.cleanup();
  }
});

it('labels system notices as herdr-teams notices without a reply hint', async () => {
  const db = setup();
  db.send('alice', 'lead', 'alice: crashed\nlast output', false, 'advisory');
  db.updateTeam((team) => {
    team.lead_pane_id = idle.pane_id;
  });
  const fake = await fakeHerdr([list(), get, prompted]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    const prompt = (await fake.calls()).find((c) => c[1] === 'prompt')![3]!;
    expect(prompt).toContain('[herdr-teams] notice about alice');
    expect(prompt).toContain('alice: crashed');
    expect(prompt).not.toContain('teammate, not the user');
    expect(prompt).not.toContain('Reply:');
  } finally {
    await fake.cleanup();
  }
});

it('reconciles an idle event that arrives while delivery holds the lease', async () => {
  const db = setup();
  db.send('lead', 'alice', 'waiting');
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lists = 0;
  let prompts = 0;
  const client = new HerdrClient({
    runner: async (_bin, argv) => {
      let result: unknown;
      if (argv[1] === 'list') {
        lists++;
        if (lists === 1) {
          started();
          await blocked;
        }
        result = {
          type: 'agent_list',
          agents: [{ ...idle, agent_status: lists === 1 ? 'working' : 'idle' }],
        };
      } else if (argv[1] === 'get')
        result = { type: 'agent_info', agent: idle };
      else {
        prompts++;
        result = { type: 'agent_prompted', agent: idle };
      }
      return {
        stdout: JSON.stringify({ id: 'test', result }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  const first = reconcile(db, client);
  await entered;
  const second = reconcile(db, client);
  // The first pass holds a working snapshot; the later hook must recheck it.
  release();
  await Promise.all([first, second]);
  expect(lists).toBe(2);
  expect(prompts).toBe(1);
  expect(db.deliveryState().cursors.alice).toBe(db.inbox('alice').at(-1)!.id);
});

it('event hooks wake the lead with one completion report across repeated events', async () => {
  const db = setup();
  db.bindSession('hook-session.sock');
  db.updateTeam((team) => {
    team.lead_pane_id = 'w1:p1';
  });
  db.updateTeam((team) => {
    team.details = {
      alice: { kind: 'codex', pane_id: idle.pane_id, state: 'working' },
    };
  });
  const lead = { ...idle, name: 'current-lead', pane_id: 'w1:p1' };
  const completed = { ...idle, completion_seq: 1 };
  const agents = jsonReply({ type: 'agent_list', agents: [lead, completed] });
  // herdr v0.9.5: lifecycle hook payload uses pane_id; metadata commands are quiet.
  const fake = await fakeHerdr([
    agents,
    { stdout: 'Finished the task' },
    jsonReply({ type: 'agent_info', agent: lead }),
    jsonReply({ type: 'agent_prompted', agent: lead }),
    { stdout: '' },
    { stdout: '' },
    agents,
  ]);
  try {
    const options = {
      version: 'test',
      env: {
        ...fake.env,
        HERDR_TEAMS_HOME: db.home,
        HERDR_SOCKET_PATH: 'hook-session.sock',
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          event: 'pane_agent_status_changed',
          data: { pane_id: idle.pane_id },
        }),
      },
      stdout: () => {},
      stderr: () => {},
    };
    expect(await runCliAsync(['_hook', 'event'], options)).toBe(0);
    expect(await runCliAsync(['_hook', 'event'], options)).toBe(0);
    expect(db.inbox('lead').filter((m) => m.kind === 'report')).toHaveLength(1);
    const calls = await fake.calls();
    const prompts = calls.filter((c) => c[1] === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]![2]).toBe(lead.pane_id);
    expect(prompts[0]![3]).toContain('Finished the task');
    expect(calls.some((c) => c[0] === 'plugin')).toBe(false);
  } finally {
    await fake.cleanup();
  }
});

it('ignores events for unrelated panes before querying herdr', async () => {
  const db = setup();
  db.bindSession('hook-session.sock');
  const fake = await fakeHerdr([]);
  try {
    expect(
      await runCliAsync(['_hook', 'event'], {
        version: 'test',
        env: {
          ...fake.env,
          HERDR_TEAMS_HOME: db.home,
          HERDR_SOCKET_PATH: 'hook-session.sock',
          HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
            event: 'pane.closed',
            data: { pane_id: 'w9:p9' },
          }),
        },
      }),
    ).toBe(0);
    expect(await fake.calls()).toEqual([]);
  } finally {
    await fake.cleanup();
  }
});

it('recovers an abandoned delivery lease and completes the pending pass', async () => {
  const db = setup();
  const lease = join(db.root, 'locks', 'delivery');
  mkdirSync(lease);
  writeFileSync(join(lease, 'owner.json'), JSON.stringify({ pid: 99999999 }));
  const old = new Date(Date.now() - 61000);
  utimesSync(lease, old, old);
  db.send('lead', 'alice', 'after recovery');
  const fake = await fakeHerdr([list(), get, prompted]);
  try {
    await reconcile(db, new HerdrClient({ env: fake.env }));
    expect(db.deliveryState().cursors.alice).toBe(db.inbox('alice').at(-1)!.id);
    expect((await fake.calls()).filter((c) => c[1] === 'prompt')).toHaveLength(
      1,
    );
  } finally {
    await fake.cleanup();
  }
});

it('runs teammate_idle hooks without holding delivery for later events', async () => {
  const db = setup();
  const home = mkdtempSync(join(tmpdir(), 'idle-hook-'));
  homes.push(home);
  db.updateTeam((team) => {
    team.repository_dir = home;
  });
  const marker = join(home, 'started');
  const hooks = join(home, '.herdr', 'teams', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, 'teammate_idle'),
    `#!/bin/sh\ntouch "${marker}"\nsleep 2\n`,
  );
  chmodSync(join(hooks, 'teammate_idle'), 0o755);
  const finished = { ...idle, completion_seq: 1 };
  const client = new HerdrClient({
    runner: async (_binary, argv) => {
      if (argv[0] === 'pane')
        return { stdout: 'output', stderr: '', exitCode: 0 };
      const result =
        argv[1] === 'list'
          ? { type: 'agent_list', agents: [finished] }
          : argv[1] === 'get'
            ? { type: 'agent_info', agent: finished }
            : { type: 'agent_prompted', agent: finished };
      return {
        stdout: JSON.stringify({ id: 'test', result }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  const first = reconcile(db, client);
  while (!existsSync(marker))
    await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await reconcile(db, client);
  expect(Date.now() - started).toBeLessThan(1500);
  await first;
  expect(db.inbox('lead').filter((m) => m.kind === 'report')).toHaveLength(1);
});
