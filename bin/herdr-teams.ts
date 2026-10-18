#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCli } from '../src/cli/index.js';

const metadata: unknown = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
if (
  !metadata ||
  typeof metadata !== 'object' ||
  !('version' in metadata) ||
  typeof metadata.version !== 'string'
) {
  throw new Error('package.json must contain a version');
}
process.exitCode = runCli(process.argv.slice(2), { version: metadata.version });
