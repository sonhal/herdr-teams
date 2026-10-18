import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '../core/config.js';
import { installShim } from '../core/shim.js';
import { Command } from 'commander';
import { Store } from '../core/store.js';
import { Lifecycle, type SpawnOptions } from '../core/lifecycle.js';
import { HerdrClient } from '../herdr/index.js';
import { readSelectedIdentity } from './identity.js';

export function installLifecycleCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
) {
  const print = (value: unknown) =>
    output(JSON.stringify(value, null, 2) + '\n');
  function replace(name: string, usage: string) {
    const previous = program.commands.find((c) => c.name() === name);
    if (previous)
      (program.commands as Command[]).splice(
        program.commands.indexOf(previous),
        1,
      );
    return program.command(usage);
  }
  function context(cmd: Command, privileged = true) {
    const identity = readSelectedIdentity(
      env,
      cmd.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.teamId)
      throw new Error('Set HERDR_TEAMS_HOME and select a team');
    const db = new Store(identity.home, identity.teamId);
    const actor = db.authorize(identity.agent, privileged);
    return {
      db,
      actor,
      lifecycle: new Lifecycle(db, new HerdrClient({ env }), env),
    };
  }
  const shim = replace('install-shim', 'install-shim').option(
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
  const actions = program.commands.find((c) => c.name() === '_action')!;
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
  const spawn = replace('spawn', 'spawn <name>')
    .option('--agent <definition>', 'agent definition')
    .option('--kind <kind>', 'agent CLI')
    .option('--model <model>', 'model name')
    .option('--thinking <level>', 'thinking effort')
    .option('--placement <placement>', 'split, tab or workspace', 'split')
    .option('--worktree <mode>', 'shared, dedicated or auto')
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
  const shutdown = replace('shutdown', 'shutdown [name]')
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
  const kill = replace('kill', 'kill <name>');
  kill.action(async (member: string) =>
    print(await context(kill).lifecycle.kill(member)),
  );
  const done = replace('done', 'done').option(
    '--force',
    'kill remaining teammates',
  );
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
    for (const member of members) {
      try {
        if (force) await lifecycle.kill(member);
        else lifecycle.requestShutdown(member);
      } catch (error) {
        errors.push(new Error(`${member}: ${String(error)}`));
      }
    }
    if (errors.length)
      throw new AggregateError(errors, errors.map(String).join('; '));
    print({
      members,
      state: force ? 'killed' : 'shutdown-requested',
      tasks: db.tasks(),
    });
  });
}
