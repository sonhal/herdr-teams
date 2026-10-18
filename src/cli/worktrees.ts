import { Command } from 'commander';
import { Store } from '../core/store.js';
import { Worktrees, git, worktreeStatus } from '../core/worktrees.js';
import { HerdrClient } from '../herdr/index.js';
import { readIdentity } from './identity.js';
export function installWorktreeCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
) {
  const group = program.commands.find((c) => c.name() === 'worktree')!;
  (group.commands as Command[]).splice(0);
  group.description('Create, integrate and clean up worktrees');
  function context(cmd: Command, privileged = true) {
    const identity = readIdentity(
      env,
      cmd.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.team)
      throw new Error('Set HERDR_TEAMS_HOME and select a team');
    const db = new Store(identity.home, identity.team);
    return {
      db,
      actor: db.authorize(identity.agent, privileged),
      trees: new Worktrees(db, new HerdrClient({ env })),
    };
  }
  const print = (v: unknown) => output(JSON.stringify(v, null, 2) + '\n');
  const create = group
    .command('create <target>')
    .option('--branch <name>')
    .option('--base <ref>');
  create.action(async (target: string) =>
    print(await context(create).trees.create(target, create.opts())),
  );
  const request = group
    .command('request')
    .requiredOption('--reason <text>')
    .option('--task <id>');
  request.action(async () => {
    const { db, actor, trees } = context(request, false);
    const flags = request.opts<{ reason: string; task?: string }>();
    const id = trees.request(actor, flags.reason, flags.task);
    print(
      db.config().worktree_requests === 'auto'
        ? await trees.approve(id)
        : { id, state: 'pending' },
    );
  });
  const approve = group.command('approve <id>');
  approve.action(async (id: string) =>
    print(await context(approve).trees.approve(id)),
  );
  const status = group.command('status [target]');
  status.action((target?: string) => {
    const { db, trees } = context(status, false);
    print(
      target
        ? worktreeStatus(trees.binding(target))
        : Object.entries(db.config().details ?? {})
            .filter(([, m]) => m.worktree)
            .map(([name, m]) => ({
              member: name,
              ...worktreeStatus(m.worktree!),
            })),
    );
  });
  const diff = group.command('diff <target>');
  diff.action((target: string) => {
    const tree = context(diff, false).trees.binding(target);
    output(git(tree.path, 'diff', tree.base, '--') + '\n');
  });
  const merge = group
    .command('merge <target>')
    .option('--into <branch>')
    .option('--squash');
  merge.action(async (target: string) =>
    print(await context(merge).trees.merge(target, merge.opts())),
  );
  const remove = group
    .command('remove <target>')
    .option('--preserve')
    .option('--force-unmerged')
    .option('--delete-branch');
  remove.action(async (target: string) =>
    print(await context(remove).trees.remove(target, remove.opts())),
  );
  // Without the guard, splice(-1, 1) would drop the last registered command.
  const previous = program.commands.find((c) => c.name() === 'cleanup');
  if (previous)
    (program.commands as Command[]).splice(
      program.commands.indexOf(previous),
      1,
    );
  const cleanup = program
    .command('cleanup')
    .option('--apply', 'remove clean, merged worktrees of ended members');
  cleanup.action(async () => {
    const { db, trees } = context(cleanup);
    const candidates = Object.entries(db.config().details ?? {})
      .filter(([, m]) => m.ended && m.worktree)
      .map(([name]) => name);
    if (cleanup.opts<{ apply?: boolean }>().apply) {
      for (const name of candidates) await trees.remove(name);
    }
    print({
      candidates,
      applied: Boolean(cleanup.opts<{ apply?: boolean }>().apply),
    });
  });
}
