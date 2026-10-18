import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { McpServer, serveMcp } from '../src/mcp/server.js';
const homes: string[] = [];
afterEach(() =>
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mcp-'));
  homes.push(home);
  const db = new Store(home, randomUUID());
  db.create('lead', 'demo');
  db.addMember('alice');
  db.add('Visible task');
  return {
    db,
    server: new McpServer('test', {
      HERDR_TEAMS_HOME: home,
      HERDR_TEAMS_TEAM: db.id,
      HERDR_TEAMS_AGENT: 'alice',
    }),
  };
}
it('initializes and lists callable tools without long-running commands', async () => {
  const { server } = setup();
  expect(
    await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }),
  ).toMatchObject({
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'herdr-teams' },
    },
  });
  const result = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  expect(JSON.stringify(result)).toContain('herdr_teams_task');
  expect(JSON.stringify(result)).not.toContain('herdr_teams_supervise');
});
it('returns team data and preserves privileged-action checks', async () => {
  const { server } = setup();
  const read = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'herdr_teams_status' },
  });
  expect(JSON.stringify(read)).toContain('Visible task');
  expect(read).toMatchObject({ result: { isError: false } });
  const kill = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'herdr_teams_kill', arguments: { args: ['lead'] } },
  });
  expect(kill).toMatchObject({ result: { isError: true } });
  expect(JSON.stringify(kill)).toContain('Only the lead');
});
it('validates tool arguments and keeps notifications silent', async () => {
  const { server } = setup();
  expect(
    await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  ).toBeUndefined();
  expect(
    await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'herdr_teams_task', arguments: { args: 'list' } },
    }),
  ).toMatchObject({ error: { code: -32602 } });
  expect(
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'unknown' }),
  ).toMatchObject({ error: { code: -32601 } });
});
it('frames JSON responses and recovers after malformed input', async () => {
  let output = '';
  await serveMcp(
    Readable.from([
      'invalid\n',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n',
    ]),
    (s) => {
      output += s;
    },
    'test',
    {},
  );
  const messages = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ error: { code: -32700 } });
  expect(messages[1]).toMatchObject({ id: 1, result: {} });
});
