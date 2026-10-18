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
  auto_claim?: boolean;
  repository_dir?: string;
  plan_approval?: 'lead' | 'none';
  hooks?: {
    failure_action?: 'warn' | 'reopen' | 'followup' | 'reopen_followup';
    max_reopens?: number;
    followup_owner?: 'member' | 'lead' | 'none';
    timeout_seconds?: number;
  };
  worktree_requests?: 'lead' | 'auto';
  requests?: Record<
    string,
    { member: string; reason: string; task?: string; approved: boolean }
  >;
  workspace_id?: string;
  lead_pane_id?: string;
  details?: Record<string, Member>;
  defaults?: {
    kind?: string;
    model?: string;
    thinking?: string;
    worktree?: 'shared' | 'dedicated' | 'auto';
    auto_claim?: boolean;
    plan_mode?: boolean;
    plan_approval?: 'lead' | 'none';
    interactive?: boolean;
  };
  layout?: { tab_id: string; pane_id: string; count: number; number: number };
  supervisor?: {
    mode: 'pane' | 'tab' | 'off';
    pane_id?: string;
    tick_seconds?: number;
    no_progress_minutes?: number;
    needs_input_minutes?: number;
    unknown_minutes?: number;
    on_no_progress?: 'notify' | 'nudge';
  };
  createdAt: string;
}
export interface Worktree {
  path: string;
  branch: string;
  base: string;
  workspace_id: string;
  pane_id: string;
  tab_id: string;
}
export type EndState =
  'shut-down' | 'closed-by-user' | 'failed-to-launch' | 'crashed' | 'killed';
export interface Member {
  kind: string;
  definition?: string;
  prompt?: string;
  instructions?: string;
  auto_claim?: boolean;
  model?: string;
  thinking?: string;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  plan_mode?: boolean;
  plan_approval?: 'lead' | 'none';
  state: string;
  state_since?: number;
  progress_at?: number;
  last_activity?: number;
  focused_at?: number;
  interactive?: boolean;
  interrupted?: boolean;
  screen_hash?: string;
  advisory?: 'no-progress' | 'needs-input' | 'unclassified' | null;
  advisory_notified?: boolean;
  nudged?: boolean;
  ended?: EndState;
  shutdown_requested?: boolean;
  shutdown_accepted?: boolean;
  shutdown_exit_sent?: boolean;
  launch_args?: string[];
  worktree_mode?: 'shared' | 'dedicated' | 'auto';
  worktree?: Worktree;
  launch_pid?: number;
  started_at?: number;
  last_output?: string;
  session?: unknown;
}
export interface Task {
  id: string;
  subject: string;
  description: string;
  status:
    'pending' | 'planning' | 'in_progress' | 'completed' | 'failed' | 'deleted';
  owner: string | null;
  gate?: string;
  plan_mode?: boolean;
  plan_approval?: 'lead' | 'none';
  plan?: {
    version: number;
    path: string;
    verdict: 'pending' | 'approved' | 'rejected';
    feedback: string | null;
  };
  worktree?: { required?: boolean; binding?: Worktree };
  blockedBy: string[];
  blocks: string[];
  result: string | null;
  reopens: number;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  kind?: 'report' | 'advisory';
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
  async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    name(key);
    const path = join(this.root, 'locks', key);
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        mkdirSync(path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.recoverLock(path);
        if (Date.now() >= deadline)
          throw new Error(`Operation ${key} is busy; retry`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      atomic(join(path, 'owner.json'), { pid: process.pid });
      return await operation();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }
  updateTeam(update: (team: Team) => void): Team {
    return this.lock(() => {
      const config = this.config();
      update(config);
      atomic(join(this.root, 'config.json'), config);
      return config;
    });
  }
  reserveMember(member: string, details: Member): void {
    name(member);
    this.updateTeam((team) => {
      if (team.members.includes(member) && !team.details?.[member]?.ended)
        throw new Error('Member already exists');
      if (!team.members.includes(member)) team.members.push(member);
      team.details ??= {};
      team.details[member] = details;
    });
    this.event('member.starting', { member, details });
  }
  patchMember(member: string, patch: Partial<Member>): Member {
    let result!: Member;
    this.updateTeam((team) => {
      const details = team.details?.[member];
      if (!details) throw new Error('No lifecycle record for member');
      Object.assign(details, patch);
      result = details;
    });
    return result;
  }
  endMember(member: string, ended: EndState, output = ''): void {
    let changed = false;
    this.updateTeam((team) => {
      const details = team.details?.[member];
      if (!details || details.ended) return;
      details.ended = ended;
      details.state = ended;
      details.last_output = output;
      changed = true;
    });
    if (!changed) return;
    for (const task of this.tasks().filter(
      (t) =>
        t.owner === member &&
        (t.status === 'in_progress' || t.status === 'planning'),
    ))
      this.change(task.id, 'release', this.config().lead);
    this.send(
      member,
      this.config().lead,
      `${member}: ${ended}\n${output}`,
      false,
      'advisory',
    );
    this.event('member.ended', { member, ended, output });
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
  editTask(id: string, update: (task: Task) => void): Task {
    return this.lock(() => {
      const task = this.task(id);
      update(task);
      this.save(task);
      this.event('task.updated', task);
      return task;
    });
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
    expected?: Task,
  ): Task {
    return this.lock(() => {
      const task = this.task(id);
      if (expected && JSON.stringify(expected) !== JSON.stringify(task))
        throw new Error('Task changed while the hook was running; retry');
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
  send(
    from: string,
    to: string,
    body: string,
    urgent = false,
    kind?: 'report' | 'advisory',
  ): Message {
    if (!this.config().members.includes(to))
      throw new Error(`Unknown recipient: ${to}`);
    if (!body.trim()) throw new Error('Message body is required');
    const message = {
      id: randomUUID(),
      from,
      to,
      body,
      urgent,
      ...(kind ? { kind } : {}),
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
  deliveryState(): DeliveryState {
    const path = join(this.root, 'delivery.json');
    return existsSync(path)
      ? read<DeliveryState>(path)
      : { cursors: {}, reports: {} };
  }
  saveDeliveryState(state: DeliveryState): void {
    atomic(join(this.root, 'delivery.json'), state);
  }
  autoClaim(actor: string): Task | undefined {
    return this.lock(() => {
      if (
        this.tasks().some(
          (t) =>
            t.owner === actor &&
            (t.status === 'in_progress' || t.status === 'planning'),
        )
      )
        return;
      const task = this.tasks().find(
        (t) =>
          t.status === 'pending' &&
          t.owner === null &&
          t.blockedBy.every((id) => this.task(id).status === 'completed'),
      );
      if (!task) return;
      task.owner = actor;
      task.status = 'in_progress';
      this.save(task);
      this.event('task.claim', task);
      return task;
    });
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

export interface DeliveryState {
  blocked?: Record<string, boolean>;
  acknowledged?: Record<string, string[]>;
  idle_hooks?: Record<string, number>;
  cursors: Record<string, string>;
  reports: Record<string, number>;
}
