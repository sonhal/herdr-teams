import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function pluginRoot(env: NodeJS.ProcessEnv): string {
  if (env.HERDR_PLUGIN_ROOT) return env.HERDR_PLUGIN_ROOT;
  const built = new URL('../../../package.json', import.meta.url);
  return fileURLToPath(
    new URL(
      '.',
      existsSync(built)
        ? built
        : new URL('../../package.json', import.meta.url),
    ),
  );
}
