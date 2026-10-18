import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** PLAN §4.2–4.3: identity only; membership and authority checks arrive in M1–M2. */
export interface Identity {
  home: string | undefined;
  teamId: string | undefined;
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
    teamId: team ?? (env.HERDR_TEAMS_TEAM || undefined),
    agent: env.HERDR_TEAMS_AGENT || undefined,
    paneId: env.HERDR_PANE_ID || undefined,
  };
}

/**
 * Resolves a --team / HERDR_TEAMS_TEAM query to a team instance id. A valid
 * UUID with an existing team dir passes through; any other string is treated
 * as a display name and resolved via Store.teams, throwing when it is
 * ambiguous or unknown.
 */
export function resolveTeamId(
  home: string,
  query: string | undefined,
): string | undefined {
  if (query === undefined) return undefined;
  if (UUID.test(query) && existsSync(join(home, 'teams', query, 'config.json')))
    return query;
  const matches = Store.teams(home).filter((t) => t.name === query);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1)
    throw new Error(
      `Team name "${query}" is ambiguous: ${matches.map((t) => t.id).join(', ')}`,
    );
  throw new Error(`Unknown team "${query}"`);
}

/** Resolve only when selecting an existing team; creation reads raw identity. */
export function readSelectedIdentity(
  env: NodeJS.ProcessEnv,
  team?: string,
): Identity {
  const identity = readIdentity(env, team);
  if (identity.home)
    identity.teamId = resolveTeamId(identity.home, identity.teamId);
  return identity;
}
