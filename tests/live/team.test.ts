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
    const spawned = await cli(
      ['spawn', 'bob', '--kind', 'codex', '--prompt', 'Say hello', '--json'],
      { HERDR_TEAMS_TEAM: teamId },
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

    const output = await herdr.client.paneRead(member.pane_id, {
      source: 'recent-unwrapped',
      lines: 200,
    });
    expect(output).toContain('You are bob');
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

  it('kills a member and closes its pane', async () => {
    const killed = await cli(['kill', 'bob'], { HERDR_TEAMS_TEAM: teamId });
    expect(killed.exitCode).toBe(0);

    const after = (await herdr.client.agentList()).agents;
    expect(after.map((agent) => agent.pane_id)).not.toContain(bobPane);
  });
});
