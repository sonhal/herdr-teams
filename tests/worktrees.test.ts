import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { Worktrees, git, worktreeStatus } from '../src/core/worktrees.js';
import { HerdrClient } from '../src/herdr/index.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';
import { agent } from './helpers/fixtures.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'worktrees-'));
  homes.push(home);
  git(home, 'init', '-b', 'main');
  writeFileSync(
    join(home, '.git', 'info', 'exclude'),
    'state/\nalice/\nbob/\n',
  );
  git(home, 'config', 'user.name', 'Test');
  git(home, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(home, 'base.txt'), 'base');
  git(home, 'add', '.');
  git(home, 'commit', '-m', 'base');
  const db = new Store(join(home, 'state'), 'demo');
  db.create('lead');
  db.updateTeam((team) => {
    team.repository_dir = home;
  });
  return { db, home };
}
it('isolates two writers and merges both only when explicitly requested', async () => {
  const { db, home } = setup();
  const commands: string[][] = [];
  const client = new HerdrClient({
    runner: async (_binary, args) => {
      commands.push([...args]);
      const branch = args[args.indexOf('--branch') + 1]!;
      const base = args[args.indexOf('--base') + 1]!;
      const path = join(home, branch.split('/').at(-1)!);
      git(home, 'worktree', 'add', '-b', branch, path, base);
      const result = {
        type: 'worktree_created',
        worktree: { path },
        root_pane: { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1' },
      };
      return {
        stdout: JSON.stringify({ id: 'test', result }),
        stderr: '',
        exitCode: 0,
      };
    },
  });
  const trees = new Worktrees(db, client);
  for (const member of ['alice', 'bob']) {
    db.reserveMember(member, { kind: 'codex', state: 'starting' });
    const tree = await trees.create(member);
    writeFileSync(join(tree.path, `${member}.txt`), member);
    git(tree.path, 'add', '.');
    git(tree.path, 'commit', '-m', member);
    expect(worktreeStatus(tree)).toMatchObject({ status: 'clean', ahead: 1 });
  }
  expect(git(home, 'log', '--oneline')).not.toContain('alice');
  await trees.merge('alice');
  await trees.merge('bob');
  expect(git(home, 'ls-files')).toContain('alice.txt');
  expect(git(home, 'ls-files')).toContain('bob.txt');
  expect(commands.every((args) => args.includes('--no-focus'))).toBe(true);
});
it('refuses running agents, dirty worktrees and unmerged branches before removal', async () => {
  const { db, home } = setup();
  const path = join(home, 'alice');
  git(home, 'worktree', 'add', '-b', 'team/demo/alice', path);
  const tree = {
    path,
    branch: 'team/demo/alice',
    base: git(home, 'rev-parse', 'HEAD'),
    pane_id: agent.pane_id,
    tab_id: agent.tab_id,
    workspace_id: agent.workspace_id,
  };
  db.reserveMember('alice', { kind: 'codex', state: 'idle', worktree: tree });
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [agent] }),
    jsonReply({ type: 'agent_list', agents: [] }),
    jsonReply({ type: 'agent_list', agents: [] }),
  ]);
  try {
    const trees = new Worktrees(db, new HerdrClient({ env: fake.env }));
    await expect(trees.remove('alice')).rejects.toThrow('running');
    writeFileSync(join(path, 'new.txt'), 'new');
    await expect(trees.remove('alice')).rejects.toThrow('dirty');
    git(path, 'add', '.');
    git(path, 'commit', '-m', 'unmerged');
    await expect(trees.remove('alice')).rejects.toThrow('unmerged');
    expect((await fake.calls()).some((args) => args[1] === 'remove')).toBe(
      false,
    );
  } finally {
    await fake.cleanup();
  }
});
