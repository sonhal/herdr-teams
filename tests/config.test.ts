import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Store, newAgentName } from '../src/core/store.js';
import { HerdrClient } from '../src/herdr/index.js';
import { agent, pane } from './helpers/fixtures.js';
import { fakeHerdr, jsonReply } from './helpers/fake-herdr.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'templates-'));
  homes.push(home);
  mkdirSync(join(home, '.herdr', 'agents'), { recursive: true });
  const env = {
    ...process.env,
    HERDR_PANE_ID: undefined,
    HERDR_WORKSPACE_ID: undefined,
    HOME: join(home, 'user'),
    PI_CODING_AGENT_DIR: join(home, 'pi-config'),
    CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
    XDG_CONFIG_HOME: join(home, 'global'),
  };
  return { home, env, config: new Config(home, env) };
}
it('resolves project definitions before compatibility and global definitions', () => {
  const { home, env, config } = setup();
  mkdirSync(join(env.XDG_CONFIG_HOME, 'herdr-teams', 'agents'), {
    recursive: true,
  });
  writeFileSync(
    join(env.XDG_CONFIG_HOME, 'herdr-teams', 'agents', 'reviewer.md'),
    '---\nkind: codex\nmodel: global\n---\nGlobal role',
  );
  writeFileSync(
    join(home, '.herdr', 'agents', 'reviewer.md'),
    '---\nkind: codex\nmodel: project\nunknown_key: ignored\n---\nReview the diff',
  );
  writeFileSync(join(home, '.herdr', 'teams.yaml'), 'review:\n  - reviewer\n');
  const template = config.template('review');
  const resolved = config.resolve(
    { ...template.members[0]!, model: 'member' },
    { model: 'default' },
  );
  expect(resolved).toMatchObject({
    model: 'member',
    instructions: 'Review the diff',
  });
  expect(config.definition('reviewer')).not.toHaveProperty('unknown_key');
});
it('saves and restarts a team with equivalent roles, defaults and seed tasks', async () => {
  const { home, env, config } = setup();
  const original = new Store(join(home, 'state'), randomUUID());
  original.create('lead', 'original');
  original.reserveMember('alice', {
    kind: 'codex',
    state: 'idle',
    model: 'test-model',
    thinking: 'high',
    instructions: 'Review carefully',
    prompt: 'Find defects',
    auto_claim: false,
    plan_mode: true,
  });
  original.updateTeam((t) => {
    t.defaults = { kind: 'codex', thinking: 'medium' };
    t.plan_approval = 'none';
  });
  const task = original.add('Seed work', 'Description');
  original.change(task.id, 'assign', 'lead', 'alice');
  config.save(original, 'saved', 'project');
  const restored = new Store(join(home, 'state'), randomUUID());
  const fake = await fakeHerdr([
    jsonReply({ type: 'tab_created', root_pane: pane }),
    jsonReply({ type: 'agent_started', agent, argv: ['codex'] }),
    jsonReply({ type: 'pane_info', pane }),
    jsonReply({ type: 'agent_prompted', agent }),
    jsonReply({
      type: 'agent_info',
      agent: { ...agent, name: newAgentName('saved', 'alice', restored.id) },
    }),
  ]);
  try {
    await config.start(
      restored,
      new Lifecycle(restored, new HerdrClient({ env: fake.env }), env),
      'saved',
      'lead',
    );
    expect(restored.config().details!.alice).toMatchObject({
      kind: 'codex',
      model: 'test-model',
      thinking: 'high',
      instructions: 'Review carefully',
      prompt: 'Find defects',
      auto_claim: false,
      plan_mode: true,
    });
    expect(restored.tasks()[0]).toMatchObject({
      subject: 'Seed work',
      description: 'Description',
      owner: 'alice',
      status: 'pending',
    });
    expect((await fake.calls())[3]![3]).toContain('then continue');
    expect(
      readFileSync(join(home, '.herdr', 'teams.yaml'), 'utf8'),
    ).not.toContain('pane_id');
  } finally {
    await fake.cleanup();
  }
});
it('rejects invalid settings before creating a team or invoking herdr', async () => {
  const { home, env, config } = setup();
  writeFileSync(
    join(home, '.herdr', 'teams.yaml'),
    'bad:\n  supervisor: {mode: pane, tick_seconds: 0}\n  members: [{name: alice, kind: codex}]\n',
  );
  const db = new Store(join(home, 'state'), randomUUID());
  const fake = await fakeHerdr([]);
  try {
    await expect(
      config.start(
        db,
        new Lifecycle(db, new HerdrClient({ env: fake.env }), env),
        'bad',
        'lead',
      ),
    ).rejects.toThrow('supervisor setting was removed');
    expect(Store.teams(db.home)).toHaveLength(0);
    expect(await fake.calls()).toHaveLength(0);
  } finally {
    await fake.cleanup();
  }
});
it('built-in roles use only worktree modes that exist', () => {
  const { config } = setup();
  for (const role of ['developer', 'tester', 'researcher', 'synthesizer']) {
    const definition = config.definition(role);
    expect(definition.worktree ?? 'shared').toBe('shared');
    expect(definition.instructions).not.toContain('your worktree');
  }
  expect(() =>
    config.validateDefinition({ worktree: 'auto' as 'shared' }),
  ).toThrow('worktree');
});

