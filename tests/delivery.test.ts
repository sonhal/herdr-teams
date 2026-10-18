import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCliAsync } from '../src/cli/index.js';
import { Store } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { reconcile } from '../src/supervisor/delivery.js';
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
  const db = new Store(home, 'demo');
  db.create('lead');
  db.addMember('alice');
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
  db.send('lead', 'alice', 'restart mail');
  const fake = await fakeHerdr([list(), get, prompted]);
  try {
    expect(
      await runCliAsync(['_hook', 'startup'], {
        version: '0.1.0',
        env: { ...fake.env, HERDR_TEAMS_HOME: db.home },
      }),
    ).toBe(0);
    expect(db.deliveryState().cursors.alice).toBeDefined();
  } finally {
    await fake.cleanup();
  }
});
