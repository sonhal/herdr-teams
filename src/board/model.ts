import { stripVTControlCharacters } from 'node:util';
import { Store } from '../core/store.js';
export function plain(value: string): string {
  return stripVTControlCharacters(value).replace(/[\r\n\t]/g, ' ');
}
export function snapshot(db: Store, now = Date.now()) {
  const team = db.config();
  const tasks = db.tasks();
  const delivery = db.deliveryState();
  const members = team.members.map((name) => {
    const details = team.details?.[name];
    const owned = tasks.filter(
      (t) => t.owner === name && ['planning', 'in_progress'].includes(t.status),
    );
    const inbox = db.inbox(name);
    const cursor = delivery.cursors[name];
    const start = cursor ? inbox.findIndex((m) => m.id === cursor) + 1 : 0;
    const acknowledged = new Set(delivery.acknowledged?.[name] ?? []);
    const unread = inbox
      .slice(start)
      .filter((m) => !acknowledged.has(m.id)).length;
    const state =
      details?.ended ??
      (details?.interrupted && details.state !== 'working'
        ? 'interrupted'
        : owned.some(
              (t) => t.status === 'planning' && t.plan?.verdict === 'pending',
            )
          ? 'waiting-plan'
          : (details?.state ?? 'unknown'));
    return {
      name,
      state,
      seconds:
        details?.state_since === undefined
          ? 0
          : Math.max(0, Math.floor((now - details.state_since) / 1000)),
      unread,
      tasks: owned.map((t) => t.id),
      branch: details?.worktree?.branch,
    };
  });
  return {
    name: team.name,
    members,
    tasks,
    messages: db.inbox(team.lead).slice(-5),
  };
}
export type BoardSnapshot = ReturnType<typeof snapshot>;
export function renderBoard(
  data: BoardSnapshot,
  width = 100,
  selectedTask = 0,
  selectedMember = 0,
  focus = 'tasks',
): string {
  const statuses = ['pending', 'planning', 'in_progress', 'completed'] as const;
  const columnWidth = Math.max(
    14,
    Math.floor(Math.max(84, width) / statuses.length),
  );
  const cell = (text: string) =>
    plain(text)
      .slice(0, columnWidth - 1)
      .padEnd(columnWidth);
  const columns = statuses.map((status) =>
    data.tasks.filter((t) => t.status === status),
  );
  const lines = [plain(data.name), '', 'MEMBERS (tab switches focus)'];
  for (const [index, member] of data.members.entries())
    lines.push(
      `${focus === 'members' && index === selectedMember ? '>' : ' '} ${plain(member.name)} · ${member.state} ${member.seconds}s · unread ${member.unread}${member.branch ? ` · ${plain(member.branch)}` : ''}`,
    );
  lines.push('', statuses.map(cell).join(''));
  const count = Math.max(0, ...columns.map((c) => c.length));
  for (let row = 0; row < count; row++)
    lines.push(
      columns
        .map((col) => {
          const task = col[row];
          return cell(
            task
              ? `${focus === 'tasks' && data.tasks.indexOf(task) === selectedTask ? '>' : ''}#${task.id} ${task.subject}`
              : '',
          );
        })
        .join(''),
    );
  const task = data.tasks[selectedTask];
  if (task)
    lines.push(
      '',
      `Selected #${task.id}: ${plain(task.subject)} · owner ${task.owner ?? 'unassigned'} · blocked by ${task.blockedBy.join(', ') || 'none'}`,
      plain(task.description),
    );
  lines.push(
    '',
    'RECENT LEAD MESSAGES',
    ...data.messages.map(
      (m) => `${plain(m.from)}: ${plain(m.body).slice(0, Math.max(width, 80))}`,
    ),
    '',
    'j/k select · tab focus · enter peek · m message · u steer · i interrupt · r release',
    'a assign · o reopen · p approve plan · n reject plan · x kill · q quit',
  );
  return lines.join('\n') + '\n';
}
