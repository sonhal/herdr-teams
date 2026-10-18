import { Command } from 'commander';
import { Worktrees, git, worktreeStatus } from '../core/worktrees.js';
import { HerdrClient } from '../herdr/index.js';
import { each } from '../runtime/each.js';
import { group, printer, teamContext, type Output } from './context.js';

export function installWorktreeCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
) {
  const print = printer(output);
  function context(cmd: Command, privileged = true) {
    const { db, actor } = teamContext(cmd, env, privileged);
    return { db, actor, trees: new Worktrees(db, new HerdrClient({ env })) };
  }
  const worktree = group(program, 'worktree');
  const status = worktree.command('status [member]');
  status.action((member?: string) => {
    const { db, trees } = context(status, false);
    print(
      member
        ? worktreeStatus(trees.binding(member))
        : Object.entries(db.config().details ?? {})
            .filter(([, m]) => m.worktree)
            .map(([name, m]) => ({
              member: name,
              ...worktreeStatus(m.worktree!),
            })),
    );
  });
  const diff = worktree.command('diff <member>');
  diff.action((member: string) => {
    const tree = context(diff, false).trees.binding(member);
    output(git(tree.path, 'diff', tree.base, '--') + '\n');
  });
  const merge = worktree
    .command('merge <member>')
    .option('--into <branch>')
    .option('--squash');
  merge.action(async (member: string) =>
    print(await context(merge).trees.merge(member, merge.opts())),
  );
  const remove = worktree
    .command('remove <member>')
    .option('--preserve')
    .option('--force-unmerged')
    .option('--delete-branch');
  remove.action(async (member: string) =>
    print(await context(remove).trees.remove(member, remove.opts())),
  );
  const cleanup = program
    .command('cleanup')
    .option('--apply', 'remove clean, merged worktrees of ended members');
  cleanup.action(async () => {
    const { db, trees } = context(cleanup);
    const candidates = Object.entries(db.config().details ?? {})
      .filter(([, m]) => m.ended && m.worktree)
      .map(([name]) => name);
    const apply = Boolean(cleanup.opts<{ apply?: boolean }>().apply);
    // One ineligible worktree must not keep the others.
    const failure = apply
      ? await each(
          candidates.map((name) => [name, name] as [string, string]),
          async (name) => {
            await trees.remove(name);
          },
        ).catch((error: unknown) => error as Error)
      : undefined;
    print({ candidates, applied: apply });
    if (failure) throw failure;
  });
}
