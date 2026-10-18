import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store, clip, type Task } from './store.js';

export interface HookResult {
  code: number;
  stderr: string;
}
export type HookEvent =
  'task_created' | 'task_completed' | 'plan_submitted' | 'teammate_idle';
export class Hooks {
  constructor(
    readonly db: Store,
    readonly env: NodeJS.ProcessEnv,
  ) {}
  /** A task's hooks run in its owner's worktree, if it has one. */
  cwd(task?: Task): string {
    const team = this.db.config();
    return (
      (task?.owner && team.details?.[task.owner]?.worktree?.path) ||
      team.repository_dir ||
      process.cwd()
    );
  }
  async execute(
    command: string,
    args: string[],
    event: HookEvent,
    actor: string,
    task?: Task,
    payload: unknown = task,
  ): Promise<HookResult> {
    const timeout = this.db.config().hooks?.timeout_seconds ?? 600;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('Hook timeout must be positive');
    return new Promise((resolve) => {
      let stderr = '';
      let stdout = '';
      let failed = false;
      const child = spawn(command, args, {
        cwd: this.cwd(task),
        detached: process.platform !== 'win32',
        env: {
          ...this.env,
          HERDR_TEAMS_HOME: this.db.home,
          HERDR_TEAMS_EVENT: event,
          HERDR_TEAMS_TEAM: this.db.id,
          HERDR_TEAMS_AGENT: actor,
          HERDR_TEAMS_TASK_ID: task?.id ?? '',
          HERDR_TEAMS_TASK_JSON: JSON.stringify(task ?? payload),
          PI_TEAM: this.db.id,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const kill = () => {
        if (!child.pid) return;
        try {
          process.kill(
            process.platform === 'win32' ? child.pid : -child.pid,
            'SIGKILL',
          );
        } catch {
          /* Already exited. */
        }
      };
      const timer = setTimeout(() => {
        failed = true;
        stderr += '\nHook timed out';
        kill();
      }, timeout * 1000);
      const collect = (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 1024 * 1024) {
          stderr =
            stderr.slice(0, 1024 * 1024) + '\nHook output exceeded limit';
          failed = true;
          kill();
        }
      };
      child.stderr.on('data', collect);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({
          event,
          team: this.db.id,
          actor,
          task,
          data: payload,
        }) + '\n',
      );
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stderr: error.message });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code: failed ? -1 : (code ?? -1), stderr: stderr || stdout });
      });
    });
  }
  async run(
    event: HookEvent,
    actor: string,
    task?: Task,
    payload: unknown = task,
  ): Promise<HookResult> {
    const cwd = this.cwd(task);
    const project = join(cwd, '.herdr', 'teams', 'hooks', event);
    const global = join(
      this.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'herdr-teams',
      'hooks',
      event,
    );
    const hook = existsSync(project)
      ? project
      : existsSync(global)
        ? global
        : undefined;
    if (hook) {
      const result = await this.execute(hook, [], event, actor, task, payload);
      if (result.code !== 0) return result;
    }
    const compatibility = join(cwd, '.pi', 'team-hooks', 'task_completed.sh');
    if (event === 'task_completed' && existsSync(compatibility))
      return this.execute(
        compatibility,
        [JSON.stringify(payload)],
        event,
        actor,
        task,
        payload,
      );
    return { code: 0, stderr: '' };
  }
  /**
   * Feedback goes to the actor, unless the command it ran already reports the
   * failure. Exit 2 is a deliberate rejection; any other failure is a broken
   * hook, which the lead also hears about.
   */
  failure(
    actor: string,
    task: Task | undefined,
    result: HookResult,
    reported = false,
  ): void {
    const text = clip(result.stderr.trim() || `Hook exited ${result.code}`);
    const lead = this.db.config().lead;
    if (!reported) this.db.send(lead, actor, text);
    this.db.event('hook.failed', {
      actor,
      task: task?.id,
      code: result.code,
      stderr: text,
    });
    if (result.code !== 2)
      this.db.send(
        actor,
        lead,
        clip(`Hook failure${task ? ` on task #${task.id}` : ''}: ${text}`),
        false,
        'advisory',
      );
  }
}
