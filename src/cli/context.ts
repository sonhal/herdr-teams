import type { Command } from 'commander';
import { Store } from '../core/store.js';
import { readSelectedIdentity } from './identity.js';

export type Output = (text: string) => void;

/** A command group that createCli registered. */
export function group(parent: Command, name: string): Command {
  const command = parent.commands.find((c) => c.name() === name);
  if (!command) throw new Error(`Missing command group ${name}`);
  return command;
}

/** The selected team and the member a command acts for. */
export function teamContext(
  command: Command,
  env: NodeJS.ProcessEnv,
  privileged = false,
) {
  const identity = readSelectedIdentity(
    env,
    command.optsWithGlobals<{ team?: string }>().team,
  );
  if (!identity.home)
    throw new Error('Set HERDR_TEAMS_HOME or HERDR_PLUGIN_STATE_DIR');
  if (!identity.teamId)
    throw new Error('Select a team with --team or HERDR_TEAMS_TEAM');
  const db = new Store(identity.home, identity.teamId);
  return {
    db,
    identity,
    actor: db.authorize(identity.agent, privileged, identity.paneId),
  };
}

export function printer(output: Output): (value: unknown) => void {
  return (value) => output(JSON.stringify(value, null, 2) + '\n');
}
