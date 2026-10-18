import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCliAsync } from '../../src/cli/index.js';
import { Store } from '../../src/core/store.js';
import { HERDR_VERSION, startLiveHerdr, type LiveHerdr } from './harness.js';

// What the lead hears from a teammate whose turns herdr reports as completed.
// The stand-in codex never runs herdr-teams commands, so every turn it ends is
// silent; the tests run its commands for it from its pane.
describe(`lead mail on herdr ${HERDR_VERSION}`, () => {
  let herdr: LiveHerdr;
  let leadPane: string;
  let alicePane: string;
  let teamHome: string;
  let db: Store;

  async function cli(argv: string[], pane = leadPane) {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCliAsync(argv, {
      version: '0.1.0',
      env: {
        ...herdr.env,
        HERDR_TEAMS_HOME: teamHome,
        HERDR_PANE_ID: pane,
        ...(db ? { HERDR_TEAMS_TEAM: db.id } : {}),
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

  /** Successful commands reconcile, so polling one drives delivery. */
  async function until(check: () => boolean | Promise<boolean>, what: string) {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${what}`);
      expect((await cli(['task', 'list'])).exitCode).toBe(0);
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  const reports = () => db.inbox('lead').filter((m) => m.kind === 'report');

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
    const created = await cli(['team', 'create', 'demo', '--lead', 'lead']);
    expect(created.exitCode).toBe(0);
    db = new Store(teamHome, JSON.parse(created.stdout).id);
  }, 60_000);

  afterAll(async () => {
    await herdr?.stop();
  });

  it('reports the spawn turn once, without the pane', async () => {
    const spawned = await cli([
      'spawn',
      'alice',
      '--kind',
      'codex',
      '--prompt',
      'Say hello',
    ]);
    expect(spawned.stderr).toBe('');
    alicePane = JSON.parse(spawned.stdout).pane_id;
    await until(() => reports().length > 0, 'the spawn turn report');
    await until(
      () => db.deliveryState().cursors.lead !== undefined,
      'delivery to the lead',
    );
    expect(reports().map((m) => m.body)).toEqual([
      'alice stopped without messaging you.\nPeek: herdr-teams peek alice',
    ]);
  });

  it('sends an auto-claimed assignment once and reports a stop mid-task', async () => {
    // `task add` reconciles, and idle alice would claim the task unassigned.
    const { id } = db.add('Survey caches', 'Compare Redis and Memcached');
    expect((await cli(['task', 'assign', id, 'alice'])).exitCode).toBe(0);
    await until(
      () => reports().some((m) => m.body.includes('while holding')),
      'the mid-task stop report',
    );
    expect(db.task(id)).toMatchObject({
      owner: 'alice',
      status: 'in_progress',
    });
    expect(
      db
        .inbox('alice')
        .filter((m) => m.body.includes('Compare Redis and Memcached')),
    ).toHaveLength(1);
    expect(reports().at(-1)!.body).toBe(
      `alice stopped without messaging you while holding:\n#${id} in_progress: Survey caches\nPeek: herdr-teams peek alice`,
    );
    expect(reports()).toHaveLength(2);
  });

  it('delivers a completion to the lead pane with its result', async () => {
    const id = db.tasks().find((t) => t.owner === 'alice')!.id;
    const completed = await cli(
      ['task', 'complete', id, '--result', 'Redis wins'],
      alicePane,
    );
    expect(completed.stderr).toBe('');
    expect(db.inbox('lead').at(-1)).toMatchObject({
      from: 'alice',
      body: `Completed task #${id}: Survey caches\nRedis wins`,
    });
    await until(
      async () =>
        (
          await herdr.client.paneRead(leadPane, {
            source: 'recent-unwrapped',
            lines: 200,
          })
        ).includes(`Completed task #${id}: Survey caches`),
      'the completion in the lead pane',
    );
  });
});
