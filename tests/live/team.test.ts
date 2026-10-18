import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCliAsync } from '../../src/cli/index.js';
import { HERDR_VERSION, startLiveHerdr, type LiveHerdr } from './harness.js';

// Runs the herdr-teams CLI in-process, with herdr-teams' own commands driving
// a real herdr server and a stand-in codex in each pane.
describe(`team lifecycle on herdr ${HERDR_VERSION}`, () => {
  let herdr: LiveHerdr;
  let leadPane: string;
  let teamHome: string;
  let teamId: string;
  let bobPane: string;

  async function cli(argv: string[], env: NodeJS.ProcessEnv = {}) {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCliAsync(argv, {
      version: '0.1.0',
      env: {
        ...herdr.env,
        HERDR_TEAMS_HOME: teamHome,
        HERDR_PANE_ID: leadPane,
        ...env,
      },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { exitCode, stdout, stderr };
  }

  beforeAll(async () => {
    herdr = await startLiveHerdr();
    teamHome = `${herdr.directory}/state`;
    const root = await herdr.client.createLocation(
      'workspace',
      'team',
      herdr.directory,
      {},
    );
    leadPane = root.pane_id;
    await herdr.client.agentStart({
      name: 'lead',
      kind: 'codex',
      pane: leadPane,
      timeoutMs: 20_000,
    });
    const created = await cli([
      'team',
      'create',
      'demo',
      '--lead',
      'lead',
      '--json',
    ]);
    expect(created.exitCode).toBe(0);
    teamId = JSON.parse(created.stdout).id;
  }, 60_000);

  afterAll(async () => {
    await herdr?.stop();
  });

  it('spawns a member into its own pane and delivers the bootstrap', async () => {
    const roles = join(herdr.env.HOME!, '.pi', 'agent', 'agents');
    mkdirSync(roles, { recursive: true });
    writeFileSync(
      join(roles, 'custom.md'),
      '---\nkind: codex\n---\nFollow the existing custom role instructions.',
    );
    const spawned = await cli(
      ['spawn', 'bob', '--agent', 'custom', '--prompt', 'Say hello', '--json'],
      {
        HERDR_TEAMS_TEAM: teamId,
        PI_CODING_AGENT_DIR: join(herdr.env.HOME!, '.pi', 'agent'),
      },
    );
    expect(spawned.stderr).toBe('');
    expect(spawned.exitCode).toBe(0);
    const member = JSON.parse(spawned.stdout);
    expect(member.pane_id).toBeTruthy();
    expect(member.pane_id).not.toBe(leadPane);
    bobPane = member.pane_id;

    const { agents } = await herdr.client.agentList();
    const bob = agents.find((agent) => agent.pane_id === member.pane_id);
    expect(bob).toMatchObject({ agent: 'codex' });
    // Lookups use the session-unique agent name; the pane label stays the
    // member name. herdr v0.9.5 `pane get` returns the label as display_agent.
    expect(bob?.name).toMatch(/^demo-bob-[0-9a-f]{4}$/);
    const labelled = JSON.parse(
      execFileSync(herdr.env.HERDR_BIN_PATH!, ['pane', 'get', bobPane], {
        env: herdr.env,
        encoding: 'utf8',
      }),
    ).result.pane;
    expect(labelled).toMatchObject({ display_agent: 'bob' });

    const output = await herdr.client.paneRead(member.pane_id, {
      source: 'recent-unwrapped',
      lines: 200,
    });
    expect(output).toContain('You are bob');
    expect(output).toContain('Follow the existing custom role instructions.');
  });

  it('refuses a second member with the same name and starts no pane for it', async () => {
    const before = (await herdr.client.agentList()).agents.length;
    const again = await cli(
      ['spawn', 'bob', '--kind', 'codex', '--prompt', 'again'],
      { HERDR_TEAMS_TEAM: teamId },
    );
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain('Member already exists');
    expect((await herdr.client.agentList()).agents.length).toBe(before);
  });

  it('labels the lead pane with the lead’s name while a teammate runs', async () => {
    const hook = await cli(['_hook', 'event'], {
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: 'pane_agent_status_changed',
        data: { pane_id: bobPane },
      }),
    });
    expect(hook.stderr).toBe('');
    // herdr v0.9.5 `pane get` returns reported metadata as display_agent.
    const lead = JSON.parse(
      execFileSync(herdr.env.HERDR_BIN_PATH!, ['pane', 'get', leadPane], {
        env: herdr.env,
        encoding: 'utf8',
      }),
    ).result.pane;
    expect(lead).toMatchObject({
      display_agent: 'lead',
      tokens: { team: 'demo' },
    });
  });

  it('refuses a second team from a lead pane whose team is active', async () => {
    const second = await cli(['team', 'create', 'other']);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain(`already leads team demo (${teamId})`);
  });

  it('kills a member and closes its pane', async () => {
    const killed = await cli(['kill', 'bob'], { HERDR_TEAMS_TEAM: teamId });
    expect(killed.exitCode).toBe(0);

    const after = (await herdr.client.agentList()).agents;
    expect(after.map((agent) => agent.pane_id)).not.toContain(bobPane);
  });
});
