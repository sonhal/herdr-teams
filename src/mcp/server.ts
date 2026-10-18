import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { runCliAsync } from '../cli/index.js';

const commands = {
  status: 'Read team members, tasks and delivery status',
  team: 'Create, list, start or save teams',
  task: 'Add, claim, assign, release, complete or reopen tasks and edit dependencies',
  msg: 'Send a direct message, optionally urgent',
  broadcast: 'Send a message to every other member',
  report: 'Report to the lead',
  inbox: 'Read your inbox',
  spawn: 'Spawn a named teammate with its role and settings',
  shutdown: 'Request or answer a graceful shutdown',
  kill: 'Close a teammate pane and release its active tasks',
  done: 'Shut the team down; --force kills remaining members',
  peek: 'Read recent teammate output',
  steer: 'Queue urgent steering input',
  interrupt: 'Interrupt a teammate while preserving its session',
  plan: 'Submit, approve or reject a task plan',
  worktree: 'Request, create, inspect, merge or remove worktrees',
  cleanup:
    'List worktree cleanup candidates; --apply removes eligible worktrees',
} as const;
type Request = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export class McpServer {
  constructor(
    readonly version: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}
  async handle(value: unknown): Promise<unknown | undefined> {
    const id =
      record(value) &&
      (typeof value.id === 'string' || typeof value.id === 'number')
        ? value.id
        : null;
    const error = (code: number, message: string) => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    if (
      !record(value) ||
      value.jsonrpc !== '2.0' ||
      typeof value.method !== 'string' ||
      (value.id !== undefined &&
        value.id !== null &&
        typeof value.id !== 'string' &&
        typeof value.id !== 'number')
    )
      return error(-32600, 'Invalid Request');
    const request = value as unknown as Request;
    if (request.id === undefined) return undefined;
    const result = (data: unknown) => ({ jsonrpc: '2.0', id, result: data });
    if (request.method === 'initialize')
      return result({
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(
          String(request.params?.protocolVersion),
        )
          ? request.params!.protocolVersion
          : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'herdr-teams', version: this.version },
      });
    if (request.method === 'ping') return result({});
    if (request.method === 'tools/list')
      return result({
        tools: Object.entries(commands).map(([name, description]) => ({
          name: `herdr_teams_${name}`,
          description: `${description}. Uses herdr-teams ${name}; args are CLI arguments without the command name.`,
          inputSchema: {
            type: 'object',
            properties: {
              team: {
                type: 'string',
                description: 'Team name, defaulting to HERDR_TEAMS_TEAM',
              },
              args: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'CLI arguments, one string per argument; no shell expansion',
              },
            },
            additionalProperties: false,
          },
        })),
      });
    if (request.method !== 'tools/call')
      return error(-32601, 'Method not found');
    const name = request.params?.name;
    const command =
      typeof name === 'string' ? name.replace(/^herdr_teams_/, '') : '';
    if (!Object.hasOwn(commands, command) || name !== `herdr_teams_${command}`)
      return error(-32602, 'Unknown tool');
    const args = request.params?.arguments ?? {};
    if (
      !record(args) ||
      Object.keys(args).some((key) => !['team', 'args'].includes(key)) ||
      (args.team !== undefined && typeof args.team !== 'string') ||
      (args.args !== undefined &&
        (!Array.isArray(args.args) ||
          !args.args.every((arg) => typeof arg === 'string')))
    )
      return error(-32602, 'Invalid tool arguments');
    let text = '';
    const argv = [
      ...(typeof args.team === 'string' ? ['--team', args.team] : []),
      command,
      ...((args.args ?? []) as string[]),
    ];
    const code = await runCliAsync(argv, {
      version: this.version,
      env: this.env,
      stdout: (s) => {
        text += s;
      },
      stderr: (s) => {
        text += s;
      },
    });
    return result({
      content: [
        {
          type: 'text',
          text: text || (code === 0 ? 'Done' : 'Command failed'),
        },
      ],
      isError: code !== 0,
    });
  }
}
export async function serveMcp(
  input: Readable,
  output: (text: string) => void,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const server = new McpServer(version, env);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      output(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n',
      );
      continue;
    }
    try {
      const response = await server.handle(value);
      if (response !== undefined) output(JSON.stringify(response) + '\n');
    } catch (error) {
      output(
        JSON.stringify({
          jsonrpc: '2.0',
          id: record(value) ? (value.id ?? null) : null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }) + '\n',
      );
    }
  }
}
