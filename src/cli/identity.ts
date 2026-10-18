import { join } from 'node:path';

/** PLAN §4.2–4.3: identity only; membership and authority checks arrive in M1–M2. */
export interface Identity {
  home: string | undefined;
  team: string | undefined;
  agent: string | undefined;
  paneId: string | undefined;
}

/**
 * herdr sets HERDR_PLUGIN_STATE_DIR only for plugin processes, so a lead in an
 * ordinary pane derives it as herdr 0.9.5 does (src/plugin_paths.rs) to share
 * one home with the startup and event hooks.
 */
export function pluginStateDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.HERDR_PLUGIN_STATE_DIR) return env.HERDR_PLUGIN_STATE_DIR;
  if (env.HERDR_ENV !== '1') return undefined;
  const state = env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, 'herdr')
    : env.HOME
      ? join(env.HOME, '.local', 'state', 'herdr')
      : undefined;
  return state && join(state, 'plugins', 'herdr-teams');
}

export function readIdentity(env: NodeJS.ProcessEnv, team?: string): Identity {
  return {
    home: env.HERDR_TEAMS_HOME || pluginStateDir(env),
    team: team ?? (env.HERDR_TEAMS_TEAM || undefined),
    agent: env.HERDR_TEAMS_AGENT || undefined,
    paneId: env.HERDR_PANE_ID || undefined,
  };
}
