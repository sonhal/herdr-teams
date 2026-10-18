import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HerdrClient, runCommand } from '../../src/herdr/index.js';

/** The herdr release these tests run against. Keep in sync with scripts/fetch-herdr.sh. */
export const HERDR_VERSION = '0.9.5';

const here = dirname(fileURLToPath(import.meta.url));
const STARTUP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

export interface LiveHerdr {
  /** herdr-teams' client, using the real herdr binary and this server. */
  client: HerdrClient;
  /** Environment for running herdr-teams commands against this server. */
  env: NodeJS.ProcessEnv;
  /** Holds the server's home, config and socket. Removed by stop(). */
  directory: string;
  stop(): Promise<void>;
}

/**
 * Starts a headless herdr server with its own home, config and socket, so
 * tests never touch the user's sessions. `codex` on PATH is the stand-in in
 * tests/live/fake-codex.
 */
export async function startLiveHerdr(): Promise<LiveHerdr> {
  const binary = await verifiedBinary();
  const directory = await mkdtemp(join(tmpdir(), 'herdr-live-'));
  const home = join(directory, 'home');
  const bin = join(directory, 'bin');
  const socket = join(directory, 'herdr.sock');
  const configPath = join(directory, 'config.toml');
  const log = join(directory, 'server.log');
  await mkdir(home);
  await mkdir(bin);
  await copyFile(join(here, 'fake-codex'), join(bin, 'codex'));
  await chmod(join(bin, 'codex'), 0o755);
  // Keep the server from contacting herdr.dev during tests.
  await writeFile(
    configPath,
    '[update]\nversion_check = false\nmanifest_check = false\n',
  );

  // Drop inherited HERDR_* variables: an agent running inside a herdr pane
  // would otherwise point these tests at its own session.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith('HERDR_')) env[key] = value;
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    SHELL: '/bin/sh',
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    HERDR_BIN_PATH: binary,
    HERDR_CONFIG_PATH: configPath,
    HERDR_SOCKET_PATH: socket,
  });

  const logFd = openSync(log, 'w');
  const server = spawn(binary, ['server'], {
    env,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  // A spawn failure surfaces as the readiness timeout below.
  server.on('error', () => undefined);

  try {
    await waitUntil(
      async () =>
        (await runCommand(binary, ['workspace', 'list'], env)).exitCode === 0,
      STARTUP_TIMEOUT_MS,
      () => `herdr server did not start:\n${tail(log)}`,
    );
  } catch (error) {
    server.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    client: new HerdrClient({ env }),
    env,
    directory,
    async stop() {
      try {
        await runCommand(binary, ['server', 'stop'], env);
        await waitUntil(
          async () => !existsSync(socket),
          STOP_TIMEOUT_MS,
          () => `herdr server still listening after stop:\n${tail(log)}`,
        );
      } finally {
        if (server.exitCode === null) server.kill('SIGKILL');
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

const run = promisify(execFile);

async function verifiedBinary(): Promise<string> {
  const configured = process.env.HERDR_BIN_PATH;
  if (!configured)
    throw new Error(
      `HERDR_BIN_PATH must name herdr ${HERDR_VERSION}; run: HERDR_BIN_PATH=$(sh scripts/fetch-herdr.sh) npm run test:live`,
    );
  const binary = resolve(configured);
  const { stdout } = await run(binary, ['--version']);
  if (stdout.trim() !== `herdr ${HERDR_VERSION}`)
    throw new Error(
      `${binary} reports "${stdout.trim()}", expected herdr ${HERDR_VERSION}`,
    );
  return binary;
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  message: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message());
    await new Promise((done) => setTimeout(done, 200));
  }
}

function tail(path: string): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '(no server log)';
  }
}
