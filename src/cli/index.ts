import { Command, CommanderError } from 'commander';
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

/** PLAN §15: core commands plus placeholders for later milestones. */
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

  function placeholder(
    command: Command,
    section: string,
    milestone: string,
  ): void {
    command.action(() => {
      const flags = command.optsWithGlobals<{
        team?: string;
        json?: boolean;
      }>();
      const names: string[] = [];
      for (
        let current: Command | null = command;
        current?.parent;
        current = current.parent
      ) {
        names.unshift(current.name());
      }
      const result = {
        command: names.join(' '),
        status: 'not implemented',
        todo: `PLAN §${section}, ${milestone}`,
        identity: readIdentity(env, flags.team),
      };
      stdout(
        flags.json
          ? `${JSON.stringify(result)}\n`
          : `${result.command}: not implemented (${result.todo})\n`,
      );
    });
  }

  function leaf(
    parent: Command,
    name: string,
    section: string,
    milestone: string,
  ): void {
    const command = parent
      .command(`${name} [args...]`)
      .description(`Not implemented — PLAN §${section}, ${milestone}`)
      // Future command-specific flags are deliberately uninterpreted in M0.
      .allowUnknownOption();
    placeholder(command, section, milestone);
  }

  function group(
    name: string,
    children: string[],
    section: string,
    milestone: string,
  ): Command {
    const command = program
      .command(name)
      .description(`Not implemented — PLAN §${section}, ${milestone}`);
    placeholder(command, section, milestone);
    for (const child of children) leaf(command, child, section, milestone);
    return command;
  }

  group('team', ['create', 'start', 'save', 'list'], '5', 'M1–M2, M7');
  const task = group(
    'task',
    ['add', 'list', 'show', 'claim', 'assign', 'release', 'update', 'complete'],
    '6',
    'M1',
  );
  const dep = task.command('dep').description('Task dependencies (M1)');
  placeholder(dep, '6', 'M1');
  for (const name of ['add', 'rm']) leaf(dep, name, '6', 'M1');
  group('msg', ['send'], '7', 'M1, M3');
  group('plan', ['submit', 'approve', 'reject'], '8', 'M6');
  group(
    'worktree',
    ['create', 'request', 'approve', 'status', 'diff', 'merge', 'remove'],
    '10',
    'M5',
  );

  for (const name of ['status', 'log']) leaf(program, name, '12', 'M4, M8');
  for (const name of ['done', 'cleanup', 'spawn', 'shutdown', 'kill'])
    leaf(program, name, '5', 'M2, M5');
  for (const name of ['peek', 'steer', 'interrupt'])
    leaf(program, name, '11.4', 'M4');
  for (const name of ['broadcast', 'report', 'inbox'])
    leaf(program, name, '7', 'M1, M3');
  leaf(program, 'board', '12', 'M8');
  leaf(program, 'supervise', '11.5', 'M4');
  leaf(program, 'install-shim', '16', 'M2');
  const hooks = program.command('_hook');
  for (const name of ['startup', 'event']) hooks.command(name).action(() => {});
  group('_action', ['start-team', 'open-board'], '16', 'M2, M8');
  installCoreCommands(program, env, stdout);
  installLifecycleCommands(program, env, stdout);
  installSupervisionCommands(program, env, stdout);
  installWorktreeCommands(program, env, stdout);
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
  try {
    await createCli(options).parseAsync(argv.length ? argv : ['--help'], {
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
  const env = options.env ?? process.env;
  const identity = readIdentity(env);
  if (!identity.home) return code;
  // Reconcile all teams: startup and fallback events may have no team identity.
  try {
    const client = new HerdrClient({ env });
    for (const team of Store.teams(identity.home)) {
      const db = new Store(identity.home, team.name);
      if (argv[0] === '_hook' && env.HERDR_PLUGIN_EVENT_JSON)
        applyEvent(db, JSON.parse(env.HERDR_PLUGIN_EVENT_JSON) as unknown);
      if (identity.agent && team.details?.[identity.agent])
        db.patchMember(identity.agent, { last_activity: Date.now() });
      await reconcile(db, client);
      if (
        (argv[0] === '_hook' && argv[1] === 'startup') ||
        (argv[0] === 'team' && argv[1] === 'create')
      )
        await ensureSupervisor(db, client);
    }
  } catch (error) {
    (options.stderr ?? ((text: string) => process.stderr.write(text)))(
      `delivery deferred: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (argv[0] === '_hook') return 1;
  }
  return code;
}
