import { serveMcp } from '../mcp/server.js';
import { Command, CommanderError } from 'commander';
import { installBoardCommands } from './board.js';
import { syncSidebar } from '../supervisor/sidebar.js';
import { installTemplateCommands } from './templates.js';
import { installPlanCommands } from './plans.js';
import { installWorktreeCommands } from './worktrees.js';
import { installSupervisionCommands } from './supervision.js';
import { ensureSupervisor } from '../supervisor/runtime.js';
import { applyEvent } from '../supervisor/events.js';
import { installLifecycleCommands } from './lifecycle.js';
import { installCoreCommands } from './core.js';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { reconcile } from '../supervisor/delivery.js';
import { readIdentity } from './identity.js';

export interface CliOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Shared CLI for shell users, the board and MCP tools. */
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

  for (const name of ['team', 'task', 'msg', 'plan', 'worktree', '_action'])
    program.command(name);
  program.commands.find((c) => c.name() === 'task')!.command('dep');
  const hooks = program
    .command('_hook')
    .description('Reconcile plugin lifecycle events');
  for (const name of ['startup', 'event']) hooks.command(name).action(() => {});
  program
    .command('mcp')
    .description('Serve MCP tools over stdio')
    .action(async () => {
      await serveMcp(process.stdin, stdout, options.version, env);
    });
  installCoreCommands(program, env, stdout);
  installLifecycleCommands(program, env, stdout);
  installSupervisionCommands(program, env, stdout);
  installWorktreeCommands(program, env, stdout);
  installPlanCommands(program, env, stdout);
  installTemplateCommands(program, env, stdout);
  installBoardCommands(program, env, stdout);
  return program;
}

export function runCli(argv: string[], options: CliOptions): number {
  const program = createCli(options);
  try {
    program.parse(argv.length ? argv : ['--help'], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    (options.stderr ?? ((text: string) => process.stderr.write(text)))(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

/** Production entrypoint: keep command errors distinct from deferred delivery. */
export async function runCliAsync(
  argv: string[],
  options: CliOptions,
): Promise<number> {
  const code = 0;
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
    return code;
  const command = program.args[0];
  if (['status', 'board', 'log', 'supervise', 'mcp'].includes(command ?? ''))
    return 0;
  const env = options.env ?? process.env;
  const identity = readIdentity(env);
  if (!identity.home) return code;
  // Reconcile all teams: startup and fallback events may have no team identity.
  try {
    const client = new HerdrClient({ env });
    for (const team of Store.teams(identity.home)) {
      const db = new Store(identity.home, team.name);
      if (command === '_hook' && env.HERDR_PLUGIN_EVENT_JSON)
        applyEvent(db, JSON.parse(env.HERDR_PLUGIN_EVENT_JSON) as unknown);
      if (identity.agent && team.details?.[identity.agent])
        db.patchMember(identity.agent, { last_activity: Date.now() });
      await reconcile(db, client, env);
      if (command === '_hook' && program.args[1] === 'event')
        await syncSidebar(db, client);
      if (
        (command === '_hook' && program.args[1] === 'startup') ||
        (command === 'team' &&
          ['create', 'start'].includes(program.args[1] ?? ''))
      )
        await ensureSupervisor(db, client);
    }
  } catch (error) {
    (options.stderr ?? ((text: string) => process.stderr.write(text)))(
      `delivery deferred: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (command === '_hook') return 1;
  }
  return code;
}
