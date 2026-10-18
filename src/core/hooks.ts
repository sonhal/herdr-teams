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
  cwd(task?: Task): string {
    return (
      task?.worktree?.binding?.path ??
      this.db.config().repository_dir ??
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
          HERDR_TEAMS_TEAM: this.db.team,
          HERDR_TEAMS_AGENT: actor,
          HERDR_TEAMS_TASK_ID: task?.id ?? '',
          HERDR_TEAMS_TASK_JSON: JSON.stringify(task ?? payload),
          PI_TEAM: this.db.team,
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
          team: this.db.team,
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
  failure(actor: string, task: Task | undefined, result: HookResult): void {
    const text = clip(result.stderr.trim() || `Hook exited ${result.code}`);
    const team = this.db.config();
    this.db.send(team.lead, actor, text);
    this.db.event('hook.failed', {
      actor,
      task: task?.id,
      code: result.code,
      stderr: text,
    });
    if (result.code === 2) return;
    this.db.send(
      actor,
      team.lead,
      clip(`Hook failure${task ? ` on task #${task.id}` : ''}: ${text}`),
      false,
      'advisory',
    );
    const policy = team.hooks?.failure_action ?? 'warn';
    if (
      task &&
      ['reopen', 'reopen_followup'].includes(policy) &&
      task.reopens < (team.hooks?.max_reopens ?? 3)
    )
      this.db.editTask(task.id, (t) => {
        t.status = 'in_progress';
        t.reopens += 1;
      });
    if (task && ['followup', 'reopen_followup'].includes(policy)) {
      const followup = this.db.add(`Follow up: ${task.subject}`, text);
      const target = team.hooks?.followup_owner ?? 'member';
      if (target !== 'none')
        this.db.change(
          followup.id,
          'assign',
          team.lead,
          target === 'lead' ? team.lead : actor,
        );
    }
  }
}
