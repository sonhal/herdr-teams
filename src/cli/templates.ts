import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { Config } from '../core/config.js';
import { Lifecycle } from '../core/lifecycle.js';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { readIdentity } from './identity.js';
import { group, printer, teamContext, type Output } from './context.js';
import * as format from './format.js';
export function installTemplateCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: Output,
  warn: Output = () => {},
) {
  const team = group(program, 'team');
  const print = printer(output, program);
  const start = team
    .command('start <template>')
    .option('--name <name>', 'runtime team name')
    .option('--lead <name>', 'lead name')
    .option(
      '--kind <kind>',
      "agent CLI for members whose role names none (default: this pane's agent)",
    );
  start.action(async (template: string) => {
    const flags = start.optsWithGlobals<{
      name?: string;
      lead?: string;
      kind?: string;
      team?: string;
    }>();
    if (flags.team !== undefined)
      throw new Error('team start creates a new team; name it with --name');
    const identity = readIdentity(env);
    if (!identity.home) throw new Error('Set HERDR_TEAMS_HOME');
    const db = new Store(identity.home, randomUUID());
    const config = new Config(process.cwd(), env);
    const team = await config.start(
      db,
      new Lifecycle(db, new HerdrClient({ env }), env, warn),
      template,
      flags.lead ?? identity.agent ?? 'lead',
      flags.kind,
      // Teams are never deleted, so a bare template name would soon make
      // --team <name> ambiguous; the ID prefix keeps the default distinct.
      flags.name ?? `${template.slice(0, 27)}-${db.id.slice(0, 4)}`,
    );
    (start as Command & { _storeId?: string })._storeId = db.id;
    print(team, format.team);
  });
  const list = team
    .command('templates')
    .description('List team templates: project, global, then built-in');
  list.action(() => print(new Config(process.cwd(), env).catalog()));
  const save = team
    .command('save <template>')
    .option('--scope <scope>', 'project or global', 'project');
  save.action((template: string) => {
    const { db } = teamContext(save, env, true);
    print(
      new Config(db.config().repository_dir ?? process.cwd(), env).save(
        db,
        template,
        save.opts<{ scope: string }>().scope,
      ),
    );
  });
}
