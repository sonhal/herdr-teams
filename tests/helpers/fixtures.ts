import type { AgentInfo, PaneInfo } from '../../src/herdr/index.js';

// Derived from herdr v0.9.5 src/api/schema/{agents,panes,response}.rs;
// upstream commit 143bf5fd4781d164260c63fe28e7dc08054ad32f.
export const pane: PaneInfo = {
  pane_id: 'w1:p2',
  terminal_id: 't2',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  focused: false,
  agent_status: 'unknown',
  revision: 1,
};

export const agent: AgentInfo = {
  ...pane,
  name: 'alice',
  agent: 'codex',
  agent_status: 'idle',
  interactive_ready: true,
  state_change_seq: 4,
  completion_seq: 4,
  foreground_cwd: '/project',
  agent_session: {
    source: 'codex',
    agent: 'codex',
    kind: 'id',
    value: 'session-1',
  },
};
