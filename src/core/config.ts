import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { adapter } from '../adapters/index.js';
import { Store, type Team } from './store.js';
import { Lifecycle, type SpawnOptions } from './lifecycle.js';
import { Tasks } from './tasks.js';
import { pluginRoot } from './paths.js';

export interface Definition {
  name?: string;
  description?: string;
  kind?: string;
  model?: string;
  thinking?: string;
  plan_mode?: boolean;
  plan_approval?: 'lead' | 'none';
  worktree?: 'shared' | 'dedicated' | 'auto';
  auto_claim?: boolean;
  interactive?: boolean;
  instructions?: string;
}
export interface Template {
  description?: string;
  lead?: Definition;
  defaults?: Definition;
  plan_approval?: 'lead' | 'none';
  worktree_requests?: 'lead' | 'auto';
  hooks?: Team['hooks'];
  supervisor?: Team['supervisor'];
  members: (Definition & { name: string; agent?: string; prompt?: string })[];
  tasks?: {
    subject: string;
    description?: string;
    owner?: string;
    gate?: string;
    plan_mode?: boolean;
    worktree?: boolean;
  }[];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected ${label} mapping`);
  return value as Record<string, unknown>;
}
function key(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value))
    throw new Error(`Invalid configuration name: ${value}`);
  return value;
}
function mapping(path: string): Record<string, unknown> {
  return existsSync(path)
    ? object(
        parse(readFileSync(path, 'utf8'), { maxAliasCount: 20 }) as unknown,
        path,
      )
    : {};
}
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export type TemplateSource = 'project' | 'global' | 'built-in';
export class Config {
  readonly global: string;
  /** Templates and roles shipped with the plugin; anything else overrides them. */
  readonly builtin: string;
  constructor(
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.global = join(
      env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'herdr-teams',
    );
    this.builtin = join(pluginRoot(env), 'templates');
  }
  /** Lowest precedence first. */
  private sources(): [TemplateSource, Record<string, unknown>][] {
    return [
      ['built-in', mapping(join(this.builtin, 'teams.yaml'))],
      ['global', mapping(join(this.global, 'teams.yaml'))],
      ['project', mapping(join(this.cwd, '.herdr', 'teams.yaml'))],
    ];
  }
  definition(name: string): Definition {
    key(name);
    const roots = [
      join(this.cwd, '.herdr', 'agents'),
      join(this.cwd, '.pi', 'agents'),
      join(this.cwd, '.claude', 'agents'),
      join(this.global, 'agents'),
      join(this.builtin, 'agents'),
    ];
    const path = roots.map((root) => join(root, `${name}.md`)).find(existsSync);
    if (!path) throw new Error(`Agent definition not found: ${name}`);
    const text = readFileSync(path, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
    const data = match
      ? object(
          parse(match[1]!, { maxAliasCount: 20 }) as unknown,
          'frontmatter',
        )
      : {};
    const known = [
      'name',
      'description',
      'kind',
      'model',
      'thinking',
      'plan_mode',
      'plan_approval',
      'worktree',
      'auto_claim',
      'interactive',
    ];
    const result = Object.fromEntries(
      Object.entries(data).filter(([name]) => known.includes(name)),
    ) as Definition;
    result.instructions = match ? match[2]!.trim() : text.trim();
    this.validateDefinition(result);
    return result;
  }
  validateDefinition(value: Definition): void {
    for (const field of [
      'name',
      'description',
      'model',
      'thinking',
      'kind',
      'instructions',
    ] as const)
      if (value[field] !== undefined && typeof value[field] !== 'string')
        throw new Error(`Invalid ${field}`);
    for (const field of ['plan_mode', 'auto_claim', 'interactive'] as const)
      if (value[field] !== undefined && typeof value[field] !== 'boolean')
        throw new Error(`Invalid ${field}`);
    if (
      value.worktree &&
      !['shared', 'dedicated', 'auto'].includes(value.worktree)
    )
      throw new Error('Invalid worktree mode');
    if (value.plan_approval && !['lead', 'none'].includes(value.plan_approval))
      throw new Error('Invalid plan approval');
    // Without a kind, model and thinking are checked when the kind is known at spawn.
    if (value.kind !== undefined)
      adapter(value.kind, value.model, value.thinking);
  }
  templates(): string[] {
    return [
      ...new Set(this.sources().flatMap(([, values]) => Object.keys(values))),
    ].sort();
  }
  /** Each template with the source that wins for it. */
  catalog(): { name: string; source: TemplateSource; description?: string }[] {
    const sources = new Map<string, TemplateSource>();
    for (const [source, values] of this.sources())
      for (const name of Object.keys(values)) sources.set(name, source);
    return [...sources.keys()].sort().map((name) => {
      const { description } = this.template(name);
      return {
        name,
        source: sources.get(name)!,
        ...(description ? { description } : {}),
      };
    });
  }
  template(name: string): Template {
    key(name);
    const values = Object.assign(
      {},
      ...this.sources().map(([, values]) => values),
    ) as Record<string, unknown>;
    const raw = Object.hasOwn(values, name) ? values[name] : undefined;
    if (raw === undefined) throw new Error(`Unknown template: ${name}`);
    const value = Array.isArray(raw)
      ? {
          members: raw.map((agent: unknown) => {
            if (typeof agent !== 'string')
              throw new Error('Short-form members must be agent names');
            return { name: agent, agent };
          }),
        }
      : object(raw, 'template');
    if (!Array.isArray(value.members))
      throw new Error('Template members must be a list');
    const template = value as unknown as Template;
    const names = new Set<string>();
    for (const member of template.members) {
      object(member, 'member');
      key(member.name);
      if (names.has(member.name)) throw new Error('Duplicate member');
      names.add(member.name);
      if (member.agent !== undefined) {
        if (typeof member.agent !== 'string')
          throw new Error('Invalid agent definition name');
        this.definition(member.agent);
      }
      this.validateDefinition(member);
      if (member.prompt !== undefined && typeof member.prompt !== 'string')
        throw new Error('Invalid member prompt');
    }
    if (template.defaults !== undefined) {
      object(template.defaults, 'defaults');
      this.validateDefinition(template.defaults);
    }
    if (template.lead !== undefined) {
      object(template.lead, 'lead');
      this.validateDefinition(template.lead);
    }
    if (
      template.plan_approval &&
      !['lead', 'none'].includes(template.plan_approval)
    )
      throw new Error('Invalid plan approval');
    if (
      template.worktree_requests &&
      !['lead', 'auto'].includes(template.worktree_requests)
    )
      throw new Error('Invalid worktree request policy');
    if (template.supervisor !== undefined) {
      object(template.supervisor, 'supervisor');
      if (!['off', 'pane', 'tab'].includes(template.supervisor.mode))
        throw new Error('Invalid supervisor mode');
      for (const name of [
        'tick_seconds',
        'no_progress_minutes',
        'needs_input_minutes',
        'unknown_minutes',
      ] as const) {
        const n = template.supervisor[name];
        if (
          n !== undefined &&
          (!Number.isFinite(n) || n < 0 || (name === 'tick_seconds' && n === 0))
        )
          throw new Error(`Invalid ${name}`);
      }
    }
    if (template.hooks !== undefined) {
      object(template.hooks, 'hooks');
      const { failure_action, max_reopens, followup_owner, timeout_seconds } =
        template.hooks;
      if (
        failure_action &&
        !['warn', 'reopen', 'followup', 'reopen_followup'].includes(
          failure_action,
        )
      )
        throw new Error('Invalid hook failure action');
      if (
        max_reopens !== undefined &&
        (!Number.isSafeInteger(max_reopens) || max_reopens < 0)
      )
        throw new Error('Invalid max_reopens');
      if (
        followup_owner &&
        !['member', 'lead', 'none'].includes(followup_owner)
      )
        throw new Error('Invalid followup owner');
      if (
        timeout_seconds !== undefined &&
        (!Number.isFinite(timeout_seconds) || timeout_seconds <= 0)
      )
        throw new Error('Invalid hook timeout');
    }
    if (template.tasks !== undefined && !Array.isArray(template.tasks))
      throw new Error('Seed tasks must be a list');
    for (const task of template.tasks ?? []) {
      if (typeof task.subject !== 'string' || !task.subject.trim())
        throw new Error('Invalid seed task subject');
      if (task.owner && task.owner !== '$lead' && !names.has(task.owner))
        throw new Error('Unknown seed task owner');
    }
    return template;
  }
  resolve(
    member: Template['members'][number],
    defaults: Definition = {},
  ): Definition {
    return {
      ...defaults,
      ...(member.agent ? this.definition(member.agent) : {}),
      ...member,
    };
  }
  async start(
    db: Store,
    lifecycle: Lifecycle,
    name: string,
    lead: string,
    kind?: string,
  ) {
    const template = this.template(name);
    key(lead);
    if (template.members.some((m) => m.name === lead))
      throw new Error('Lead and teammate names must differ');
    const defaults = { ...template.lead, ...template.defaults };
    if (kind !== undefined) defaults.kind = kind;
    // Resolve a missing kind before creating anything, so a failure leaves no team.
    if (
      defaults.kind === undefined &&
      template.members.some((m) => this.resolve(m).kind === undefined)
    )
      defaults.kind = await lifecycle.currentKind();
    if (defaults.kind !== undefined) adapter(defaults.kind);
    db.create(lead);
    db.bindSession(this.env.HERDR_SOCKET_PATH);
    db.updateTeam((team) => {
      team.repository_dir = this.cwd;
      team.defaults = defaults;
      if (template.defaults?.auto_claim !== undefined)
        team.auto_claim = template.defaults.auto_claim;
      if (template.plan_approval) team.plan_approval = template.plan_approval;
      if (template.worktree_requests)
        team.worktree_requests = template.worktree_requests;
      if (template.hooks) team.hooks = template.hooks;
      team.supervisor = template.supervisor ?? { mode: 'pane' };
      if (this.env.HERDR_PANE_ID) team.lead_pane_id = this.env.HERDR_PANE_ID;
      if (this.env.HERDR_WORKSPACE_ID)
        team.workspace_id = this.env.HERDR_WORKSPACE_ID;
    });
    for (const member of template.members) {
      const settings = this.resolve(member, defaults);
      const options: SpawnOptions = {
        prompt:
          member.prompt ??
          settings.description ??
          `Work as ${member.name}. Check the task board.`,
        ...settings,
        planMode: settings.plan_mode ?? false,
        cwd: this.cwd,
        ...(member.agent ? { definition: member.agent } : {}),
      };
      await lifecycle.spawn(member.name, options);
    }
    const tasks = new Tasks(db, this.env);
    for (const seed of template.tasks ?? []) {
      const task = await tasks.add(lead, seed.subject, {
        ...seed,
        planMode: seed.plan_mode ?? false,
      });
      if (seed.owner)
        db.change(
          task.id,
          'assign',
          lead,
          seed.owner === '$lead' ? lead : seed.owner,
        );
    }
    return db.config();
  }
  save(db: Store, name: string, scope: string) {
    key(name);
    if (!['project', 'global'].includes(scope))
      throw new Error('Scope must be project or global');
    const root = scope === 'project' ? join(this.cwd, '.herdr') : this.global;
    const path = join(root, 'teams.yaml');
    const values = mapping(path);
    const team = db.config();
    const members: Template['members'] = [];
    for (const [member, details] of Object.entries(team.details ?? {})) {
      const defName = `${name.slice(0, 10)}-${member.slice(0, 15)}-${createHash(
        'sha256',
      )
        .update(name + ':' + member)
        .digest('hex')
        .slice(0, 4)}`;
      const definition: Definition = {
        kind: details.kind,
        ...(details.model ? { model: details.model } : {}),
        ...(details.thinking ? { thinking: details.thinking } : {}),
        plan_mode: details.plan_mode ?? false,
        worktree: details.worktree_mode ?? 'shared',
        auto_claim: details.auto_claim ?? team.auto_claim ?? true,
        interactive: details.interactive ?? false,
        plan_approval: details.plan_approval ?? team.plan_approval ?? 'lead',
      };
      const body = details.instructions ?? '';
      write(
        join(root, 'agents', `${defName}.md`),
        `---\n${stringify({ name: defName, ...definition })}---\n${body}\n`,
      );
      members.push({
        name: member,
        agent: defName,
        ...(details.prompt ? { prompt: details.prompt } : {}),
      });
    }
    const supervisor = {
      ...team.supervisor,
      mode: team.supervisor?.mode ?? 'pane',
    };
    delete supervisor.pane_id;
    values[name] = {
      defaults: {
        ...team.defaults,
        auto_claim: team.auto_claim ?? team.defaults?.auto_claim ?? true,
      },
      plan_approval: team.plan_approval ?? 'lead',
      worktree_requests: team.worktree_requests ?? 'lead',
      hooks: team.hooks,
      supervisor,
      members,
      tasks: db
        .tasks()
        .filter((t) => t.status !== 'deleted')
        .map((t) => ({
          subject: t.subject,
          description: t.description,
          ...(t.owner
            ? { owner: t.owner === team.lead ? '$lead' : t.owner }
            : {}),
          ...(t.gate ? { gate: t.gate } : {}),
          plan_mode: t.plan_mode ?? false,
          worktree: t.worktree?.required ?? false,
        })),
    };
    write(path, stringify(values));
    return { path, template: name };
  }
}
