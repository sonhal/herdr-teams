import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { Config } from '../core/config.js';
import { Lifecycle } from '../core/lifecycle.js';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { readIdentity, readSelectedIdentity } from './identity.js';
export function installTemplateCommands(
  program: Command,
  env: NodeJS.ProcessEnv,
  output: (text: string) => void,
) {
  const group = program.commands.find((c) => c.name() === 'team')!;
  const replace = (name: string, usage: string) => {
    const old = group.commands.find((c) => c.name() === name)!;
    if (old)
      (group.commands as Command[]).splice(group.commands.indexOf(old), 1);
    return group.command(usage);
  };
  const print = (v: unknown) => output(JSON.stringify(v, null, 2) + '\n');
  const start = replace('start', 'start <template>')
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
    const identity = readIdentity(env, flags.team);
    if (!identity.home) throw new Error('Set HERDR_TEAMS_HOME');
    const db = new Store(identity.home, randomUUID());
    const config = new Config(process.cwd(), env);
    const team = await config.start(
      db,
      new Lifecycle(db, new HerdrClient({ env }), env),
      template,
      flags.lead ?? identity.agent ?? 'lead',
      flags.kind,
      flags.name ?? flags.team ?? template,
    );
    (start as Command & { _storeId?: string })._storeId = db.id;
    print(team);
  });
  const list = replace('templates', 'templates').description(
    'List team templates: project, global, then built-in',
  );
  list.action(() => print(new Config(process.cwd(), env).catalog()));
  const save = replace('save', 'save <template>').option(
    '--scope <scope>',
    'project or global',
    'project',
  );
  save.action((template: string) => {
    const identity = readSelectedIdentity(
      env,
      save.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.teamId) throw new Error('Select a team');
    const db = new Store(identity.home, identity.teamId);
    db.authorize(identity.agent, true);
    print(
      new Config(db.config().repository_dir ?? process.cwd(), env).save(
        db,
        template,
        save.opts<{ scope: string }>().scope,
      ),
    );
  });
}
