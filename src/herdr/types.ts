/** Wire shapes verified against herdr v0.9.5 src/api/schema/{agents,panes,response}.rs.
 * Only the fields herdr-teams reads are modeled; upstream may add more fields.
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;
  cwd?: string;
  foreground_cwd?: string;
}

export interface AgentInfo extends PaneInfo {
  name?: string;
  agent?: string;
  state_change_seq: number;
  completion_seq?: number;
  launch_pending?: boolean;
  interactive_ready?: boolean;
  agent_session?: {
    source: string;
    agent: string;
    kind: 'id' | 'path';
    value: string;
  };
}

export interface PaneSplitOptions {
  pane?: string;
  direction: 'right' | 'down';
  ratio?: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  focus?: boolean;
}

export interface PaneReadOptions {
  source?: 'visible' | 'recent' | 'recent-unwrapped' | 'detection';
  lines?: number;
  format?: 'text' | 'ansi';
}

export interface AgentStartOptions {
  name: string;
  kind: string;
  pane: string;
  timeoutMs?: number;
  args?: readonly string[];
}

export interface AgentPromptOptions {
  wait?: boolean;
  until?: readonly AgentStatus[];
  timeoutMs?: number;
}

export interface PaneSplitResult {
  type: 'pane_info';
  pane: PaneInfo;
}
export interface AgentStartResult {
  type: 'agent_started';
  agent: AgentInfo;
  argv: string[];
}
export interface AgentPromptResult {
  type: 'agent_prompted';
  agent: AgentInfo;
}
export interface AgentGetResult {
  type: 'agent_info';
  agent: AgentInfo;
}
export interface AgentListResult {
  type: 'agent_list';
  agents: AgentInfo[];
}
