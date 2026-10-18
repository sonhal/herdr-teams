import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HerdrApiError, type AgentStatus } from '../../src/herdr/index.js';
import { HERDR_VERSION, startLiveHerdr, type LiveHerdr } from './harness.js';

// A finished turn in a pane that is not focused reports `done`; the focused
// pane reports `idle`. herdr-teams treats both as ready, and so do these tests.
const ready: AgentStatus[] = ['idle', 'done'];

// Each test checks herdr's own behaviour for a call herdr-teams makes, so a
// herdr upgrade that changes a response shows up here before it reaches a team.
describe(`herdr ${HERDR_VERSION} contract`, () => {
  let herdr: LiveHerdr;
  beforeAll(async () => {
    herdr = await startLiveHerdr();
  }, 60_000);
  afterAll(async () => {
    await herdr?.stop();
  });

  it('creates a workspace, splits a pane and closes it', async () => {
    const { client, directory } = herdr;
    const root = await client.createLocation(
      'workspace',
      'split',
      directory,
      {},
    );
    const split = await client.paneSplit({
      pane: root.pane_id,
      direction: 'right',
      focus: false,
    });
    expect(split.pane.workspace_id).toBe(root.workspace_id);
    expect(split.pane.pane_id).not.toBe(root.pane_id);

    await client.paneClose(split.pane.pane_id);
    const { panes } = (await client.command(['pane', 'list'], 'pane_list')) as {
      panes: { pane_id: string }[];
    };
    expect(panes.map((pane) => pane.pane_id)).toEqual([root.pane_id]);
  });

  it('starts a codex agent in a shell pane and reports it ready', async () => {
    const { client, directory } = herdr;
    const root = await client.createLocation(
      'workspace',
      'start',
      directory,
      {},
    );
    const started = await client.agentStart({
      name: 'alice',
      kind: 'codex',
      pane: root.pane_id,
      timeoutMs: 20_000,
    });
    expect(started.agent).toMatchObject({
      name: 'alice',
      agent: 'codex',
      pane_id: root.pane_id,
      interactive_ready: true,
    });
    expect(ready).toContain(started.agent.agent_status);
    expect(started.argv).toEqual(['codex']);

    const got = await client.agentGet(root.pane_id);
    expect(ready).toContain(got.agent.agent_status);
    const list = await client.agentList();
    expect(list.agents.map((agent) => agent.name)).toContain('alice');
  });

  it('prompts an idle agent and returns once it is ready again', async () => {
    const { client } = herdr;
    const alice = (await client.agentGet('alice')).agent;

    const prompted = await client.agentPrompt(alice.pane_id, 'ping', {
      wait: true,
      until: ready,
      timeoutMs: 15_000,
    });
    expect(ready).toContain(prompted.agent.agent_status);
    expect(await client.paneRead(alice.pane_id)).toContain('• echo: ping');
  });

  it('accepts a key press for an agent', async () => {
    await expect(
      herdr.client.sendKeys('alice', 'esc'),
    ).resolves.toBeUndefined();
  });

  it('rejects unknown targets with herdr API errors', async () => {
    const error = await herdr.client.agentGet('no-such-agent').catch((e) => e);
    expect(error).toBeInstanceOf(HerdrApiError);
    expect((error as HerdrApiError).code).toBe('agent_not_found');

    const closed = await herdr.client.paneClose('w9:p9').catch((e) => e);
    expect(closed).toBeInstanceOf(HerdrApiError);
  });
});