it.each([
  ['worktree_requests: auto', 'worktree_requests'],
  ['hooks: { failure_action: reopen }', 'hooks.failure_action'],
  ['hooks: { max_reopens: 2 }', 'hooks.max_reopens'],
  ['hooks: { followup_owner: lead }', 'hooks.followup_owner'],
  ['tasks: [{ subject: build, worktree: true }]', 'worktree'],
])('rejects the removed template setting %s', (setting, name) => {
  const { home, config } = setup();
  writeFileSync(
    join(home, '.herdr', 'teams.yaml'),
    `old:\n  members: [{ name: alice, kind: codex }]\n  ${setting}\n`,
  );
  expect(() => config.template('old')).toThrow(name);
});

it('resolves compatibility roles in project, global and built-in precedence order', () => {
  const { home, env, config } = setup();
  const roots = [
    join(home, '.herdr', 'agents'),
    join(home, '.pi', 'agents'),
    join(home, '.claude', 'agents'),
    join(config.global, 'agents'),
    join(env.PI_CODING_AGENT_DIR, 'agents'),
    join(env.CLAUDE_CONFIG_DIR, 'agents'),
  ];
  for (const [index, root] of roots.entries()) {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'reviewer.md'),
      `---\nmodel: source-${index}\n---\nRole ${index}`,
    );
  }
  for (const [index, root] of roots.entries()) {
    expect(config.definition('reviewer')).toMatchObject({
      model: `source-${index}`,
      instructions: `Role ${index}`,
    });
    rmSync(join(root, 'reviewer.md'));
  }
  expect(config.definition('reviewer').instructions).toBeTruthy();
});

it.each(['.pi', '.claude'])(
  'starts a team using an existing %s role',
  async (folder) => {
    const { home, env, config } = setup();
    mkdirSync(join(home, folder, 'agents'), { recursive: true });
    writeFileSync(
      join(home, folder, 'agents', 'custom.md'),
      '---\nname: custom\ndescription: Review changes\nmodel: test-model\ntools: Read, Bash\n---\nPreserve these role instructions.',
    );
    writeFileSync(
      join(home, '.herdr', 'teams.yaml'),
      'compat:\n  defaults: {kind: codex}\n  members: [{name: alice, agent: custom}]\n',
    );
    const db = new Store(join(home, 'state'), randomUUID());
    const fake = await fakeHerdr([
      jsonReply({ type: 'tab_created', root_pane: pane }),
      jsonReply({ type: 'agent_started', agent, argv: ['codex'] }),
      jsonReply({ type: 'pane_info', pane }),
      jsonReply({ type: 'agent_prompted', agent }),
      jsonReply({
        type: 'agent_info',
        agent: { ...agent, name: newAgentName('compat', 'alice', db.id) },
      }),
    ]);
    try {
      await config.start(
        db,
        new Lifecycle(db, new HerdrClient({ env: fake.env }), env),
        'compat',
        'lead',
      );
      expect(db.config().details!.alice).toMatchObject({
        kind: 'codex',
        model: 'test-model',
        instructions: 'Preserve these role instructions.',
      });
      expect((await fake.calls())[3]![3]).toContain(
        'Preserve these role instructions.',
      );
    } finally {
      await fake.cleanup();
    }
  },
);

it('uses standard user directories when compatibility overrides are absent', () => {
  const { home, env } = setup();
  delete (env as Partial<typeof env>).PI_CODING_AGENT_DIR;
  delete (env as Partial<typeof env>).CLAUDE_CONFIG_DIR;
  const config = new Config(home, env);
  for (const [name, root] of [
    ['pi-role', join(env.HOME, '.pi', 'agent', 'agents')],
    ['claude-role', join(env.HOME, '.claude', 'agents')],
  ]) {
    mkdirSync(root!, { recursive: true });
    writeFileSync(join(root!, `${name}.md`), 'User role');
    expect(config.definition(name!).instructions).toBe('User role');
  }
});
