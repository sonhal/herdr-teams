import { Command, CommanderError } from 'commander';
import { installBoardCommands } from './board.js';
import { syncSidebar } from '../runtime/sidebar.js';
import { installTemplateCommands } from './templates.js';
import { installPlanCommands } from './plans.js';
import { installWorktreeCommands } from './worktrees.js';
import { installControlCommands } from './control.js';
import { applyEvent } from '../runtime/events.js';
import { installLifecycleCommands } from './lifecycle.js';
import { installCoreCommands } from './core.js';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { reconcile } from '../runtime/delivery.js';
import { readIdentity, readSelectedIdentity } from './identity.js';

export interface CliOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Shared CLI for shell users and the board. */
export function createCli(options: CliOptions): Command {
  const env = options.env ?? process.env;
  const stdout =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr =
    options.stderr ?? ((text: string) => process.stderr.write(text));
  const program = new Command()
    .name('herdr-teams')
    .description('Run a team of coding agents in herdr.')
    .version(options.version)
    .option('--team <name>', 'team name (default: HERDR_TEAMS_TEAM)')
    .option('--json', 'print structured output')
    .configureOutput({ writeOut: stdout, writeErr: stderr })
    .exitOverride();

  program.command('team').description('Create, start, list and save teams');
  program
    .command('task')
    .description('Manage persistent tasks and dependencies')
    .command('dep')
    .description('Add or remove task dependencies');
  program.command('msg').description('Queue messages in member inboxes');
  program.command('plan').description('Submit and review task plans');
  program
    .command('worktree')
    .description('Inspect, merge and remove dedicated worktrees');
  program.command('_action').description('Run a herdr plugin action');
  const hooks = program
    .command('_hook')
    .description('Reconcile plugin lifecycle events');
  for (const name of ['startup', 'event']) hooks.command(name).action(() => {});
  installCoreCommands(program, env, stdout, stderr);
  installLifecycleCommands(program, env, stdout);
  installControlCommands(program, env, stdout);
  installWorktreeCommands(program, env, stdout);
  installPlanCommands(program, env, stdout);
  installTemplateCommands(program, env, stdout);
  installBoardCommands(program, env, stdout);
  return program;
}

/** The team a command ran against, including one it just created. */
function targetTeam(program: Command, env: NodeJS.ProcessEnv) {
  const team = program.commands.find((c) => c.name() === 'team')!;
  const flags = program.opts<{ team?: string }>();
  if (program.args[0] === 'team' && program.args[1] === 'create') {
    const create = team.commands.find((c) => c.name() === 'create')!;
    const stored = (create as Command & { _storeId?: string })._storeId;
    if (stored) return stored;
    return create.args[0];
  }
  if (program.args[0] === 'team' && program.args[1] === 'start') {
    const start = team.commands.find((c) => c.name() === 'start')!;
    const stored = (start as Command & { _storeId?: string })._storeId;
    if (stored) return stored;
    return start.opts<{ name?: string }>().name ?? flags.team ?? start.args[0];
  }
  return readSelectedIdentity(env, flags.team).teamId;
}

/** Production entrypoint: keep command errors distinct from deferred delivery. */
export async function runCliAsync(
  argv: string[],
  options: CliOptions,
): Promise<number> {
  const program = createCli(options);
  try {
    await program.parseAsync(argv.length ? argv : ['--help'], {
      from: 'user',
    });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    (options.stderr ?? ((text: string) => process.stderr.write(text)))(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  if (
    argv.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg)) ||
    !argv.length
  )
    return 0;
  const command = program.args[0];
  if (['status', 'board', 'log'].includes(command ?? '')) return 0;
  const env = options.env ?? process.env;
  const identity = readIdentity(env);
  if (!identity.home) return 0;
  const hook = command === '_hook' ? program.args[1] : undefined;
  // Hooks carry no team identity; they act for every team of this session.
  // A command acts only for the team it ran against.
  const teams = hook
    ? Store.teams(identity.home)
        .filter(
          (team) =>
            team.herdr_socket !== undefined &&
            team.herdr_socket === env.HERDR_SOCKET_PATH,
        )
        .map((team) => team.id)
    : [targetTeam(program, env)].filter((team) => team !== undefined);
  const client = new HerdrClient({ env });
  let failed = false;
  for (const id of teams) {
    try {
      const db = new Store(identity.home, id);
      const team = db.config();
      if (
        team.herdr_socket !== undefined &&
        team.herdr_socket !== env.HERDR_SOCKET_PATH
      )
        continue;
      if (hook === 'event') {
        const event = env.HERDR_PLUGIN_EVENT_JSON
          ? (JSON.parse(env.HERDR_PLUGIN_EVENT_JSON) as {
              data?: {
                pane_id?: string;
                previous_pane_id?: string;
                pane?: { pane_id?: string };
              };
            })
          : undefined;
        const targets = [
          event?.data?.pane_id,
          event?.data?.previous_pane_id,
          event?.data?.pane?.pane_id,
        ].filter(Boolean);
        if (
          !targets.some(
            (pane) =>
              pane === team.lead_pane_id ||
              Object.values(team.details ?? {}).some(
                (m) => !m.ended && m.pane_id === pane,
              ),
          )
        )
          continue;
        applyEvent(db, event);
      }
      await reconcile(db, client, env);
      await syncSidebar(db, client);
    } catch (error) {
      failed = true;
      (options.stderr ?? ((text: string) => process.stderr.write(text)))(
        `delivery deferred for ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return failed && hook ? 1 : 0;
}
