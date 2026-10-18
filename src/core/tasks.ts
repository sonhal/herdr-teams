import { Hooks } from './hooks.js';
import { planApproval } from './plans.js';
import { Store, checkTaskText, clip, type Task } from './store.js';
import { worktreeStatus } from './worktrees.js';
export class Tasks {
  constructor(
    readonly db: Store,
    readonly env: NodeJS.ProcessEnv,
  ) {}
  async add(
    actor: string,
    subject: string,
    options: {
      description?: string;
      gate?: string;
      planMode?: boolean;
    } = {},
  ) {
    // Checked before the hook, which receives them in its environment.
    if (!subject.trim()) throw new Error('Task subject is required');
    checkTaskText('subject', subject);
    checkTaskText('description', options.description);
    checkTaskText('gate', options.gate);
    const hooks = new Hooks(this.db, this.env);
    const outcome = await hooks.run('task_created', actor, undefined, {
      subject,
      ...options,
    });
    if (outcome.code !== 0)
      throw new Error(outcome.stderr || 'Task rejected by hook');
    return this.db.add(subject, options.description, options);
  }
  complete(id: string, actor: string, result?: string): Promise<Task> {
    return this.db.exclusive(`task-${id}`, async () => {
      const task = this.db.task(id);
      if (task.owner !== actor || task.status !== 'in_progress')
        throw new Error('Only the owner may complete an in-progress task');
      checkTaskText('result', result);
      if (
        (task.plan_mode || this.db.config().details?.[actor]?.plan_mode) &&
        planApproval(this.db, task) === 'lead' &&
        task.plan?.verdict !== 'approved'
      )
        throw new Error(
          'Submit a plan and wait for approval before completion',
        );
      const hooks = new Hooks(this.db, this.env);
      let outcome = task.gate
        ? await hooks.execute(
            '/bin/sh',
            ['-c', task.gate],
            'task_completed',
            actor,
            task,
          )
        : { code: 0, stderr: '' };
      if (outcome.code === 0)
        outcome = await hooks.run('task_completed', actor, task, {
          ...task,
          status: 'completed',
          result,
        });
      if (outcome.code !== 0) {
        if (JSON.stringify(this.db.task(id)) !== JSON.stringify(task))
          throw new Error('Task changed while the hook was running; retry');
        hooks.failure(actor, task, outcome, true);
        throw new Error(
          outcome.stderr || `Completion rejected (exit ${outcome.code})`,
        );
      }
      const completed = this.db.change(
        id,
        'complete',
        actor,
        result,
        undefined,
        task,
      );
      const lead = this.db.config().lead;
      if (actor !== lead)
        this.db.send(
          actor,
          lead,
          clip(
            [
              `Completed task #${id}: ${task.subject}`,
              result,
              this.checkout(actor),
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        );
      return completed;
    });
  }
  /** The completion is saved already, so a broken checkout only goes unreported. */
  private checkout(member: string): string | undefined {
    const tree = this.db.config().details?.[member]?.worktree;
    if (!tree) return;
    try {
      const { branch, base, head, ahead, status } = worktreeStatus(tree);
      const short = (ref: string) =>
        /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
      return `Worktree: ${branch} at ${short(head)}, ${ahead} commit(s) on ${short(base)}, ${status}`;
    } catch {
      return `Worktree: ${tree.branch}, status unavailable`;
    }
  }
}
