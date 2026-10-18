import { Command } from 'commander';
import { Config } from '../core/config.js';
import { Lifecycle } from '../core/lifecycle.js';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { readIdentity } from './identity.js';
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
    .option('--lead <name>', 'lead name');
  start.action(async (template: string) => {
    const flags = start.optsWithGlobals<{
      name?: string;
      lead?: string;
      team?: string;
    }>();
    const identity = readIdentity(env, flags.team);
    if (!identity.home) throw new Error('Set HERDR_TEAMS_HOME');
    const db = new Store(identity.home, flags.name ?? flags.team ?? template);
    const config = new Config(process.cwd(), env);
    print(
      await config.start(
        db,
        new Lifecycle(db, new HerdrClient({ env }), env),
        template,
        flags.lead ?? identity.agent ?? 'lead',
      ),
    );
  });
  const save = replace('save', 'save <template>').option(
    '--scope <scope>',
    'project or global',
    'project',
  );
  save.action((template: string) => {
    const identity = readIdentity(
      env,
      save.optsWithGlobals<{ team?: string }>().team,
    );
    if (!identity.home || !identity.team) throw new Error('Select a team');
    const db = new Store(identity.home, identity.team);
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
