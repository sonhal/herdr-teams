/** PLAN §4.2–4.3: identity only; membership and authority checks arrive in M1–M2. */
export interface Identity {
  home: string | undefined;
  team: string | undefined;
  agent: string | undefined;
  paneId: string | undefined;
}

export function readIdentity(env: NodeJS.ProcessEnv, team?: string): Identity {
  return {
    home: env.HERDR_TEAMS_HOME || env.HERDR_PLUGIN_STATE_DIR || undefined,
    team: team ?? (env.HERDR_TEAMS_TEAM || undefined),
    agent: env.HERDR_TEAMS_AGENT || undefined,
    paneId: env.HERDR_PANE_ID || undefined,
  };
}
