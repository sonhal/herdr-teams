import { execFileSync } from 'node:child_process';
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
/** Dedicated checkouts for teammates spawned with `--worktree dedicated`. */
export class Worktrees {
  constructor(
    readonly db: Store,
    readonly client: HerdrClient,
    /** Notes for whoever runs the command; nobody else needs them. */
    readonly warn: (text: string) => void = () => {},
  ) {}
  binding(member: string): Worktree {
    const tree = this.db.config().details?.[member]?.worktree;
    if (!tree) throw new Error(`${member} has no worktree`);
    return tree;
  }
  /** herdr opens the worktree in a new workspace whose root pane spawn reuses. */
  create(member: string, cwd: string): Promise<Worktree> {
    return this.db.exclusive('worktree', async () => {
      const team = this.db.config();
      const repo = git(cwd, 'rev-parse', '--show-toplevel');
      const base = git(repo, 'rev-parse', '--verify', 'HEAD^{commit}');
      const branch = `team/${team.name}/${member}`;
      git(repo, 'check-ref-format', '--branch', branch);
      let exists = false;
      try {
        git(repo, 'show-ref', '--verify', `refs/heads/${branch}`);
        exists = true;
      } catch {
        /* A new branch is required. */
      }
      if (exists) {
        // Another team with this display name left it, often after a failed
        // launch; nothing in this team's state records it.
        const path = git(repo, 'worktree', 'list', '--porcelain')
          .split('\n\n')
          .find((entry) => entry.includes(`\nbranch refs/heads/${branch}`))
          ?.match(/^worktree (.*)$/m)?.[1];
        throw new Error(
          `Branch ${branch} already exists, probably left by an earlier team named ${team.name}. Start this team with another --name, or, if that work is not needed, remove it: ${path ? `git worktree remove ${JSON.stringify(path)} && ` : ''}git branch -D ${branch}`,
        );
      }
      if (git(repo, 'status', '--porcelain=v1'))
        this.warn(
          `warning: the lead checkout has uncommitted changes; ${member}'s worktree contains committed files only\n`,
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
      const tree: Worktree = {
        path: worktree.path,
        branch,
        base,
        pane_id: root.pane_id,
        workspace_id: root.workspace_id,
        tab_id: root.tab_id,
      };
      this.db.patchMember(member, { worktree: tree });
      this.db.updateTeam((config) => {
        config.repository_dir = repo;
      });
      this.db.event('worktree.created', { member, ...tree });
      return tree;
    });
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
