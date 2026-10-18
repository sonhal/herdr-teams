import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HerdrApiError,
  HerdrClient,
  HerdrProcessError,
  HerdrProtocolError,
  HerdrUsageError,
} from '../src/herdr/index.js';
import { fakeHerdr, jsonReply, type Reply } from './helpers/fake-herdr.js';
import { agent, pane } from './helpers/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup(replies: Reply[]) {
  const fake = await fakeHerdr(replies);
  cleanups.push(fake.cleanup);
  return { fake, client: new HerdrClient({ env: fake.env }) };
}

describe('herdr CLI contract', () => {
  it('accepts the empty success output of quiet commands and still raises errors', async () => {
    // herdr v0.9.5 src/cli.rs send_ok_request: nothing on success; the error
    // envelope on stderr with exit 1 otherwise.
    const { client } = await setup([
      { stdout: '' },
      {
        exitCode: 1,
        stderr: JSON.stringify({
          id: 'cli:request',
          error: { code: 'pane_not_found', message: 'pane not found' },
        }),
      },
    ]);
    const argv = [
      'pane',
      'report-metadata',
      'w1:p2',
      '--source',
      'herdr-teams',
    ];
    await expect(client.quiet(argv)).resolves.toBeUndefined();
    await expect(client.quiet(argv)).rejects.toBeInstanceOf(HerdrApiError);
  });
  it('refuses an argument Linux would reject with E2BIG', async () => {
    const { fake, client } = await setup([]);
    await expect(
      client.agentPrompt('w1:p2', 'x'.repeat(128 * 1024)),
    ).rejects.toThrow(/argument/);
    expect(await fake.calls()).toEqual([]);
  });
  it('splits without focus and preserves cwd and env values as single arguments', async () => {
    const { fake, client } = await setup([
      jsonReply({ type: 'pane_info', pane }),
    ]);
    expect(
      await client.paneSplit({
        pane: 'w1:p1',
        direction: 'right',
        ratio: 0.5,
        cwd: '/a path',
        env: { HERDR_TEAMS_TEAM: 'auth', EXTRA: 'a=b c' },
      }),
    ).toEqual({ type: 'pane_info', pane });
    expect(await fake.calls()).toEqual([
      [
        'pane',
        'split',
        '--pane',
        'w1:p1',
        '--direction',
        'right',
        '--ratio',
        '0.5',
        '--cwd',
        '/a path',
        '--env',
        'HERDR_TEAMS_TEAM=auth',
        '--env',
        'EXTRA=a=b c',
        '--no-focus',
      ],
    ]);
  });

  it('allows herdr to resolve the source pane and supports explicit focus', async () => {
    const { fake, client } = await setup([
      jsonReply({ type: 'pane_info', pane }),
    ]);
    await client.paneSplit({ direction: 'down', focus: true });
    expect(await fake.calls()).toEqual([
      ['pane', 'split', '--direction', 'down', '--focus'],
    ]);
  });

  it('returns pane read text verbatim, including JSON-looking text and newlines', async () => {
    const text = '{"output":"not a response envelope"}\nλ\n';
    const { fake, client } = await setup([{ stdout: text }]);
    expect(
      await client.paneRead('w1:p2', {
        source: 'recent-unwrapped',
        lines: 40,
        format: 'text',
      }),
    ).toBe(text);
    expect(await fake.calls()).toEqual([
      [
        'pane',
        'read',
        'w1:p2',
        '--source',
        'recent-unwrapped',
        '--lines',
        '40',
        '--format',
        'text',
      ],
    ]);
  });

  it('starts agents with adapter flags after -- and preserves the launch result', async () => {
    const result = {
      type: 'agent_started',
      agent,
      argv: ['codex', '-m', 'model'],
    };
    const { fake, client } = await setup([jsonReply(result)]);
    expect(
      await client.agentStart({
        name: 'alice',
        kind: 'codex',
        pane: 'w1:p2',
        timeoutMs: 45000,
        args: ['-m', 'model'],
      }),
    ).toEqual(result);
    expect(await fake.calls()).toEqual([
      [
        'agent',
        'start',
        'alice',
        '--kind',
        'codex',
        '--pane',
        'w1:p2',
        '--timeout',
        '45000',
        '--',
        '-m',
        'model',
      ],
    ]);
  });

  it('passes prompts literally immediately after the target (herdr v0.9.5)', async () => {
    const { fake, client } = await setup([
      jsonReply({ type: 'agent_prompted', agent }),
    ]);
    const sentinel = join(fake.directory, 'must-not-exist');
    const text = `--help $(touch ${sentinel}) \`touch ${sentinel}\` "quoted"\nsecond line`;
    expect(
      (
        await client.agentPrompt('alice', text, {
          wait: true,
          until: ['idle', 'done'],
          timeoutMs: 10000,
        })
      ).agent,
    ).toEqual(agent);
    expect(await fake.calls()).toEqual([
      [
        'agent',
        'prompt',
        'alice',
        text,
        '--wait',
        '--until',
        'idle',
        '--until',
        'done',
        '--timeout',
        '10000',
      ],
    ]);
    await expect(access(sentinel)).rejects.toThrow();
  });

  it('gets and lists agents using upstream result tags and optional session fields', async () => {
    const { fake, client } = await setup([
      jsonReply({ type: 'agent_info', agent }),
      jsonReply({ type: 'agent_list', agents: [agent] }),
      jsonReply({ type: 'agent_list', agents: [] }),
    ]);
    expect((await client.agentGet('alice')).agent.agent_session?.value).toBe(
      'session-1',
    );
    expect((await client.agentList()).agents).toEqual([agent]);
    expect((await client.agentList()).agents).toEqual([]);
    expect(await fake.calls()).toEqual([
      ['agent', 'get', 'alice'],
      ['agent', 'list'],
      ['agent', 'list'],
    ]);
  });

  it('falls back to herdr on PATH when HERDR_BIN_PATH is absent', async () => {
    const { fake } = await setup([
      jsonReply({ type: 'agent_list', agents: [] }),
    ]);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fake.directory}${delimiter}${process.env.PATH ?? ''}`,
    };
    delete env.HERDR_BIN_PATH;
    const client = new HerdrClient({ env });
    expect(client.binary).toBe('herdr');
    expect((await client.agentList()).agents).toEqual([]);
    expect(await fake.calls()).toEqual([['agent', 'list']]);
  });

  it('retains herdr API error code, message, request id, and exit status', async () => {
    const { client, fake } = await setup([
      {
        exitCode: 1,
        stderr: JSON.stringify({
          id: 'cli:agent:prompt',
          error: {
            code: 'agent_blocked',
            message: 'Agent is waiting for input',
          },
        }),
      },
    ]);
    const error = await client
      .agentPrompt('alice', 'hello')
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HerdrApiError);
    expect(error).toMatchObject({
      code: 'agent_blocked',
      message: 'Agent is waiting for input',
      requestId: 'cli:agent:prompt',
      exitCode: 1,
    });
    // Never retry a possibly submitted prompt automatically (PLAN §18.3).
    expect(await fake.calls()).toHaveLength(1);
  });

  it('maps plain stderr on exit 2 to a usage error', async () => {
    const { client } = await setup([
      { exitCode: 2, stderr: 'error: invalid value for --kind\n' },
    ]);
    await expect(
      client.agentStart({ name: 'alice', kind: 'bad', pane: 'w1:p2' }),
    ).rejects.toMatchObject({
      name: 'HerdrUsageError',
      exitCode: 2,
      stderr: 'error: invalid value for --kind\n',
    });
    expect(new HerdrUsageError('bad')).toBeInstanceOf(Error);
  });

  it.each([
    { stdout: 'not json' },
    { stdout: JSON.stringify({ result: { type: 'agent_list', agents: [] } }) },
    jsonReply({ type: 'pane_info', pane }),
    jsonReply({ type: 'agent_list', agents: [{}] }),
    jsonReply({ type: 'agent_list', agents: null }),
    { exitCode: 1, stderr: 'bad error json' },
    { exitCode: 1, stderr: JSON.stringify({ id: 'x', error: {} }) },
  ])('rejects malformed or mismatched protocol replies: %j', async (reply) => {
    const { client } = await setup([reply]);
    await expect(client.agentList()).rejects.toBeInstanceOf(HerdrProtocolError);
  });

  it('reports unexpected nonzero exits as process errors', async () => {
    const { client } = await setup([
      { exitCode: 42, stderr: 'unexpected failure' },
    ]);
    await expect(client.agentList()).rejects.toMatchObject({
      name: 'HerdrProcessError',
      exitCode: 42,
      message: 'unexpected failure',
    });
  });

  it('reports signals separately from API failures', async () => {
    const { client } = await setup([{ signal: 'SIGTERM' }]);
    await expect(client.agentList()).rejects.toMatchObject({
      name: 'HerdrProcessError',
      exitCode: null,
      message: 'herdr terminated by SIGTERM',
    });
  });

  it('reports a missing binary with its underlying cause', async () => {
    const client = new HerdrClient({
      env: { HERDR_BIN_PATH: '/nonexistent/herdr-teams-test-binary' },
    });
    const error = await client.agentList().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HerdrProcessError);
    expect(error).toMatchObject({ cause: { code: 'ENOENT' } });
  });
});
