import { stringify } from 'yaml';
import type { Message, Task, Team } from '../core/store.js';

/** Compact text for agents and people; `--json` prints the full records. */
export function text(value: unknown): string {
  return value === undefined ? '' : stringify(value);
}

export function taskLine(task: Task): string {
  const after = task.blockedBy.length
    ? ` (after ${task.blockedBy.map((id) => `#${id}`).join(', ')})`
    : '';
  return `#${task.id} ${task.status}${task.owner ? ` ${task.owner}` : ''}: ${task.subject}${after}`;
}

export function taskList(tasks: Task[]): string {
  return tasks.length ? tasks.map(taskLine).join('\n') : '(no tasks)';
}

export function taskDetail(task: Task): string {
  return [
    taskLine(task),
    task.description,
    task.gate && `Gate: ${task.gate}`,
    task.plan &&
      `Plan v${task.plan.version} ${task.plan.verdict}: ${task.plan.path}${task.plan.feedback ? `\nFeedback: ${task.plan.feedback}` : ''}`,
    task.result && `Result: ${task.result}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function mail(messages: Message[]): string {
  return messages.length
    ? messages
        .map((m) => `${m.from}${m.urgent ? ' (urgent)' : ''}: ${m.body}`)
        .join('\n\n')
    : '(no mail)';
}

export function sent(messages: Message | Message[]): string {
  const list = [messages].flat();
  return list.length
    ? `Sent to ${list.map((m) => m.to).join(', ')}`
    : 'No recipients';
}

export function team(team: Team): string {
  return `id: ${team.id}\nname: ${team.name}\nlead: ${team.lead}\nmembers: ${team.members.join(', ')}`;
}

export function teams(list: Team[]): string {
  return list.length
    ? list.map((t) => `${t.id} ${t.name} (lead ${t.lead})`).join('\n')
    : '(no teams)';
}
