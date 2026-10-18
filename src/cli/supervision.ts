import { Command } from 'commander';
import { Store, clip } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { supervise, ensureSupervisor } from '../supervisor/runtime.js';
import { readSelectedIdentity } from './identity.js';

export function installSupervisionCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
) {
  function replace(name: string, usage: string) {
    const previous = program.commands.find((c) => c.name() === name);
    if (previous)
      (program.commands as Command[]).splice(
        program.commands.indexOf(previous),
        1,
      );
    return program.command(usage);
  }
  function context(cmd: Command, privileged = false) {
    const identity = readSelectedIdentity(
      env,
      cmd.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.teamId)
      throw new Error('Set HERDR_TEAMS_HOME and select a team');
    const db = new Store(identity.home, identity.teamId);
    return {
      db,
      actor: db.authorize(identity.agent, privileged),
      client: new HerdrClient({ env }),
    };
  }
  const peek = replace('peek', 'peek <member>').option(
    '--lines <number>',
    'lines of recent output',
    '40',
  );
  peek.action(async (member: string) => {
    const { db, client } = context(peek);
    const pane = db.config().details?.[member]?.pane_id;
    const lines = Number(peek.opts<{ lines: string }>().lines);
    if (!Number.isSafeInteger(lines) || lines <= 0)
      throw new Error('Lines must be a positive integer');
    if (!pane) throw new Error('Member has no pane');
    output(await client.paneRead(pane, { source: 'recent-unwrapped', lines }));
  });
  const steer = replace('steer', 'steer <member> <body>');
  steer.action((member: string, body: string) => {
    const { db, actor } = context(steer, true);
    output(JSON.stringify(db.send(actor, member, body, true)) + '\n');
  });
  const interrupt = replace('interrupt', 'interrupt <member>').option(
    '--then <body>',
    'message to deliver after idle',
  );
  interrupt.action(async (member: string) => {
    const { db, actor, client } = context(interrupt, true);
    const details = db.config().details?.[member];
    if (!details?.pane_id || details.ended)
      throw new Error('Member is not running');
    const current = (await client.agentGet(details.pane_id)).agent;
    if (current.agent_status === 'blocked')
      throw new Error('Agent is blocked; answer its prompt first');
    await client.sendKeys(details.pane_id, 'esc');
    db.patchMember(member, { interrupted: true, progress_at: Date.now() });
    const then = interrupt.opts<{ then?: string }>().then;
    if (then) db.send(actor, member, clip(then));
    db.event('member.interrupted', { member });
    output(JSON.stringify({ member, state: 'interrupted' }) + '\n');
  });
  const tasks = program.commands.find((c) => c.name() === 'task')!;
  const previousRelease = tasks.commands.find((c) => c.name() === 'release')!;
  (tasks.commands as Command[]).splice(
    tasks.commands.indexOf(previousRelease),
    1,
  );
  const release = tasks
    .command('release <id>')
    .option(
      '--reason <text>',
      'reason for releasing the task',
      'Released by the lead',
    );
  release.action(async (id: string) => {
    const { db, actor, client } = context(release, true);
    const task = db.task(id);
    if (['completed', 'failed', 'deleted'].includes(task.status))
      throw new Error('Task is no longer active');
    const owner = task.owner;
    const member = owner ? db.config().details?.[owner] : undefined;
    if (
      member?.pane_id &&
      !member.ended &&
      ['planning', 'in_progress'].includes(task.status)
    ) {
      const current = (await client.agentGet(member.pane_id)).agent;
      if (current.agent_status === 'blocked')
        throw new Error(
          'Owner is blocked; answer its prompt before releasing the task',
        );
      await client.sendKeys(member.pane_id, 'esc');
      db.patchMember(owner!, { interrupted: true, progress_at: Date.now() });
    }
    const currentTask = db.task(id);
    if (currentTask.owner !== owner || currentTask.status !== task.status)
      throw new Error('Task changed; retry release');
    const released = db.change(id, 'release', actor);
    if (owner)
      db.send(
        actor,
        owner,
        clip(
          `Task #${id} released: ${release.opts<{ reason: string }>().reason}`,
        ),
      );
    output(JSON.stringify(released) + '\n');
  });
  const command = replace('supervise', 'supervise');
  command.action(async () => {
    const { db, client } = context(command, true);
    if (env.HERDR_PLUGIN_ENTRYPOINT_ID !== 'supervisor') {
      await ensureSupervisor(db, client);
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await supervise(db, client, env, controller.signal, output);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  });
}
