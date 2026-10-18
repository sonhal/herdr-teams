import { connect } from 'node:net';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { reconcile } from './delivery.js';
import { checkAdvisories } from './advisories.js';
import { applyEvent } from './events.js';

export async function supervise(
  db: Store,
  client: HerdrClient,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  output: (text: string) => void,
) {
  if (!env.HERDR_SOCKET_PATH)
    throw new Error('Set HERDR_SOCKET_PATH for the supervisor');
  await db.exclusive('supervisor', async () => {
    let queue = Promise.resolve();
    const schedule = (event?: unknown, tick = false) => {
      queue = queue
        .then(async () => {
          if (signal.aborted) return;
          applyEvent(db, event);
          await reconcile(db, client);
          if (tick) await checkAdvisories(db, client);
          const members = Object.values(db.config().details ?? {});
          output(
            `supervisor · ${members.filter((m) => !m.ended).length} members · ${members.filter((m) => m.advisory).length} advisories\n`,
          );
        })
        .catch((error: unknown) => {
          output(`supervisor: ${String(error)}\n`);
        });
    };
    const seconds = db.config().supervisor?.tick_seconds ?? 30;
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error('tick_seconds must be positive');
    const clock = setInterval(() => schedule(undefined, true), seconds * 1000);
    try {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const socket = connect(env.HERDR_SOCKET_PATH!);
          let buffer = '';
          const abort = () => socket.destroy();
          signal.addEventListener('abort', abort, { once: true });
          socket.on('connect', () => {
            const panes = Object.values(db.config().details ?? {})
              .filter((m) => !m.ended && m.pane_id)
              .map((m) => m.pane_id!);
            const subscriptions: Record<string, string>[] = [
              'pane.exited',
              'pane.closed',
              'pane.moved',
              'pane.focused',
              'pane.agent_detected',
            ].map((type) => ({ type }));
            subscriptions.push(
              ...panes.map((pane_id) => ({
                type: 'pane.agent_status_changed',
                pane_id,
              })),
            );
            socket.write(
              JSON.stringify({
                id: 'herdr-teams-supervisor',
                method: 'events.subscribe',
                params: { subscriptions },
              }) + '\n',
            );
            queue = queue
              .then(async () => {
                await client.command(
                  ['session', 'snapshot'],
                  'session_snapshot',
                );
              })
              .catch(() => {});
            schedule(undefined, true);
          });
          socket.setEncoding('utf8');
          socket.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 8 * 1024 * 1024) {
              socket.destroy();
              return;
            }
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              try {
                const event = JSON.parse(line) as { error?: { code?: string } };
                if (event.error) {
                  socket.destroy();
                  return;
                }
                schedule(event);
              } catch {
                socket.destroy();
                return;
              }
            }
          });
          socket.on('error', () => socket.destroy());
          socket.on('close', () => {
            signal.removeEventListener('abort', abort);
            resolve();
          });
        });
        if (!signal.aborted)
          await new Promise<void>((resolve) => {
            const abort = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', abort);
              resolve();
            }, 1000);
            signal.addEventListener('abort', abort, { once: true });
          });
      }
    } finally {
      clearInterval(clock);
      await queue;
    }
  });
}

export async function ensureSupervisor(db: Store, client: HerdrClient) {
  const team = db.config();
  if (team.supervisor?.mode === 'off') return;
  await db.exclusive('supervisor-open', async () => {
    const existing = db.config().supervisor;
    if (existing?.pane_id) {
      try {
        await client.command(['pane', 'get', existing.pane_id]);
        return;
      } catch {
        /* Reopen after a restart. */
      }
    }
    const result = await client.command(
      [
        'plugin',
        'pane',
        'open',
        '--plugin',
        'herdr-teams',
        '--entrypoint',
        'supervisor',
        '--placement',
        existing?.mode === 'tab' ? 'tab' : 'split',
        '--no-focus',
        '--env',
        `HERDR_TEAMS_HOME=${db.home}`,
        '--env',
        `HERDR_TEAMS_TEAM=${db.team}`,
      ],
      'plugin_pane_opened',
    );
    const pane = result.plugin_pane as { pane_id?: unknown } | undefined;
    if (typeof pane?.pane_id !== 'string')
      throw new Error('Invalid supervisor pane response');
    db.updateTeam((config) => {
      config.supervisor = {
        ...config.supervisor,
        mode: config.supervisor?.mode ?? 'pane',
        pane_id: pane.pane_id as string,
      };
    });
  });
}
