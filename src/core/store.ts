import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Team {
  name: string;
  lead: string;
  members: string[];
  createdAt: string;
}
export interface Task {
  id: string;
  subject: string;
  description: string;
  status:
    'pending' | 'planning' | 'in_progress' | 'completed' | 'failed' | 'deleted';
  owner: string | null;
  blockedBy: string[];
  blocks: string[];
  result: string | null;
  reopens: number;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  urgent: boolean;
  createdAt: string;
}
function name(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value))
    throw new Error(`Invalid name: ${value}`);
  return value;
}
function atomic(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export class Store {
  readonly root: string;
  constructor(
    readonly home: string,
    readonly team: string,
  ) {
    this.root = join(home, 'teams', name(team));
  }
  private lock<T>(operation: () => T): T {
    const lock = join(this.root, 'locks', 'store');
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.recoverLock(lock);
        if (Date.now() >= deadline)
          throw new Error(
            'Team store is locked; retry or inspect locks/store for an interrupted writer',
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      atomic(join(lock, 'owner.json'), { pid: process.pid });
      return operation();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  /** Only recover old locks when their process is gone; never steal a live lock. */
  private recoverLock(lock: string): void {
    const recovery = join(this.root, 'locks', 'recovery');
    try {
      mkdirSync(recovery);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    try {
      if (!existsSync(lock) || Date.now() - statSync(lock).mtimeMs < 60000)
        return;
      const owner = join(lock, 'owner.json');
      if (existsSync(owner)) {
        const { pid } = read<{ pid: number }>(owner);
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        try {
          process.kill(pid, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        }
      }
      rmSync(lock, { recursive: true, force: true });
    } finally {
      rmSync(recovery, { recursive: true, force: true });
    }
  }
  addMember(member: string): Team {
    name(member);
    return this.lock(() => {
      const config = this.config();
      if (config.members.includes(member))
        throw new Error('Member already exists');
      config.members.push(member);
      atomic(join(this.root, 'config.json'), config);
      this.event('member.added', { member });
      return config;
    });
  }
  create(lead: string): Team {
    name(lead);
    mkdirSync(join(this.home, 'teams'), { recursive: true });
    mkdirSync(this.root);
    try {
      for (const dir of ['tasks', 'inboxes', 'plans', 'locks'])
        mkdirSync(join(this.root, dir));
      const team = {
        name: this.team,
        lead,
        members: [lead],
        createdAt: new Date().toISOString(),
      };
      atomic(join(this.root, 'config.json'), team);
      this.event('team.created', team);
      return team;
    } catch (error) {
      rmSync(this.root, { recursive: true, force: true });
      throw error;
    }
  }
  config(): Team {
    return read<Team>(join(this.root, 'config.json'));
  }
  authorize(agent: string | undefined, privileged = false): string {
    const config = this.config();
    if (agent && !config.members.includes(agent))
      throw new Error(`Unknown team member: ${agent}`);
    if (privileged && agent && agent !== config.lead)
      throw new Error('Only the lead or user may perform this action');
    return agent ?? config.lead;
  }
  static teams(home: string): Team[] {
    const root = join(home, 'teams');
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(
        (n) =>
          /^[a-z][a-z0-9_-]{0,31}$/.test(n) &&
          existsSync(join(root, n, 'config.json')),
      )
      .sort()
      .map((n) => new Store(home, n).config());
  }
  tasks(): Task[] {
    return readdirSync(join(this.root, 'tasks'))
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => read<Task>(join(this.root, 'tasks', n)))
      .sort((a, b) => Number(a.id) - Number(b.id));
  }
  task(id: string): Task {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid task id');
    return read<Task>(join(this.root, 'tasks', `${id}.json`));
  }
  private save(task: Task): Task {
    task.updatedAt = new Date().toISOString();
    atomic(join(this.root, 'tasks', `${task.id}.json`), task);
    return task;
  }
  add(subject: string, description = ''): Task {
    if (!subject.trim()) throw new Error('Task subject is required');
    return this.lock(() => {
      const counter = join(this.root, 'tasks', '.highwatermark');
      const id = existsSync(counter) ? read<number>(counter) : 1;
      atomic(counter, id + 1);
      const task: Task = {
        id: String(id),
        subject,
        description,
        status: 'pending',
        owner: null,
        blockedBy: [],
        blocks: [],
        result: null,
        reopens: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.save(task);
      this.event('task.created', task);
      return task;
    });
  }
  change(
    id: string,
    action: 'claim' | 'assign' | 'release' | 'complete' | 'update',
    actor: string,
    value?: string,
    description?: string,
  ): Task {
    return this.lock(() => {
      const task = this.task(id);
      if (action === 'claim' || action === 'assign') {
        if (
          task.status !== 'pending' ||
          (action === 'claim' && task.owner !== null && task.owner !== actor)
        )
          throw new Error('Task is already claimed or not pending');
        if (task.blockedBy.some((dep) => this.task(dep).status !== 'completed'))
          throw new Error('Task has incomplete dependencies');
        const owner = action === 'claim' ? actor : value;
        if (!owner || !this.config().members.includes(owner))
          throw new Error('Owner must be a team member');
        task.owner = owner;
        if (action === 'claim') task.status = 'in_progress';
      } else if (action === 'release') {
        task.owner = null;
        task.status = 'pending';
      } else if (action === 'complete') {
        if (task.status !== 'in_progress' || task.owner !== actor)
          throw new Error('Only the owner may complete an in-progress task');
        task.status = 'completed';
        task.result = value ?? null;
      } else {
        if (value !== undefined) {
          if (!value.trim()) throw new Error('Task subject is required');
          task.subject = value;
        }
        if (description !== undefined) task.description = description;
      }
      this.save(task);
      this.event(`task.${action}`, task);
      if (action === 'complete')
        for (const dependent of this.tasks().filter((t) =>
          t.blockedBy.includes(id),
        )) {
          if (
            dependent.owner &&
            dependent.blockedBy.every(
              (dep) => this.task(dep).status === 'completed',
            )
          )
            this.send(
              actor,
              dependent.owner,
              `Task #${dependent.id} is unblocked`,
            );
        }
      return task;
    });
  }
  dependency(id: string, dependency: string, remove = false): Task {
    return this.lock(() => {
      const task = this.task(id);
      const prerequisite = this.task(dependency);
      if (task.status !== 'pending')
        throw new Error('Dependencies may only change on pending tasks');
      const reaches = (current: string, seen = new Set<string>()): boolean => {
        if (current === id) return true;
        if (seen.has(current)) return false;
        seen.add(current);
        return this.task(current).blockedBy.some((next) => reaches(next, seen));
      };
      if (!remove && reaches(dependency))
        throw new Error('Dependency would create a cycle');
      task.blockedBy = task.blockedBy.filter((d) => d !== dependency);
      prerequisite.blocks = prerequisite.blocks.filter((d) => d !== id);
      if (!remove) {
        task.blockedBy.push(dependency);
        prerequisite.blocks.push(id);
      }
      this.save(prerequisite);
      this.save(task);
      this.event('task.dependency', { id, dependency, remove });
      return task;
    });
  }
  send(from: string, to: string, body: string, urgent = false): Message {
    if (!this.config().members.includes(to))
      throw new Error(`Unknown recipient: ${to}`);
    if (!body.trim()) throw new Error('Message body is required');
    const message = {
      id: randomUUID(),
      from,
      to,
      body,
      urgent,
      createdAt: new Date().toISOString(),
    };
    appendFileSync(
      join(this.root, 'inboxes', `${name(to)}.jsonl`),
      JSON.stringify(message) + '\n',
    );
    this.event('message.sent', message);
    return message;
  }
  inbox(agent: string): Message[] {
    const path = join(this.root, 'inboxes', `${name(agent)}.jsonl`);
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Message)
      : [];
  }
  event(type: string, data: unknown): void {
    appendFileSync(
      join(this.root, 'events.jsonl'),
      JSON.stringify({
        id: randomUUID(),
        type,
        data,
        createdAt: new Date().toISOString(),
      }) + '\n',
    );
  }
}
