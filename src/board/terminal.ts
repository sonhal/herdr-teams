import { createInterface, emitKeypressEvents, type Key } from 'node:readline';
import { Store } from '../core/store.js';
import { snapshot, renderBoard } from './model.js';
export function boardAction(
  key: string,
  member: string | undefined,
  task: string | undefined,
  text = '',
): string[] | undefined {
  if (key === 'return' && member) return ['peek', member];
  if (key === 'm' && member && text) return ['msg', 'send', member, text];
  if (key === 'u' && member && text) return ['steer', member, text];
  if (key === 'i' && member)
    return ['interrupt', member, ...(text ? ['--then', text] : [])];
  if (key === 'x' && member) return ['kill', member];
  if (key === 'r' && task)
    return [
      'task',
      'release',
      task,
      '--reason',
      text || 'Released from the board',
    ];
  if (key === 'a' && task && text) return ['task', 'assign', task, text];
  if (key === 'o' && task) return ['task', 'reopen', task];
  if (key === 'p' && task) return ['plan', 'approve', task];
  if (key === 'n' && task && text)
    return ['plan', 'reject', task, '--feedback', text];
  return undefined;
}
export async function terminalBoard(
  db: Store,
  execute: (args: string[]) => Promise<{ code: number; text: string }>,
  output: (text: string) => void,
) {
  if (!process.stdin.isTTY) {
    output(renderBoard(snapshot(db)));
    return;
  }
  let taskIndex = 0;
  let memberIndex = 0;
  let focus = 'tasks';
  let busy = false;
  let message = '';
  const paint = () => {
    if (!busy)
      output(
        '\x1b[2J\x1b[H' +
          renderBoard(
            snapshot(db),
            process.stdout.columns ?? 100,
            taskIndex,
            memberIndex,
            focus,
          ) +
          message,
      );
  };
  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      process.stdin.setRawMode(false);
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const finish = (text: string) => {
        reader.close();
        process.stdin.setRawMode(true);
        resolve(text);
      };
      reader.once('SIGINT', () => finish(''));
      reader.question(question, finish);
    });
  output('\x1b[?1049h');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  emitKeypressEvents(process.stdin);
  let stop!: () => void;
  const finished = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const onKey = (_text: string, key: Key) => {
    if (busy) return;
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      stop();
      return;
    }
    const data = snapshot(db);
    if (key.name === 'tab') {
      focus = focus === 'tasks' ? 'members' : 'tasks';
      paint();
      return;
    }
    if (['j', 'k', 'up', 'down'].includes(key.name ?? '')) {
      const offset = key.name === 'j' || key.name === 'down' ? 1 : -1;
      if (focus === 'tasks')
        taskIndex = Math.max(
          0,
          Math.min(data.tasks.length - 1, taskIndex + offset),
        );
      else
        memberIndex = Math.max(
          0,
          Math.min(data.members.length - 1, memberIndex + offset),
        );
      paint();
      return;
    }
    const name = key.name ?? '';
    const selectedTask = data.tasks[taskIndex];
    const member =
      focus === 'tasks'
        ? (selectedTask?.owner ?? data.members[memberIndex]?.name)
        : data.members[memberIndex]?.name;
    if (!['return', 'm', 'u', 'i', 'x', 'r', 'a', 'o', 'p', 'n'].includes(name))
      return;
    busy = true;
    void (async () => {
      try {
        const prompts: Record<string, string> = {
          m: 'Message: ',
          u: 'Steering message: ',
          i: 'After interrupt (optional): ',
          r: 'Release reason: ',
          a: 'Assign to member: ',
          n: 'Rejection feedback: ',
        };
        const text = prompts[name] ? await ask(prompts[name]!) : '';
        const argv = boardAction(name, member, selectedTask?.id, text);
        if (argv) {
          const result = await execute(argv);
          message = result.text;
          if (name === 'return') {
            output('\x1b[2J\x1b[H' + result.text);
            await ask('Press Enter to return to the board.');
          }
        }
      } catch (error) {
        message = String(error);
      } finally {
        busy = false;
        paint();
      }
    })();
  };
  process.stdin.on('keypress', onKey);
  const clock = setInterval(paint, 500);
  process.once('SIGTERM', stop);
  try {
    paint();
    await finished;
  } finally {
    clearInterval(clock);
    process.stdin.removeListener('keypress', onKey);
    process.removeListener('SIGTERM', stop);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    output('\x1b[?1049l');
  }
}
