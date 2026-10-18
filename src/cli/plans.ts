import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { Store } from '../core/store.js';
import { Plans } from '../core/plans.js';
import { readIdentity } from './identity.js';
export function installPlanCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
) {
  const group = program.commands.find((c) => c.name() === 'plan')!;
  (group.commands as Command[]).splice(0);
  group.description('Submit and review task plans');
  const context = (command: Command, privileged = false) => {
    const identity = readIdentity(
      env,
      command.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.teamId)
      throw new Error('Set HERDR_TEAMS_HOME and select a team');
    const db = new Store(identity.home, identity.teamId);
    return {
      plans: new Plans(db, env),
      actor: db.authorize(identity.agent, privileged),
    };
  };
  const print = (v: unknown) => output(JSON.stringify(v, null, 2) + '\n');
  const submit = group.command('submit <id>').requiredOption('--file <path>');
  submit.action(async (id: string) => {
    const { plans, actor } = context(submit);
    print(
      await plans.submit(
        id,
        actor,
        readFileSync(submit.opts<{ file: string }>().file, 'utf8'),
      ),
    );
  });
  const approve = group.command('approve <id>');
  approve.action((id: string) =>
    print(context(approve, true).plans.verdict(id, true)),
  );
  const reject = group
    .command('reject <id>')
    .requiredOption('--feedback <text>');
  reject.action((id: string) =>
    print(
      context(reject, true).plans.verdict(
        id,
        false,
        reject.opts<{ feedback: string }>().feedback,
      ),
    ),
  );
}
