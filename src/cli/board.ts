import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { stripVTControlCharacters } from 'node:util';
import { snapshot, renderBoard } from '../board/model.js';
import { terminalBoard } from '../board/terminal.js';
import { readSelectedIdentity } from './identity.js';
import { group, teamContext, type Output } from './context.js';
import { runCliAsync } from './index.js';
import { Config } from '../core/config.js';
import { HerdrClient } from '../herdr/index.js';

export function installBoardCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
) {
  const context = (command: Command) => teamContext(command, env).db;
  const status = program.command('status [member]');
  status.action((member?: string) => {
    const data = snapshot(context(status));
    if (member) {
      if (!data.members.some((m) => m.name === member))
        throw new Error('Unknown member');
      data.members = data.members.filter((m) => m.name === member);
      data.tasks = data.tasks.filter((t) => t.owner === member);
    }
    output(
      status.optsWithGlobals<{ json?: boolean }>().json
        ? JSON.stringify(data, null, 2) + '\n'
        : renderBoard(data),
    );
  });
  const board = program
    .command('board')
    .option('--once', 'render one snapshot');
  board.action(async () => {
    const db = context(board);
    if (board.optsWithGlobals<{ json?: boolean }>().json) {
      output(JSON.stringify(snapshot(db), null, 2) + '\n');
      return;
    }
    if (board.opts<{ once?: boolean }>().once) {
      output(renderBoard(snapshot(db)));
      return;
    }
    await terminalBoard(
      db,
      async (args) => {
        let text = '';
        const code = await runCliAsync(['--team', db.id, ...args], {
          version: program.version() ?? '0.1.0',
          env: { ...env, HERDR_TEAMS_HOME: db.home },
          stdout: (s) => {
            text += s;
          },
          stderr: (s) => {
            text += s;
          },
        });
        return { code, text: stripVTControlCharacters(text) };
      },
      output,
    );
  });
  const log = program.command('log').option('--follow', 'follow new events');
  log.action(async () => {
    const db = context(log);
    const path = join(db.root, 'events.jsonl');
    let cursor = 0;
    const print = () => {
      const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (text.length < cursor) cursor = 0;
      const end = text.lastIndexOf('\n') + 1;
      if (end > cursor) {
        output(text.slice(cursor, end));
        cursor = end;
      }
    };
    print();
    if (!log.opts<{ follow?: boolean }>().follow) return;
    const clock = setInterval(print, 500);
    let stop!: () => void;
    try {
      await new Promise<void>((resolve) => {
        stop = resolve;
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    } finally {
      clearInterval(clock);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  });
  const actions = group(program, '_action');
  const open = actions.command('open-board');
  open.action(async () => {
    const identity = readSelectedIdentity(
      env,
      open.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home) throw new Error('Set HERDR_TEAMS_HOME');
    const candidates = Store.teams(identity.home).filter(
      (t) =>
        !env.HERDR_WORKSPACE_ID || t.workspace_id === env.HERDR_WORKSPACE_ID,
    );
    const id =
      identity.teamId ??
      (candidates.length === 1 ? candidates[0]!.id : undefined);
    if (!id) throw new Error('Select a team with --team');
    new Store(identity.home, id).authorize(
      identity.agent,
      false,
      identity.paneId,
    );
    await new HerdrClient({ env }).command(
      [
        'plugin',
        'pane',
        'open',
        '--plugin',
        'herdr-teams',
        '--entrypoint',
        'board',
        '--placement',
        'split',
        '--no-focus',
        '--env',
        `HERDR_TEAMS_HOME=${identity.home}`,
        '--env',
        `HERDR_TEAMS_TEAM=${id}`,
      ],
      'plugin_pane_opened',
    );
  });
  const start = actions.command('start-team [template]');
  start.action(async (template?: string) => {
    const catalog = new Config(process.cwd(), env).catalog();
    // Built-in templates are always present; only the user's own one is implied.
    const own = catalog.filter((t) => t.source !== 'built-in');
    const selected =
      template ??
      env.HERDR_TEAMS_TEMPLATE ??
      (own.length === 1 ? own[0]!.name : undefined);
    if (!selected)
      throw new Error(
        `Choose a template with team start <template>: ${catalog.map((t) => t.name).join(', ')}`,
      );
    const code = await runCliAsync(['team', 'start', selected], {
      version: program.version() ?? '0.1.0',
      env,
      stdout: output,
    });
    if (code !== 0) throw new Error('Team start failed');
  });
}
