import { Tasks } from '../core/tasks.js';
import { Command } from 'commander';
import { HerdrClient } from '../herdr/index.js';
import { Worktrees, worktreeStatus } from '../core/worktrees.js';
import { Store } from '../core/store.js';
import { readIdentity } from './identity.js';

export function installCoreCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
): void {
  function replace(parent: Command, old: string, usage: string): Command {
    const previous = parent.commands.find((c) => c.name() === old);
    if (previous)
      (parent.commands as Command[]).splice(
        parent.commands.indexOf(previous),
        1,
      );
    return parent.command(usage);
  }
  function context(command: Command) {
    const flags = command.optsWithGlobals<{ team?: string; json?: boolean }>();
    const identity = readIdentity(env, flags.team);
    if (!identity.home)
      throw new Error('Set HERDR_TEAMS_HOME or HERDR_PLUGIN_STATE_DIR');
    return { identity, home: identity.home };
  }
  function store(command: Command, privileged = false) {
    const { identity, home } = context(command);
    if (!identity.team)
      throw new Error('Select a team with --team or HERDR_TEAMS_TEAM');
    const db = new Store(home, identity.team);
    const actor = db.authorize(identity.agent, privileged);
    return { db, actor };
  }
  function print(value: unknown): void {
    output(JSON.stringify(value, null, 2) + '\n');
  }
  const team = program.commands.find((c) => c.name() === 'team')!;
  team.description('Create and list persistent teams');
  const create = replace(team, 'create', 'create <name>').option(
    '--lead <name>',
    'lead name (default: current agent or lead)',
  );
  create.action((name: string) => {
    const { home, identity } = context(create);
    const db = new Store(home, name);
    db.create(
      create.opts<{ lead?: string }>().lead ?? identity.agent ?? 'lead',
    );
    print(
      db.updateTeam((team) => {
        if (env.HERDR_PANE_ID) team.lead_pane_id = env.HERDR_PANE_ID;
        if (env.HERDR_WORKSPACE_ID) team.workspace_id = env.HERDR_WORKSPACE_ID;
      }),
    );
  });
  const list = replace(team, 'list', 'list');
  list.action(() => print(Store.teams(context(list).home)));
  const tasks = program.commands.find((c) => c.name() === 'task')!;
  tasks.description('Manage persistent tasks and dependencies');
  const add = replace(tasks, 'add', 'add <subject>')
    .option('--description <text>', 'task description')
    .option('--worktree', 'require a dedicated worktree')
    .option('--gate <command>', 'completion gate')
    .option('--plan-mode', 'require a plan');
  add.action(async (subject: string) => {
    const { db, actor } = store(add);
    print(await new Tasks(db, env).add(actor, subject, add.opts()));
  });
  const taskList = replace(tasks, 'list', 'list');
  taskList.action(() => print(store(taskList).db.tasks()));
  const show = replace(tasks, 'show', 'show <id>');
  show.action((id: string) => print(store(show).db.task(id)));
  for (const action of [
    'claim',
    'assign',
    'release',
    'complete',
    'update',
  ] as const) {
    const cmd = replace(
      tasks,
      action,
      `${action} <id>${action === 'assign' ? ' <owner>' : ''}`,
    );
    if (action === 'complete')
      cmd.option('--result <text>', 'completion summary');
    if (action === 'update')
      cmd
        .option('--subject <text>', 'new subject')
        .option('--description <text>', 'new description');
    cmd.action((id: string, owner: unknown) => {
      const { db, actor } = store(
        cmd,
        action === 'assign' || action === 'release' || action === 'update',
      );
      const flags = cmd.opts<{
        result?: string;
        subject?: string;
        description?: string;
      }>();
      if (action === 'complete')
        return new Tasks(db, env)
          .complete(id, actor, flags.result)
          .then((completed) => {
            if (completed.worktree?.binding)
              db.send(
                actor,
                db.config().lead,
                `Task #${id} completed: ${JSON.stringify(worktreeStatus(completed.worktree.binding))}`,
                false,
                'report',
              );
            print(completed);
          });
      const changed = db.change(
        id,
        action,
        actor,
        action === 'assign' ? String(owner) : flags.subject,
        flags.description,
      );
      if (
        action === 'claim' &&
        changed.worktree?.required &&
        !changed.worktree.binding
      ) {
        return new Worktrees(db, new HerdrClient({ env }))
          .create(id)
          .then(() => print(db.task(id)))
          .catch((error: unknown) => {
            db.change(id, 'release', actor);
            throw error;
          });
      }
      print(db.task(id));
    });
  }
  const dep = tasks.commands.find((c) => c.name() === 'dep')!;
  for (const action of ['add', 'rm']) {
    const cmd = replace(dep, action, `${action} <id> <dependency>`);
    cmd.action((id: string, dependency: string) =>
      print(store(cmd, true).db.dependency(id, dependency, action === 'rm')),
    );
  }
  const msg = program.commands.find((c) => c.name() === 'msg')!;
  msg.description('Queue messages in member inboxes');
  const send = replace(msg, 'send', 'send <recipient> <body>').option(
    '--urgent',
    'queue an urgent message',
  );
  send.action((recipient: string, body: string) => {
    const { db, actor } = store(send);
    print(
      db.send(actor, recipient, body, send.opts<{ urgent?: boolean }>().urgent),
    );
  });
  const inbox = replace(program, 'inbox', 'inbox');
  inbox.action(() => {
    const { db, actor } = store(inbox);
    print(db.inbox(actor));
  });
  const report = replace(program, 'report', 'report <body>');
  report.action((body: string) => {
    const { db, actor } = store(report);
    print(db.send(actor, db.config().lead, body));
  });
  const broadcast = replace(program, 'broadcast', 'broadcast <body>');
  broadcast.action((body: string) => {
    const { db, actor } = store(broadcast);
    print(
      db
        .config()
        .members.filter((n) => n !== actor)
        .map((n) => db.send(actor, n, body)),
    );
  });
}
