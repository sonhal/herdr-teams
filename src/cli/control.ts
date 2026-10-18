import { Command } from 'commander';
import { clip } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { group, printer, teamContext, type Output } from './context.js';

export function installControlCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
) {
  const print = printer(output);
  function context(cmd: Command, privileged = false) {
    return {
      ...teamContext(cmd, env, privileged),
      client: new HerdrClient({ env }),
    };
  }
  const peek = program
    .command('peek <member>')
    .option('--lines <number>', 'lines of recent output', '40');
  peek.action(async (member: string) => {
    const { db, client } = context(peek);
    const pane = db.config().details?.[member]?.pane_id;
    const lines = Number(peek.opts<{ lines: string }>().lines);
    if (!Number.isSafeInteger(lines) || lines <= 0)
      throw new Error('Lines must be a positive integer');
    if (!pane) throw new Error('Member has no pane');
    output(await client.paneRead(pane, { source: 'recent-unwrapped', lines }));
  });
  const steer = program.command('steer <member> <body>');
  steer.action((member: string, body: string) => {
    const { db, actor } = context(steer, true);
    print(db.send(actor, member, body, true));
  });
  const interrupt = program
    .command('interrupt <member>')
    .option('--then <body>', 'message to deliver after idle');
  interrupt.action(async (member: string) => {
    const { db, actor, client } = context(interrupt, true);
    const details = db.config().details?.[member];
    if (!details?.pane_id || details.ended)
      throw new Error('Member is not running');
    const current = (await client.agentGet(details.pane_id)).agent;
    if (current.agent_status === 'blocked')
      throw new Error('Agent is blocked; answer its prompt first');
    await client.sendKeys(details.pane_id, 'esc');
    db.patchMember(member, { interrupted: true });
    const then = interrupt.opts<{ then?: string }>().then;
    if (then) db.send(actor, member, clip(then));
    db.event('member.interrupted', { member });
    print({ member, state: 'interrupted' });
  });
  const release = group(program, 'task')
    .command('release <id>')
    .option(
      '--reason <text>',
      'reason for releasing the task',
      'Released by the lead',
    );
  release.action(async (id: string) => {
    const { db, actor, client } = context(release, true);
    const task = db.task(id);
    if (task.status === 'completed')
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
      db.patchMember(owner!, { interrupted: true });
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
    print(released);
  });
}
