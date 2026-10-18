import { Tasks } from '../core/tasks.js';
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store.js';
import { pluginStateDir, readIdentity } from './identity.js';
import { group, printer, teamContext, type Output } from './context.js';
import * as format from './format.js';

export function installCoreCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
  warn: Output = () => {},
): void {
  const print = printer(output, program);
  function home(command: Command): string {
    const flags = command.optsWithGlobals<{ team?: string }>();
    const home = readIdentity(env, flags.team).home;
    if (!home)
      throw new Error('Set HERDR_TEAMS_HOME or HERDR_PLUGIN_STATE_DIR');
    return home;
  }
  const team = group(program, 'team');
  const create = team
    .command('create <name>')
    .option('--lead <name>', 'lead name (default: current agent or lead)');
  create.action((name: string) => {
    const stateHome = home(create);
    const hooks = pluginStateDir(env);
    if (hooks && hooks !== stateHome)
      warn(
        `warning: herdr's startup and event hooks read ${hooks}, not ${stateHome}; event hooks will not find this team\n`,
      );
    Store.checkLeadPane(stateHome, env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID);
    const db = new Store(stateHome, randomUUID());
    db.create(
      create.opts<{ lead?: string }>().lead ??
        readIdentity(env).agent ??
        'lead',
      name,
    );
    db.bindSession(env.HERDR_SOCKET_PATH);
    (create as Command & { _storeId?: string })._storeId = db.id;
    print(
      db.updateTeam((team) => {
        if (env.HERDR_PANE_ID) team.lead_pane_id = env.HERDR_PANE_ID;
        if (env.HERDR_WORKSPACE_ID) team.workspace_id = env.HERDR_WORKSPACE_ID;
      }),
      format.team,
    );
  });
  const list = team.command('list');
  list.action(() => print(Store.teams(home(list)), format.teams));

  const tasks = group(program, 'task');
  const add = tasks
    .command('add <subject>')
    .option('--description <text>', 'task description')
    .option('--gate <command>', 'completion gate')
    .option('--plan-mode', 'require a plan');
  add.action(async (subject: string) => {
    const { db, actor } = teamContext(add, env);
    print(
      await new Tasks(db, env).add(actor, subject, add.opts()),
      format.taskLine,
    );
  });
  const taskList = tasks.command('list');
  taskList.action(() =>
    print(teamContext(taskList, env).db.tasks(), format.taskList),
  );
  const show = tasks.command('show <id>');
  show.action((id: string) =>
    print(teamContext(show, env).db.task(id), format.taskDetail),
  );
  const claim = tasks.command('claim <id>');
  claim.action((id: string) => {
    const { db, actor } = teamContext(claim, env);
    print(db.change(id, 'claim', actor), format.taskLine);
  });
  const assign = tasks.command('assign <id> <owner>');
  assign.action((id: string, owner: string) => {
    const { db, actor } = teamContext(assign, env, true);
    print(db.change(id, 'assign', actor, owner), format.taskLine);
  });
  const complete = tasks
    .command('complete <id>')
    .option('--result <text>', 'completion summary');
  complete.action(async (id: string) => {
    const { db, actor } = teamContext(complete, env);
    print(
      await new Tasks(db, env).complete(
        id,
        actor,
        complete.opts<{ result?: string }>().result,
      ),
      format.taskLine,
    );
  });
  const update = tasks
    .command('update <id>')
    .option('--subject <text>', 'new subject')
    .option('--description <text>', 'new description');
  update.action((id: string) => {
    const { db, actor } = teamContext(update, env, true);
    const flags = update.opts<{ subject?: string; description?: string }>();
    print(
      db.change(id, 'update', actor, flags.subject, flags.description),
      format.taskLine,
    );
  });
  const reopen = tasks.command('reopen <id>');
  reopen.action((id: string) => {
    const { db } = teamContext(reopen, env, true);
    const task = db.editTask(id, (t) => {
      if (t.status !== 'completed')
        throw new Error('Only a completed task may be reopened');
      t.status = 'pending';
      t.result = null;
      t.reopens++;
      delete t.plan;
    });
    if (task.owner)
      db.send(db.config().lead, task.owner, `Task #${id} reopened`);
    print(task, format.taskLine);
  });
  const dep = group(tasks, 'dep');
  for (const action of ['add', 'rm']) {
    const cmd = dep.command(`${action} <id> <dependency>`);
    cmd.action((id: string, dependency: string) =>
      print(
        teamContext(cmd, env, true).db.dependency(
          id,
          dependency,
          action === 'rm',
        ),
        format.taskLine,
      ),
    );
  }

  const send = group(program, 'msg')
    .command('send <recipient> <body>')
    .option('--urgent', 'interrupt a working recipient (lead or user only)');
  send.action((recipient: string, body: string) => {
    const urgent = send.opts<{ urgent?: boolean }>().urgent;
    // Urgent mail can press Esc in the recipient's pane, like interrupt.
    const { db, actor } = teamContext(send, env, urgent);
    print(db.send(actor, recipient, body, urgent), format.sent);
  });
  const inbox = program
    .command('inbox')
    .option('--all', 'include mail already delivered');
  inbox.action(() => {
    const { db, actor } = teamContext(inbox, env);
    print(
      inbox.opts<{ all?: boolean }>().all ? db.inbox(actor) : db.unread(actor),
      format.mail,
    );
  });
  const report = program.command('report <body>');
  report.action((body: string) => {
    const { db, actor } = teamContext(report, env);
    print(db.send(actor, db.config().lead, body), format.sent);
  });
  const broadcast = program.command('broadcast <body>');
  broadcast.action((body: string) => {
    const { db, actor } = teamContext(broadcast, env);
    print(
      db
        .config()
        .members.filter((n) => n !== actor)
        .map((n) => db.send(actor, n, body)),
      format.sent,
    );
  });
}
