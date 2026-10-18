import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandOutput } from '../../src/herdr/index.js';

export type Reply = Partial<CommandOutput>;

/** A real subprocess test double. No herdr server, socket, or agent CLI is needed. */
export async function fakeHerdr(replies: Reply[]) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-teams-test-'));
  const binary = join(directory, 'herdr');
  const state = join(directory, 'replies.json');
  const log = join(directory, 'calls.jsonl');
  await writeFile(state, JSON.stringify(replies));
  await writeFile(log, '');
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const reply = replies.shift();
if (!reply) { process.stderr.write('No scripted reply'); process.exit(99); }
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(replies));
fs.writeFileSync(1, reply.stdout ?? '');
fs.writeFileSync(2, reply.stderr ?? '');
if (reply.signal) process.kill(process.pid, reply.signal);
else process.exitCode = reply.exitCode ?? 0;
`,
  );
  await chmod(binary, 0o755);
  return {
    binary,
    directory,
    env: { ...process.env, HERDR_BIN_PATH: binary },
    async calls(): Promise<string[][]> {
      const lines = (await readFile(log, 'utf8')).trim();
      return lines
        ? lines.split('\n').map((line) => JSON.parse(line) as string[])
        : [];
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function jsonReply(result: unknown): Reply {
  return { stdout: JSON.stringify({ id: 'fixture', result }) };
}
