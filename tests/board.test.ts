import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { snapshot, renderBoard } from '../src/board/model.js';
import { boardAction } from '../src/board/terminal.js';
import { syncSidebar } from '../src/supervisor/sidebar.js';
import { runCliAsync } from '../src/cli/index.js';
import { HerdrClient } from '../src/herdr/index.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'board-'));
  homes.push(home);
  const db = new Store(home, 'demo');
  db.create('lead');
  db.reserveMember('alice', {
    kind: 'codex',
    state: 'idle',
    pane_id: 'w1:p2',
    state_since: 1000,
  });
  db.updateTeam((t) => {
    t.workspace_id = 'w1';
  });
  return db;
}
it('renders task states, owners, dependencies, unread mail and offline supervision', () => {
  const db = setup();
  const task = db.add('Review');
  db.change(task.id, 'assign', 'lead', 'alice');
  db.send('lead', 'alice', 'pending mail');
  const data = snapshot(db, 61000);
  const text = renderBoard(data);
  expect(data.members.find((m) => m.name === 'alice')).toMatchObject({
    state: 'idle',
    seconds: 60,
    unread: 2,
  });
  expect(text).toContain('supervisor offline');
  expect(text).toContain('#1 Review');
  expect(text).toContain('owner alice');
});
it('board reads do not change cursors, tasks or events or call herdr', async () => {
  const db = setup();
  db.add('unassigned');
  db.send('lead', 'alice', 'pending');
  const before = readFileSync(join(db.root, 'events.jsonl'), 'utf8');
  const fake = await fakeHerdr([]);
  try {
    let output = '';
    expect(
      await runCliAsync(['--team', db.team, 'board', '--once'], {
        version: 'test',
        env: { ...fake.env, HERDR_TEAMS_HOME: db.home },
        stdout: (s) => {
          output += s;
        },
      }),
    ).toBe(0);
    expect(output).toContain('unassigned');
    expect(await fake.calls()).toHaveLength(0);
    expect(readFileSync(join(db.root, 'events.jsonl'), 'utf8')).toBe(before);
    expect(db.deliveryState().cursors).toEqual({});
  } finally {
    await fake.cleanup();
  }
});
it('routes controls through CLI arguments without shell interpolation', () => {
  expect(boardAction('m', 'alice', '1', '$(unsafe)')).toEqual([
    'msg',
    'send',
    'alice',
    '$(unsafe)',
  ]);
  expect(boardAction('r', 'alice', '1', 'reassign')).toEqual([
    'task',
    'release',
    '1',
    '--reason',
    'reassign',
  ]);
  expect(boardAction('p', 'alice', '1')).toEqual(['plan', 'approve', '1']);
  expect(boardAction('n', 'alice', '1', 'tests')).toEqual([
    'plan',
    'reject',
    '1',
    '--feedback',
    'tests',
  ]);
});
it('updates sidebar labels only when their content changes', async () => {
  const db = setup();
  const task = db.add('Review');
  db.change(task.id, 'claim', 'alice');
  const fake = await fakeHerdr([
    jsonReply({ type: 'ok' }),
    jsonReply({ type: 'ok' }),
    jsonReply({ type: 'ok' }),
    jsonReply({ type: 'ok' }),
  ]);
  try {
    const client = new HerdrClient({ env: fake.env });
    await syncSidebar(db, client);
    await syncSidebar(db, client);
    expect(await fake.calls()).toHaveLength(2);
    db.patchMember('alice', { advisory: 'needs-input' });
    await syncSidebar(db, client);
    expect(await fake.calls()).toHaveLength(4);
  } finally {
    await fake.cleanup();
  }
});
