import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { Tasks } from '../src/core/tasks.js';
import { runCliAsync } from '../src/cli/index.js';
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
  const db = new Store(join(home, 'state'), randomUUID());
  db.create('lead', 'demo');
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
    const tree = await trees.create(member, home);
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

it('cleanup --apply removes every eligible worktree past one that fails', async () => {
  const { db, home } = setup();
  const base = git(home, 'rev-parse', 'HEAD');
  for (const [member, workspace] of [
    ['alice', 'w2'],
    ['bob', 'w3'],
  ] as const) {
    const path = join(home, member);
    git(home, 'worktree', 'add', '-b', `team/demo/${member}`, path);
    db.reserveMember(member, {
      kind: 'codex',
      state: 'killed',
      ended: 'killed',
      worktree: {
        path,
        branch: `team/demo/${member}`,
        base,
        pane_id: `${workspace}:p1`,
        tab_id: `${workspace}:t1`,
        workspace_id: workspace,
      },
    });
  }
  writeFileSync(join(home, 'alice', 'alice.txt'), 'alice');
  git(join(home, 'alice'), 'add', '.');
  git(join(home, 'alice'), 'commit', '-m', 'unmerged');
  const fake = await fakeHerdr([
    jsonReply({ type: 'agent_list', agents: [] }),
    jsonReply({ type: 'agent_list', agents: [] }),
    jsonReply({ type: 'worktree_removed' }),
  ]);
  let stderr = '';
  try {
    const code = await runCliAsync(['cleanup', '--apply'], {
      version: 'test',
      env: { ...fake.env, HERDR_TEAMS_HOME: db.home, HERDR_TEAMS_TEAM: db.id },
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('alice');
    expect(db.config().details!.alice!.worktree).toBeDefined();
    expect(db.config().details!.bob!.worktree).toBeUndefined();
    expect((await fake.calls()).at(-1)).toEqual([
      'worktree',
      'remove',
      '--workspace',
      'w3',
    ]);
  } finally {
    await fake.cleanup();
  }
});
it('reports branch, head, commit count and checkout state on completion', async () => {
  const { db, home } = setup();
  const path = join(home, 'alice');
  const base = git(home, 'rev-parse', 'HEAD');
  git(home, 'worktree', 'add', '-b', 'team/demo/alice', path);
  db.reserveMember('alice', {
    kind: 'codex',
    state: 'idle',
    worktree: {
      path,
      branch: 'team/demo/alice',
      base,
      pane_id: agent.pane_id,
      tab_id: agent.tab_id,
      workspace_id: agent.workspace_id,
    },
  });
  writeFileSync(join(path, 'new.txt'), 'new');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'work');
  const head = git(path, 'rev-parse', 'HEAD');
  const task = db.add('Write new.txt');
  db.change(task.id, 'claim', 'alice');
  await new Tasks(db, {}).complete(task.id, 'alice');
  expect(db.inbox('lead').at(-1)!.body).toBe(
    `Completed task #${task.id}: Write new.txt\nWorktree: team/demo/alice at ${head.slice(0, 12)}, 1 commit(s) on ${base.slice(0, 12)}, clean`,
  );
});
it('warns the caller, not the lead inbox, about uncommitted lead changes', async () => {
  const { db, home } = setup();
  writeFileSync(join(home, 'base.txt'), 'edited');
  const client = new HerdrClient({
    runner: async (_binary, args) => {
      const branch = args[args.indexOf('--branch') + 1]!;
      const path = join(home, branch.split('/').at(-1)!);
      git(home, 'worktree', 'add', '-b', branch, path);
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
  const warnings: string[] = [];
  db.reserveMember('alice', { kind: 'codex', state: 'starting' });
  await new Worktrees(db, client, (text) => warnings.push(text)).create(
    'alice',
    home,
  );
  expect(warnings).toEqual([
    "warning: the lead checkout has uncommitted changes; alice's worktree contains committed files only\n",
  ]);
  expect(db.inbox('lead')).toEqual([]);
});
