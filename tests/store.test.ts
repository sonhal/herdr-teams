import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { runCliAsync } from '../src/cli/index.js';
const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'teams-'));
  homes.push(home);
  const db = new Store(home, randomUUID());
  db.create('lead', 'demo');
  return { home, db };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
describe('M1 store', () => {
  it('persists tasks, rejects blocked claims and cycles, and unblocks dependents', () => {
    const { home, db } = fixture();
    const a = db.add('first');
    const b = db.add('second');
    db.dependency(b.id, a.id);
    expect(() => db.dependency(a.id, b.id)).toThrow('cycle');
    expect(() => db.change(b.id, 'claim', 'lead')).toThrow('dependencies');
    db.change(a.id, 'claim', 'lead');
    db.change(a.id, 'complete', 'lead', 'finished');
    expect(new Store(home, db.id).task(a.id).result).toBe('finished');
    expect(db.change(b.id, 'claim', 'lead').status).toBe('in_progress');
    expect(() => db.change(b.id, 'claim', 'lead')).toThrow('claimed');
  });
  it('validates names, membership, and ownership', () => {
    const { home, db } = fixture();
    expect(() =>
      new Store(home, randomUUID()).create('lead', '../escape'),
    ).toThrow('Invalid name');
    expect(() => db.authorize('stranger')).toThrow('Unknown');
    const task = db.add('test');
    expect(() => db.change(task.id, 'complete', 'lead')).toThrow('owner');
    expect(() => db.send('lead', 'stranger', 'hello')).toThrow('recipient');
    expect(() => db.create('lead', 'demo')).toThrow();
  });
  it('stores messages and records events without advancing delivery', () => {
    const { db } = fixture();
    const message = db.send('lead', 'lead', 'hello', true);
    expect(db.inbox('lead')).toEqual([message]);
    expect(readFileSync(join(db.root, 'events.jsonl'), 'utf8')).toContain(
      'message.sent',
    );
  });
  it('wires real CLI commands and reports actionable errors', async () => {
    const { home, db } = fixture();
    let stdout = '';
    let stderr = '';
    const options = {
      version: 'test',
      env: { HERDR_TEAMS_HOME: home, HERDR_TEAMS_TEAM: db.id },
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    };
    expect(await runCliAsync(['task', 'add', 'hello', '--json'], options)).toBe(
      0,
    );
    expect(JSON.parse(stdout)).toMatchObject({
      subject: 'hello',
      status: 'pending',
    });
    expect(await runCliAsync(['task', 'claim', '999'], options)).toBe(1);
    expect(stderr).toContain('error:');
  });
  it('recovers an abandoned lock after the stale timeout', () => {
    const { db } = fixture();
    const lock = join(db.root, 'locks', 'store');
    mkdirSync(lock);
    const old = new Date(Date.now() - 120000);
    utimesSync(lock, old, old);
    expect(db.add('after interruption').id).toBe('1');
  });
  it('checks lead authority and notifies assigned tasks when dependencies complete', () => {
    const { db } = fixture();
    db.addMember('alice');
    expect(() => db.authorize('alice', true)).toThrow('Only the lead');
    const a = db.add('prerequisite');
    const b = db.add('dependent');
    db.change(b.id, 'assign', 'lead', 'alice');
    db.dependency(b.id, a.id);
    db.change(a.id, 'claim', 'lead');
    db.change(a.id, 'complete', 'lead');
    expect(db.inbox('alice').at(-1)?.body).toContain('unblocked');
    expect(db.change(b.id, 'claim', 'alice').owner).toBe('alice');
    expect(() => db.change(b.id, 'complete', 'lead')).toThrow('owner');
  });
  it('allows exactly one of 20 independent claimers to win', async () => {
    const { home, db } = fixture();
    const task = db.add('contended');
    for (let i = 0; i < 20; i++) db.addMember(`worker${i}`);
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        (_, index) =>
          new Promise<number | null>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                'dist/bin/herdr-teams.js',
                '--team',
                db.id,
                'task',
                'claim',
                task.id,
              ],
              {
                env: {
                  ...process.env,
                  HERDR_TEAMS_HOME: home,
                  HERDR_TEAMS_AGENT: `worker${index}`,
                },
                stdio: 'ignore',
              },
            );
            child.on('error', reject);
            child.on('exit', resolve);
          }),
      ),
    );
    expect(results.filter((code) => code === 0)).toHaveLength(1);
    expect(results.filter((code) => code === 1)).toHaveLength(19);
    expect(db.task(task.id).status).toBe('in_progress');
  });
});

it('refuses to bind a team to a second herdr session', () => {
  const home = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    const db = new Store(home, randomUUID());
    db.create('lead', 'demo');
    db.bindSession('session-a.sock');
    db.bindSession('session-a.sock');
    expect(() => db.bindSession('session-b.sock')).toThrow(
      /another herdr session/,
    );
    expect(db.config().herdr_socket).toBe('session-a.sock');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('creates a team under an id-keyed dir with id and name in config', () => {
  const { home } = fixture();
  const id = randomUUID();
  const db = new Store(home, id);
  const team = db.create('lead', 'demo');
  expect(team.id).toBe(id);
  expect(team.name).toBe('demo');
  expect(db.root).toBe(join(home, 'teams', id));
  expect(new Store(home, id).config().name).toBe('demo');
});

it('allows two same-name teams under different ids', () => {
  const home = mkdtempSync(join(tmpdir(), 'teams-'));
  homes.push(home);
  const a = new Store(home, randomUUID());
  a.create('lead', 'dev');
  const b = new Store(home, randomUUID());
  b.create('lead', 'dev');
  expect(a.config().name).toBe('dev');
  expect(b.config().name).toBe('dev');
  expect(a.root).not.toBe(b.root);
  expect(Store.teams(home).map((t) => t.name)).toEqual(['dev', 'dev']);
});

it('rejects an invalid display name but accepts any uuid id', () => {
  const { home } = fixture();
  expect(() =>
    new Store(home, randomUUID()).create('lead', '../escape'),
  ).toThrow('Invalid name');
  expect(() =>
    new Store(home, randomUUID()).create('lead', 'dev'),
  ).not.toThrow();
});
