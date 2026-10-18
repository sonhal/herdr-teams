import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/store.js';
import { stripVTControlCharacters } from 'node:util';
import { snapshot, renderBoard } from '../board/model.js';
import { terminalBoard } from '../board/terminal.js';
import { readIdentity } from './identity.js';
import { runCliAsync } from './index.js';
import { Config } from '../core/config.js';
import { HerdrClient } from '../herdr/index.js';

export function installBoardCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
) {
  function replace(parent: Command, name: string, usage: string) {
    const old = parent.commands.find((c) => c.name() === name)!;
    if (old)
      (parent.commands as Command[]).splice(parent.commands.indexOf(old), 1);
    return parent.command(usage);
  }
  function context(command: Command) {
    const identity = readIdentity(
      env,
      command.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.team)
      throw new Error('Set HERDR_TEAMS_HOME and select a team');
    const db = new Store(identity.home, identity.team);
    db.authorize(identity.agent);
    return db;
  }
  const status = replace(program, 'status', 'status [member]');
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
  const board = replace(program, 'board', 'board').option(
    '--once',
    'render one snapshot',
  );
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
        const code = await runCliAsync(['--team', db.team, ...args], {
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
  const log = replace(program, 'log', 'log').option(
    '--follow',
    'follow new events',
  );
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
  const tasks = program.commands.find((c) => c.name() === 'task')!;
  tasks
    .command('reopen <id>')
    .action((id: string, _flags: unknown, command: Command) => {
      const db = context(command);
      const identity = readIdentity(env);
      db.authorize(identity.agent, true);
      const task = db.editTask(id, (t) => {
        if (!['completed', 'failed', 'deleted'].includes(t.status))
          throw new Error('Only a terminal task may be reopened');
        t.status = 'pending';
        t.result = null;
        t.reopens++;
        delete t.plan;
      });
      if (task.owner)
        db.send(db.config().lead, task.owner, `Task #${id} reopened`);
      output(JSON.stringify(task) + '\n');
    });
  const actions = program.commands.find((c) => c.name() === '_action')!;
  const open = replace(actions, 'open-board', 'open-board');
  open.action(async () => {
    const identity = readIdentity(
      env,
      open.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home) throw new Error('Set HERDR_TEAMS_HOME');
    const candidates = Store.teams(identity.home).filter(
      (t) =>
        !env.HERDR_WORKSPACE_ID || t.workspace_id === env.HERDR_WORKSPACE_ID,
    );
    const name =
      identity.team ??
      (candidates.length === 1 ? candidates[0]!.name : undefined);
    if (!name) throw new Error('Select a team with --team');
    new Store(identity.home, name).authorize(identity.agent);
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
        `HERDR_TEAMS_TEAM=${name}`,
      ],
      'plugin_pane_opened',
    );
  });
  const start = replace(actions, 'start-team', 'start-team [template]');
  start.action(async (template?: string) => {
    const available = new Config(process.cwd(), env).templates();
    const selected =
      template ??
      env.HERDR_TEAMS_TEMPLATE ??
      (available.length === 1 ? available[0] : undefined);
    if (!selected)
      throw new Error('Choose a template with team start <template>');
    const code = await runCliAsync(['team', 'start', selected], {
      version: program.version() ?? '0.1.0',
      env,
      stdout: output,
    });
    if (code !== 0) throw new Error('Team start failed');
  });
}
