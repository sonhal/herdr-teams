import { addMember } from './helpers/members.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { Tasks } from '../src/core/tasks.js';
import { Plans } from '../src/core/plans.js';
import { Hooks } from '../src/core/hooks.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'gates-'));
  homes.push(home);
  const db = new Store(join(home, 'state'), randomUUID());
  db.create('lead', 'demo');
  addMember(db, 'alice');
  db.updateTeam((t) => {
    t.repository_dir = home;
  });
  return {
    db,
    home,
    tasks: new Tasks(db, process.env),
    plans: new Plans(db, process.env),
  };
}
function script(home: string, event: string, text: string) {
  const dir = join(home, '.herdr', 'teams', 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, event);
  writeFileSync(path, '#!/bin/sh\n' + text);
  chmodSync(path, 0o755);
  return path;
}
it('a failing npm test keeps the task open and reports only as the command error', async () => {
  const { db, home, tasks } = setup();
  writeFileSync(
    join(home, 'package.json'),
    JSON.stringify({
      scripts: {
        test: 'node -e "console.error(\'gate failed\');process.exit(1)"',
      },
    }),
  );
  const task = await tasks.add('lead', 'test gate', { gate: 'npm test' });
  db.change(task.id, 'claim', 'alice');
  await expect(tasks.complete(task.id, 'alice')).rejects.toThrow('gate failed');
  expect(db.task(task.id).status).toBe('in_progress');
  expect(db.inbox('alice')).toEqual([]);
});
it('rejects task creation with exit 2 before storing a record', async () => {
  const { db, home, tasks } = setup();
  script(home, 'task_created', 'echo "add acceptance criteria" >&2\nexit 2\n');
  await expect(tasks.add('lead', 'too vague')).rejects.toThrow(
    'acceptance criteria',
  );
  expect(db.tasks()).toHaveLength(0);
});
it('versions plans, records rejection feedback and requires approval for completion', async () => {
  const { db, tasks, plans } = setup();
  const task = await tasks.add('lead', 'planned', { planMode: true });
  db.change(task.id, 'claim', 'alice');
  await expect(tasks.complete(task.id, 'alice')).rejects.toThrow('approval');
  await plans.submit(task.id, 'alice', 'First plan');
  plans.verdict(task.id, false, 'Add tests');
  const second = await plans.submit(task.id, 'alice', 'Second plan');
  expect(second.plan!.version).toBe(2);
  expect(readFileSync(join(db.root, 'plans', '1-1.md'), 'utf8')).toBe(
    'First plan',
  );
  plans.verdict(task.id, true);
  await tasks.complete(task.id, 'alice', 'done');
  plans.verdict(task.id, false, 'Late feedback');
  expect(db.task(task.id).status).toBe('completed');
});
it('approval none permits progress after submission', async () => {
  const { db, tasks, plans } = setup();
  db.updateTeam((t) => {
    t.plan_approval = 'none';
  });
  const task = await tasks.add('lead', 'plan', { planMode: true });
  db.change(task.id, 'claim', 'alice');
  expect((await plans.submit(task.id, 'alice', 'Proceed')).status).toBe(
    'in_progress',
  );
  expect((await tasks.complete(task.id, 'alice')).status).toBe('completed');
});
it('passes stdin and identity and preserves the original pi hook argument', async () => {
  const { db, home, tasks } = setup();
  script(
    home,
    'task_completed',
    'cat > hook-input.json\nprintf "%s" "$HERDR_TEAMS_TASK_ID:$HERDR_TEAMS_AGENT" > hook-identity\n',
  );
  const dir = join(home, '.pi', 'team-hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'task_completed.sh');
  writeFileSync(
    path,
    '#!/bin/sh\nprintf "%s" "$1" > pi-payload.json\nprintf "%s" "$PI_TEAM" > pi-team\n',
  );
  chmodSync(path, 0o755);
  const task = await tasks.add('lead', 'hook contract');
  db.change(task.id, 'claim', 'alice');
  await tasks.complete(task.id, 'alice');
  expect(
    JSON.parse(readFileSync(join(home, 'hook-input.json'), 'utf8')),
  ).toMatchObject({ event: 'task_completed', actor: 'alice' });
  expect(readFileSync(join(home, 'hook-identity'), 'utf8')).toBe('1:alice');
  expect(
    JSON.parse(readFileSync(join(home, 'pi-payload.json'), 'utf8')),
  ).toMatchObject({ status: 'completed', id: task.id });
  expect(readFileSync(join(home, 'pi-team'), 'utf8')).toBe(db.id);
});
it('warns the lead about a failing gate but not about a deliberate rejection', async () => {
  const { db, tasks } = setup();
  const failing = await tasks.add('lead', 'fails', { gate: 'exit 1' });
  const rejected = await tasks.add('lead', 'rejected', {
    gate: 'echo "add a test" >&2; exit 2',
  });
  db.change(failing.id, 'claim', 'alice');
  await expect(tasks.complete(failing.id, 'alice')).rejects.toThrow();
  expect(db.inbox('lead').map((m) => m.kind)).toEqual(['advisory']);
  db.change(failing.id, 'release', 'lead');
  db.change(rejected.id, 'claim', 'alice');
  await expect(tasks.complete(rejected.id, 'alice')).rejects.toThrow(
    'add a test',
  );
  expect(db.inbox('lead')).toHaveLength(1);
  expect(db.inbox('alice')).toEqual([]);
  expect(db.tasks().map((t) => t.status)).toEqual(['pending', 'in_progress']);
});
it('times out a hung hook and leaves the task open', async () => {
  const { db, tasks } = setup();
  db.updateTeam((t) => {
    t.hooks = { timeout_seconds: 0.05 };
  });
  const task = await tasks.add('lead', 'hung', {
    gate: 'node -e "setInterval(()=>{},1000)"',
  });
  db.change(task.id, 'claim', 'alice');
  await expect(tasks.complete(task.id, 'alice')).rejects.toThrow('timed out');
  expect(db.task(task.id).status).toBe('in_progress');
});
it('rejects idle hooks with exit 2 and queues their feedback', async () => {
  const { db, home } = setup();
  script(home, 'teammate_idle', 'echo "finish the test" >&2\nexit 2\n');
  const hooks = new Hooks(db, process.env);
  const outcome = await hooks.run('teammate_idle', 'alice');
  hooks.failure('alice', undefined, outcome);
  expect(db.inbox('alice')[0]!.body).toContain('finish the test');
});

it('does not complete a task released while its gate was running', async () => {
  const { db, tasks } = setup();
  const task = await tasks.add('lead', 'race', {
    gate: 'node -e "setTimeout(()=>{},100)"',
  });
  db.change(task.id, 'claim', 'alice');
  const completion = tasks.complete(task.id, 'alice');
  const timer = setTimeout(() => db.change(task.id, 'release', 'lead'), 10);
  try {
    await expect(completion).rejects.toThrow('changed');
    expect(db.task(task.id).status).toBe('pending');
  } finally {
    clearTimeout(timer);
  }
});

it('keeps a task released while its failing gate ran released', async () => {
  const { db, tasks } = setup();
  const task = await tasks.add('lead', 'race failure', {
    gate: 'node -e "setTimeout(()=>process.exit(1),100)"',
  });
  db.change(task.id, 'claim', 'alice');
  const completion = tasks.complete(task.id, 'alice');
  const timer = setTimeout(() => db.change(task.id, 'release', 'lead'), 10);
  try {
    await expect(completion).rejects.toThrow('changed');
    expect(db.task(task.id)).toMatchObject({
      status: 'pending',
      owner: null,
      reopens: 0,
    });
    expect(db.tasks()).toHaveLength(1);
  } finally {
    clearTimeout(timer);
  }
});

it('runs a gate for a task with the largest text it accepts', async () => {
  const { db, tasks } = setup();
  // Control characters grow sixfold as JSON, as in the hook environment.
  const text = '\u0001'.repeat(5000);
  const task = await tasks.add('lead', 'large', {
    description: text,
    gate: 'exit 0',
  });
  db.change(task.id, 'claim', 'alice');
  expect((await tasks.complete(task.id, 'alice', text)).status).toBe(
    'completed',
  );
});
