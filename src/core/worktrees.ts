import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { HerdrClient } from '../herdr/index.js';
import { Store, type Worktree } from './store.js';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function ref(value: string): string {
  if (
    !value ||
    value.startsWith('-') ||
    [...value].some((char) => char.charCodeAt(0) <= 32)
  )
    throw new Error('Invalid git reference');
  return value;
}
export function worktreeStatus(tree: Worktree) {
  const status = git(tree.path, 'status', '--porcelain=v1');
  return {
    ...tree,
    head: git(tree.path, 'rev-parse', 'HEAD'),
    ahead: Number(git(tree.path, 'rev-list', '--count', `${tree.base}..HEAD`)),
    changed_files: git(tree.path, 'diff', '--name-only', tree.base, '--')
      .split('\n')
      .filter(Boolean),
    status: /^(UU|AA|DD|AU|UA|DU|UD) /m.test(status)
      ? 'conflicted'
      : status
        ? 'dirty'
        : 'clean',
    changes: status,
  };
}
export class Worktrees {
  constructor(
    readonly db: Store,
    readonly client: HerdrClient,
  ) {}
  binding(target: string): Worktree {
    const tree = /^\d+$/.test(target)
      ? this.db.task(target).worktree?.binding
      : this.db.config().details?.[target]?.worktree;
    if (!tree) throw new Error('No worktree for target');
    return tree;
  }
  create(
    target: string,
    options: { branch?: string; base?: string; cwd?: string } = {},
  ): Promise<Worktree> {
    return this.db.exclusive('worktree', async () => {
      const task = /^\d+$/.test(target) ? this.db.task(target) : undefined;
      const member = task?.owner ?? target;
      const team = this.db.config();
      const details = team.details?.[member];
      if (!details || details.ended)
        throw new Error('Select a running member or an owned task');
      if (details.worktree) {
        let tree = details.worktree;
        if (details.pane_id && details.workspace_id !== tree.workspace_id)
          tree = await this.move(member, details.pane_id, tree);
        if (task)
          this.db.editTask(task.id, (t) => {
            t.worktree = { ...t.worktree, binding: tree };
          });
        return tree;
      }
      const repo = git(
        options.cwd ?? team.repository_dir ?? process.cwd(),
        'rev-parse',
        '--show-toplevel',
      );
      const base = git(
        repo,
        'rev-parse',
        '--verify',
        `${ref(options.base ?? 'HEAD')}^{commit}`,
      );
      const branch = ref(
        options.branch ??
          `team/${team.name}/${member}${task ? `-${task.id}` : ''}`,
      );
      git(repo, 'check-ref-format', '--branch', branch);
      let exists = false;
      try {
        git(repo, 'show-ref', '--verify', `refs/heads/${branch}`);
        exists = true;
      } catch {
        /* A new branch is required. */
      }
      if (exists) throw new Error('Branch already exists');
      const dirty = git(repo, 'status', '--porcelain=v1');
      if (dirty)
        this.db.send(
          team.lead,
          team.lead,
          'The lead checkout has uncommitted changes; the worktree contains committed files only.',
        );
      const result = await this.client.command(
        [
          'worktree',
          'create',
          '--cwd',
          repo,
          '--branch',
          branch,
          '--base',
          base,
          '--label',
          `${team.name}:${member}`,
          '--no-focus',
        ],
        'worktree_created',
      );
      const worktree = result.worktree as { path?: unknown } | undefined;
      const root = result.root_pane as
        | { pane_id?: unknown; workspace_id?: unknown; tab_id?: unknown }
        | undefined;
      if (
        typeof worktree?.path !== 'string' ||
        typeof root?.pane_id !== 'string' ||
        typeof root.workspace_id !== 'string' ||
        typeof root.tab_id !== 'string'
      )
        throw new Error('Invalid worktree creation response');
      let tree: Worktree = {
        path: worktree.path,
        branch,
        base,
        pane_id: root.pane_id,
        workspace_id: root.workspace_id,
        tab_id: root.tab_id,
      };
      // Record creation before moving so a failed move leaves a recoverable worktree.
      this.db.patchMember(member, { worktree: tree });
      this.db.updateTeam((config) => {
        config.repository_dir = repo;
      });
      if (details.pane_id)
        tree = await this.move(member, details.pane_id, tree);
      if (task)
        this.db.editTask(task.id, (t) => {
          t.worktree = { ...t.worktree, binding: tree };
        });
      this.db.send(
        team.lead,
        member,
        `Worktree ready. Change directory to ${JSON.stringify(tree.path)} before editing. Branch ${branch}; base ${base}. Never push or merge without an explicit lead command.`,
      );
      this.db.event('worktree.created', { member, task: task?.id, ...tree });
      return tree;
    });
  }
  private async move(
    member: string,
    source: string,
    tree: Worktree,
  ): Promise<Worktree> {
    const moved = await this.client.command(
      [
        'pane',
        'move',
        source,
        '--tab',
        tree.tab_id,
        '--split',
        'right',
        '--no-focus',
      ],
      'pane_move',
    );
    const pane = (
      moved.move_result as { pane?: { pane_id?: unknown } } | undefined
    )?.pane;
    if (typeof pane?.pane_id !== 'string')
      throw new Error('Invalid pane move response');
    const result = { ...tree, pane_id: pane.pane_id };
    this.db.patchMember(member, {
      pane_id: result.pane_id,
      workspace_id: result.workspace_id,
      tab_id: result.tab_id,
      worktree: result,
    });
    return result;
  }
  request(member: string, reason: string, task?: string) {
    if (!reason.trim()) throw new Error('Reason is required');
    if (!this.db.config().details?.[member])
      throw new Error('Only a teammate may request a worktree');
    if (task && this.db.task(task).owner !== member)
      throw new Error('Only the task owner may request its worktree');
    const id = randomUUID();
    this.db.updateTeam((team) => {
      team.requests ??= {};
      team.requests[id] = {
        member,
        reason,
        ...(task ? { task } : {}),
        approved: false,
      };
    });
    this.db.send(
      member,
      this.db.config().lead,
      `Worktree request ${id}: ${reason}\nApprove: herdr-teams worktree approve ${id}`,
    );
    return id;
  }
  async approve(id: string) {
    const request = this.db.config().requests?.[id];
    if (!request) throw new Error('Unknown worktree request');
    const tree = await this.create(request.task ?? request.member);
    this.db.updateTeam((team) => {
      team.requests![id]!.approved = true;
    });
    return tree;
  }
  merge(target: string, options: { into?: string; squash?: boolean } = {}) {
    return this.db.exclusive('worktree', async () =>
      this.mergeNow(target, options),
    );
  }
  private mergeNow(
    target: string,
    options: { into?: string; squash?: boolean },
  ) {
    const tree = this.binding(target);
    const repo = this.db.config().repository_dir;
    if (!repo) throw new Error('No lead checkout recorded');
    if (
      worktreeStatus(tree).status !== 'clean' ||
      git(repo, 'status', '--porcelain=v1')
    )
      throw new Error('Both checkouts must be clean before merging');
    if (
      options.into &&
      git(repo, 'branch', '--show-current') !== ref(options.into)
    )
      git(repo, 'switch', options.into);
    const result = git(
      repo,
      'merge',
      ...(options.squash ? ['--squash'] : ['--no-edit']),
      '--',
      tree.branch,
    );
    this.db.event('worktree.merged', {
      target,
      branch: tree.branch,
      squash: Boolean(options.squash),
    });
    return result;
  }
  remove(
    target: string,
    options: {
      preserve?: boolean;
      forceUnmerged?: boolean;
      deleteBranch?: boolean;
    } = {},
  ) {
    return this.db.exclusive('worktree', () => this.removeNow(target, options));
  }
  private async removeNow(
    target: string,
    options: {
      preserve?: boolean;
      forceUnmerged?: boolean;
      deleteBranch?: boolean;
    } = {},
  ) {
    const tree = this.binding(target);
    const repo = this.db.config().repository_dir;
    if (!repo) throw new Error('No lead checkout recorded');
    const agents = (await this.client.agentList()).agents;
    if (
      agents.some(
        (a) =>
          a.pane_id === tree.pane_id ||
          a.workspace_id === tree.workspace_id ||
          (a.foreground_cwd &&
            (resolve(a.foreground_cwd) === resolve(tree.path) ||
              resolve(a.foreground_cwd).startsWith(resolve(tree.path) + sep))),
      )
    )
      throw new Error('An agent is still running in this worktree');
    const status = worktreeStatus(tree);
    if (status.status === 'conflicted')
      throw new Error('Resolve conflicts before removing the worktree');
    if (status.status === 'dirty') {
      if (!options.preserve)
        throw new Error('Worktree is dirty; use --preserve to commit it first');
      git(tree.path, 'add', '--all');
      git(tree.path, 'commit', '-m', 'WIP: preserve worktree before cleanup');
    }
    if (!options.forceUnmerged) {
      try {
        git(repo, 'merge-base', '--is-ancestor', tree.branch, 'HEAD');
      } catch {
        throw new Error(
          'Branch is unmerged; use --force-unmerged to keep it while removing the checkout',
        );
      }
    }
    await this.client.command(
      ['worktree', 'remove', '--workspace', tree.workspace_id],
      'worktree_removed',
    );
    this.db.updateTeam((team) => {
      for (const member of Object.values(team.details ?? {}))
        if (member.worktree?.path === tree.path) delete member.worktree;
    });
    for (const task of this.db
      .tasks()
      .filter((t) => t.worktree?.binding?.path === tree.path))
      this.db.editTask(task.id, (t) => {
        delete t.worktree?.binding;
      });
    if (options.deleteBranch)
      git(
        repo,
        'branch',
        options.forceUnmerged ? '-D' : '-d',
        '--',
        tree.branch,
      );
    this.db.event('worktree.removed', tree);
    return tree;
  }
}
