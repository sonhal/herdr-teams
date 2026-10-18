import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hooks } from './hooks.js';
import { Store, checkTaskText, clip, type Task } from './store.js';
export function planApproval(db: Store, task: Task): 'lead' | 'none' {
  return (
    task.plan_approval ??
    (task.owner
      ? db.config().details?.[task.owner]?.plan_approval
      : undefined) ??
    db.config().plan_approval ??
    'lead'
  );
}
export class Plans {
  constructor(
    readonly db: Store,
    readonly env: NodeJS.ProcessEnv,
  ) {}
  submit(id: string, actor: string, text: string) {
    return this.db.exclusive(`task-${id}`, async () => {
      const task = this.db.task(id);
      if (
        task.owner !== actor ||
        !['in_progress', 'planning'].includes(task.status)
      )
        throw new Error('Only the active task owner may submit a plan');
      if (!text.trim()) throw new Error('Plan is empty');
      let version = (task.plan?.version ?? 0) + 1;
      while (existsSync(join(this.db.root, 'plans', `${id}-${version}.md`)))
        version++;
      const path = `plans/${id}-${version}.md`;
      writeFileSync(join(this.db.root, path), text, { flag: 'wx' });
      const hooks = new Hooks(this.db, this.env);
      const outcome = await hooks.run('plan_submitted', actor, task, {
        ...task,
        plan: { version, path },
        text,
      });
      const updated = this.db.editTask(id, (current) => {
        if (JSON.stringify(current) !== JSON.stringify(task))
          throw new Error('Task changed while the plan hook ran; retry');
        current.plan = {
          version,
          path,
          verdict:
            outcome.code === 0
              ? planApproval(this.db, task) === 'none'
                ? 'approved'
                : 'pending'
              : 'rejected',
          // Hook output may hold escape codes, which take six bytes as JSON.
          feedback:
            outcome.code === 0 ? null : clip(outcome.stderr, (16 * 1024) / 6),
        };
        current.status =
          outcome.code === 0 && planApproval(this.db, task) === 'none'
            ? 'in_progress'
            : 'planning';
      });
      if (outcome.code !== 0) {
        hooks.failure(actor, updated, outcome, true);
        throw new Error(outcome.stderr || 'Plan rejected by hook');
      }
      this.db.send(
        actor,
        this.db.config().lead,
        clip(
          `Plan for #${id} ${task.subject}: ${path}\n${text.split('\n').slice(0, 8).join('\n')}`,
        ),
      );
      this.db.event('plan.submitted', { id, version, path });
      return updated;
    });
  }
  verdict(id: string, approve: boolean, feedback?: string) {
    if (!approve && !feedback?.trim())
      throw new Error('Rejection feedback is required');
    checkTaskText('feedback', feedback);
    const task = this.db.editTask(id, (current) => {
      if (!current.plan || !current.owner)
        throw new Error('Task has no submitted plan or owner');
      current.plan.verdict = approve ? 'approved' : 'rejected';
      current.plan.feedback = feedback ?? null;
      if (current.status !== 'completed')
        current.status = approve ? 'in_progress' : 'planning';
    });
    this.db.send(
      this.db.config().lead,
      task.owner!,
      clip(
        `Plan ${approve ? 'approved' : 'rejected'} for task #${id}${feedback ? `: ${feedback}` : ''}`,
      ),
    );
    this.db.event('plan.verdict', { id, approve, feedback });
    return task;
  }
}
