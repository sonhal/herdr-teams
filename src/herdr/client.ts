import {
  HerdrApiError,
  HerdrProcessError,
  HerdrProtocolError,
  HerdrUsageError,
} from './errors.js';
import { runCommand, type CommandRunner } from './transport.js';
import type {
  AgentGetResult,
  AgentListResult,
  AgentPromptOptions,
  AgentPromptResult,
  AgentStartOptions,
  AgentStartResult,
  PaneReadOptions,
  PaneSplitOptions,
  PaneSplitResult,
} from './types.js';

export interface HerdrClientOptions {
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new HerdrProtocolError('herdr returned invalid JSON', { cause });
  }
}

// Validate the common fields on which M1–M2 depend before exposing typed results.
function pane(value: unknown): boolean {
  return (
    record(value) &&
    ['pane_id', 'terminal_id', 'workspace_id', 'tab_id'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    typeof value.focused === 'boolean' &&
    typeof value.revision === 'number' &&
    ['idle', 'working', 'blocked', 'done', 'unknown'].includes(
      String(value.agent_status),
    )
  );
}
function agent(value: unknown): boolean {
  return (
    pane(value) && record(value) && typeof value.state_change_seq === 'number'
  );
}

/** CLI wrapper, not a socket client. Successful calls return the unwrapped .result.
 * TODO PLAN §4.1 (M2+): add other herdr operations only as their milestone needs them.
 */
export class HerdrClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: CommandRunner;
  readonly binary: string;

  constructor(options: HerdrClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? runCommand;
    this.binary = this.env.HERDR_BIN_PATH || 'herdr';
  }

  private async invoke(argv: readonly string[]): Promise<string> {
    // Linux's MAX_ARG_STRLEN: 32 pages, including the terminating NUL.
    if (argv.some((arg) => Buffer.byteLength(arg) >= 128 * 1024))
      throw new HerdrUsageError('herdr argument exceeds 128 KiB');
    let output;
    try {
      output = await this.runner(this.binary, argv, this.env);
    } catch (cause) {
      throw new HerdrProcessError(`Could not execute ${this.binary}`, null, {
        cause,
      });
    }
    if (output.signal)
      throw new HerdrProcessError(`herdr terminated by ${output.signal}`, null);
    if (output.exitCode === 2) throw new HerdrUsageError(output.stderr);
    if (output.exitCode === 1) {
      const response = parse(output.stderr);
      if (
        record(response) &&
        typeof response.id === 'string' &&
        record(response.error) &&
        typeof response.error.code === 'string' &&
        typeof response.error.message === 'string'
      ) {
        throw new HerdrApiError(
          response.error.code,
          response.error.message,
          response.id,
        );
      }
      throw new HerdrProtocolError('herdr returned an invalid error envelope');
    }
    if (output.exitCode !== 0)
      throw new HerdrProcessError(
        output.stderr.trim() || 'herdr exited unexpectedly',
        output.exitCode,
      );
    return output.stdout;
  }

  private async json<T>(
    argv: string[],
    type: string,
    validate: (result: Record<string, unknown>) => boolean,
  ): Promise<T> {
    const response = parse(await this.invoke(argv));
    if (
      !record(response) ||
      typeof response.id !== 'string' ||
      !record(response.result) ||
      response.result.type !== type ||
      !validate(response.result)
    ) {
      throw new HerdrProtocolError(`Expected herdr ${type} response`);
    }
    return response.result as T;
  }

  async command(
    argv: string[],
    type?: string,
  ): Promise<Record<string, unknown>> {
    const response = parse(await this.invoke(argv));
    if (
      !record(response) ||
      typeof response.id !== 'string' ||
      !record(response.result) ||
      typeof response.result.type !== 'string' ||
      (type && response.result.type !== type)
    )
      throw new HerdrProtocolError('Invalid herdr response');
    return response.result;
  }
  /** For herdr's quiet commands, which print nothing on success; errors still raise. */
  async quiet(argv: string[]): Promise<void> {
    await this.invoke(argv);
  }
  async createLocation(
    kind: 'tab' | 'workspace',
    label: string,
    cwd: string,
    env: Record<string, string>,
    workspace?: string,
  ): Promise<import('./types.js').PaneInfo> {
    const argv = [kind, 'create', '--label', label, '--cwd', cwd, '--no-focus'];
    if (kind === 'tab' && workspace) argv.push('--workspace', workspace);
    for (const [key, value] of Object.entries(env))
      argv.push('--env', `${key}=${value}`);
    const result = await this.json<{
      root_pane: import('./types.js').PaneInfo;
    }>(argv, `${kind}_created`, (r) => pane(r.root_pane));
    return result.root_pane;
  }
  async paneClose(id: string): Promise<void> {
    await this.command(['pane', 'close', id]);
  }
  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.command(['agent', 'send-keys', target, ...keys]);
  }
  paneSplit(options: PaneSplitOptions): Promise<PaneSplitResult> {
    const argv = ['pane', 'split'];
    if (options.pane !== undefined) argv.push('--pane', options.pane);
    argv.push('--direction', options.direction);
    if (options.ratio !== undefined)
      argv.push('--ratio', String(options.ratio));
    if (options.cwd !== undefined) argv.push('--cwd', options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {}))
      argv.push('--env', `${key}=${value}`);
    argv.push(options.focus ? '--focus' : '--no-focus');
    return this.json(argv, 'pane_info', (result) => pane(result.pane));
  }

  /** Unlike the other calls, herdr's CLI prints pane reads as raw UTF-8 text. */
  paneRead(target: string, options: PaneReadOptions = {}): Promise<string> {
    const argv = ['pane', 'read', target];
    if (options.source !== undefined) argv.push('--source', options.source);
    if (options.lines !== undefined)
      argv.push('--lines', String(options.lines));
    if (options.format !== undefined) argv.push('--format', options.format);
    return this.invoke(argv);
  }

  agentStart(options: AgentStartOptions): Promise<AgentStartResult> {
    const argv = [
      'agent',
      'start',
      options.name,
      '--kind',
      options.kind,
      '--pane',
      options.pane,
    ];
    if (options.timeoutMs !== undefined)
      argv.push('--timeout', String(options.timeoutMs));
    if (options.args?.length) argv.push('--', ...options.args);
    return this.json(
      argv,
      'agent_started',
      (result) =>
        agent(result.agent) &&
        Array.isArray(result.argv) &&
        result.argv.every((arg: unknown) => typeof arg === 'string'),
    );
  }

  agentPrompt(
    target: string,
    text: string,
    options: AgentPromptOptions = {},
  ): Promise<AgentPromptResult> {
    // v0.9.5 consumes text verbatim immediately after the target, even with '-'.
    const argv = ['agent', 'prompt', target, text];
    if (options.wait) argv.push('--wait');
    for (const status of options.until ?? []) argv.push('--until', status);
    if (options.timeoutMs !== undefined)
      argv.push('--timeout', String(options.timeoutMs));
    return this.json(argv, 'agent_prompted', (result) => agent(result.agent));
  }

  agentGet(target: string): Promise<AgentGetResult> {
    return this.json(['agent', 'get', target], 'agent_info', (result) =>
      agent(result.agent),
    );
  }

  agentList(): Promise<AgentListResult> {
    return this.json(
      ['agent', 'list'],
      'agent_list',
      (result) => Array.isArray(result.agents) && result.agents.every(agent),
    );
  }
}
