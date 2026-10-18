import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { Plans } from '../core/plans.js';
import { group, printer, teamContext, type Output } from './context.js';
export function installPlanCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
) {
  const plan = group(program, 'plan');
  const print = printer(output, program);
  const context = (command: Command, privileged = false) => {
    const { db, actor } = teamContext(command, env, privileged);
    return { plans: new Plans(db, env), actor };
  };
  const submit = plan.command('submit <id>').requiredOption('--file <path>');
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
  const approve = plan.command('approve <id>');
  approve.action((id: string) =>
    print(context(approve, true).plans.verdict(id, true)),
  );
  const reject = plan
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
