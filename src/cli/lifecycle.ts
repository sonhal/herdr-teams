import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '../core/config.js';
import { installShim } from '../core/shim.js';
import { Command } from 'commander';
import { Lifecycle, type SpawnOptions } from '../core/lifecycle.js';
import { HerdrClient } from '../herdr/index.js';
import { group, printer, teamContext, type Output } from './context.js';

export function installLifecycleCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
) {
  const print = printer(output);
  function context(cmd: Command, privileged = true) {
    const { db, actor } = teamContext(cmd, env, privileged);
    return {
      db,
      actor,
      lifecycle: new Lifecycle(db, new HerdrClient({ env }), env),
    };
  }
  const shim = program
    .command('install-shim')
    .option(
      '--directory <path>',
      'directory on PATH',
      join(homedir(), '.local', 'bin'),
    );
  shim.action(() => {
    const target = installShim(
      resolve(shim.opts<{ directory: string }>().directory),
    );
    print({ path: target, instruction: 'Ensure this directory is on PATH' });
  });
  // herdr runs actions with HERDR_PLUGIN_ROOT set but shows only a log, so
  // the outcome is reported as a herdr notification.
  const actions = group(program, '_action');
  const shimAction = actions
    .command('install-shim')
    .option(
      '--directory <path>',
      'directory on PATH',
      join(homedir(), '.local', 'bin'),
    );
  shimAction.action(async () => {
    const client = new HerdrClient({ env });
    let target: string;
    try {
      target = installShim(
        resolve(shimAction.opts<{ directory: string }>().directory),
      );
    } catch (error) {
      await client.command([
        'notification',
        'show',
        'herdr-teams command not installed',
        '--body',
        error instanceof Error ? error.message : String(error),
      ]);
      throw error;
    }
    await client.command([
      'notification',
      'show',
      'herdr-teams command installed',
      '--body',
      `Linked ${target}. Make sure its directory is on PATH.`,
    ]);
    print({ path: target, instruction: 'Ensure this directory is on PATH' });
  });
  const spawn = program
    .command('spawn <name>')
    .option('--agent <definition>', 'agent definition')
    .option('--kind <kind>', 'agent CLI')
    .option('--model <model>', 'model name')
    .option('--thinking <level>', 'thinking effort')
    .option('--placement <placement>', 'split, tab or workspace', 'split')
    .option('--worktree <mode>', 'shared or dedicated')
    .option('--plan-mode', 'request a plan before coding')
    .requiredOption('--prompt <text>', 'opening instructions');
  spawn.action(async (member: string) => {
    const { db, lifecycle } = context(spawn);
    const flags = spawn.opts<SpawnOptions & { agent?: string }>();
    const definition = flags.agent
      ? new Config(db.config().repository_dir ?? process.cwd(), env).definition(
          flags.agent,
        )
      : {};
    const settings: SpawnOptions = {
      ...definition,
      ...flags,
      ...((flags.planMode ?? definition.plan_mode) !== undefined
        ? { planMode: flags.planMode ?? definition.plan_mode! }
        : {}),
      ...(flags.agent ? { definition: flags.agent } : {}),
    };
    print(await lifecycle.spawn(member, settings));
  });
  const shutdown = program
    .command('shutdown [name]')
    .option('--accept', 'accept your pending shutdown request')
    .option('--reject <reason>', 'reject your pending shutdown request');
  shutdown.action((member?: string) => {
    const flags = shutdown.opts<{ accept?: boolean; reject?: string }>();
    if (flags.accept && flags.reject !== undefined)
      throw new Error('Choose accept or reject');
    const response = flags.accept || flags.reject !== undefined;
    const { lifecycle, actor } = context(shutdown, !response);
    if (response && member)
      throw new Error('Reply to shutdown without a member name');
    if (!response && !member) throw new Error('Select a member');
    print(
      flags.accept
        ? lifecycle.acceptShutdown(actor)
        : flags.reject !== undefined
          ? lifecycle.rejectShutdown(actor, flags.reject)
          : lifecycle.requestShutdown(member!),
    );
  });
  const kill = program.command('kill <name>');
  kill.action(async (member: string) =>
    print(await context(kill).lifecycle.kill(member)),
  );
  const done = program
    .command('done')
    .option('--force', 'kill remaining teammates');
  done.action(async () => {
    const { db, lifecycle } = context(done);
    const force = done.opts<{ force?: boolean }>().force;
    if (
      !force &&
      db.tasks().some((t) => ['planning', 'in_progress'].includes(t.status))
    )
      throw new Error('Tasks are still in progress');
    const members = Object.entries(db.config().details ?? {})
      .filter(([, m]) => !m.ended)
      .map(([name]) => name);
    const errors: unknown[] = [];
    const pending: string[] = [];
    for (const member of members) {
      try {
        if (force) await lifecycle.kill(member);
        else {
          const result = await lifecycle.shutdown(member);
          if (result.state === 'pending') pending.push(member);
        }
      } catch (error) {
        errors.push(new Error(`${member}: ${String(error)}`));
      }
    }
    if (errors.length)
      throw new AggregateError(errors, errors.map(String).join('; '));
    print({
      members,
      state: force ? 'killed' : 'shutdown',
      ...(pending.length ? { pending } : {}),
      tasks: db.tasks(),
    });
  });
}
