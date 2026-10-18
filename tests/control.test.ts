import { addMember } from './helpers/members.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { applyEvent } from '../src/runtime/events.js';
import { reconcile } from '../src/runtime/delivery.js';
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
  });
  return db;
}
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
        HERDR_TEAMS_TEAM: db.id,
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

it.each([
  [['steer', 'alice', 'stop that']],
  [['msg', 'send', 'alice', 'stop that', '--urgent']],
])('refuses urgent input from a teammate: %j', async (argv) => {
  const db = setup();
  addMember(db, 'bob');
  let stderr = '';
  const code = await runCliAsync(argv, {
    version: 'test',
    env: {
      HERDR_BIN_PATH: '/nonexistent/herdr',
      HERDR_TEAMS_HOME: db.home,
      HERDR_TEAMS_TEAM: db.id,
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
  addMember(db, 'bob');
  const code = await runCliAsync(['msg', 'send', 'alice', 'hello'], {
    version: 'test',
    env: {
      HERDR_BIN_PATH: '/nonexistent/herdr',
      HERDR_TEAMS_HOME: db.home,
      HERDR_TEAMS_TEAM: db.id,
      HERDR_TEAMS_AGENT: 'bob',
    },
    stdout: () => {},
    stderr: () => {},
  });
  expect(code).toBe(0);
  expect(db.inbox('alice')).toMatchObject([{ from: 'bob', urgent: false }]);
});
