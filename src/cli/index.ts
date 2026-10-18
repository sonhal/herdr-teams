import { Command, CommanderError } from 'commander';
import { installCoreCommands } from './core.js';
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
  // TODO PLAN §7.3, §16 (M3): reconcile/deliver events; M0 hooks log and exit 0.
  group('_hook', ['startup', 'event'], '7.3, §16', 'M3');
  group('_action', ['start-team', 'open-board'], '16', 'M2, M8');
  installCoreCommands(program, env, stdout);
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
