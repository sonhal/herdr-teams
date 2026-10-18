import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const MARKER = '// herdr-teams launcher';

/**
 * herdr installs each plugin version in a new directory and deletes old ones,
 * so the launcher asks herdr for the current plugin root on every run instead
 * of linking to one version. `plugin list --plugin <id> --json` prints the raw
 * plugin_list response and answers without a running server (herdr 0.9.5,
 * src/cli/plugin.rs).
 */
export const LAUNCHER = `#!/usr/bin/env node
${MARKER}: runs the herdr-teams version herdr has installed now.
'use strict';
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
let root;
try {
  const output = execFileSync(
    process.env.HERDR_BIN_PATH || 'herdr',
    ['plugin', 'list', '--plugin', 'herdr-teams', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const plugins = JSON.parse(output).result.plugins;
  root = plugins.find((p) => p.plugin_id === 'herdr-teams')?.plugin_root;
} catch (error) {
  console.error('herdr-teams: could not ask herdr for the plugin: ' + error.message);
  process.exit(1);
}
if (!root) {
  console.error('herdr-teams: the plugin is not installed in herdr');
  process.exit(1);
}
import(pathToFileURL(join(root, 'dist', 'bin', 'herdr-teams.js')).href);
`;

/** Replaces only its own launcher or an older herdr-teams link. */
function ours(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    return readlinkSync(path).endsWith(join('bin', 'herdr-teams'));
  return stat.isFile() && readFileSync(path, 'utf8').includes(MARKER);
}

export function installShim(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'herdr-teams');
  let exists = true;
  try {
    if (!ours(target))
      throw new Error(
        `${target} already exists; remove it or pick --directory`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  // Replacing a link must not write through it into the plugin directory.
  if (exists) rmSync(target);
  writeFileSync(target, LAUNCHER, { mode: 0o755 });
  chmodSync(target, 0o755);
  return target;
}
