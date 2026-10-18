import { execFile } from 'node:child_process';

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
}

export type CommandRunner = (
  binary: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandOutput>;

/** An argv-only subprocess boundary: never invoke a shell or interpolate prompts. */
export const runCommand: CommandRunner = (binary, argv, env) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...argv],
      { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number' && !error.signal) {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: error
            ? typeof error.code === 'number'
              ? error.code
              : null
            : 0,
          signal: error?.signal ?? null,
        });
      },
    );
  });
