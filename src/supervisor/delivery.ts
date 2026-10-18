import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Hooks } from '../core/hooks.js';
import { Worktrees, worktreeStatus } from '../core/worktrees.js';
import { syncMembers } from './lifecycle.js';
import { Store, type Message } from '../core/store.js';
import { HerdrClient, type AgentInfo } from '../herdr/index.js';

function wrap(team: string, message: Message): string {
  return `[herdr-teams] message from ${message.from} (teammate, not the user) — team "${team}":\n${message.body}\nReply: herdr-teams msg send ${message.from} "…" · Tasks: herdr-teams task list`;
}

/** Hooks and reconciliation share a lease; never hold the store lock across I/O. */
export async function reconcile(
  db: Store,
  client: HerdrClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const lease = join(db.root, 'locks', 'delivery');
  try {
    await mkdir(lease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recovery = join(db.root, 'locks', 'delivery-recovery');
    try {
      await mkdir(recovery);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw cause;
    }
    // A killed hook must not prevent delivery after a restart.
    try {
      if (Date.now() - (await stat(lease)).mtimeMs < 60000) return;
      const pid = Number(await readFile(join(lease, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      try {
        process.kill(pid, 0);
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
      await rm(lease, { recursive: true, force: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
    return;
  }
  try {
    await writeFile(join(lease, 'pid'), String(process.pid));
    let team = db.config();
    const state = db.deliveryState();
    const agents = (await client.agentList()).agents;
    await syncMembers(db, client, agents);
    team = db.config();
    const members = new Map<string, AgentInfo>();
    for (const member of team.members) {
      const details = team.details?.[member];
      if (
        details?.ended ||
        details?.shutdown_accepted ||
        details?.state === 'starting'
      )
        continue;
      const pane = member === team.lead ? team.lead_pane_id : details?.pane_id;
      const agent = agents.find((a) =>
        pane ? a.pane_id === pane : a.name === member,
      );
      if (agent) members.set(member, agent);
    }
    state.blocked ??= {};
    for (const [member, agent] of members) {
      if (agent.agent_status !== 'blocked') {
        delete state.blocked[member];
        continue;
      }
      if (member === team.lead || state.blocked[member]) continue;
      const inbox = db.inbox(member);
      if (!inbox.length || inbox.at(-1)!.id === state.cursors[member]) continue;
      db.send(
        member,
        team.lead,
        `${member} is blocked; inbox delivery is waiting for permission or an answer.`,
        false,
        'advisory',
      );
      state.blocked[member] = true;
    }
    db.saveDeliveryState(state);
    // Reports run before delivery so the lead receives them in this batch.
    for (const [member, agent] of members) {
      if (
        member === team.lead ||
        !['idle', 'done'].includes(agent.agent_status)
      )
        continue;
      const seq = agent.completion_seq ?? 0;
      if (seq <= (state.reports[member] ?? 0)) continue;
      state.idle_hooks ??= {};
      if (seq > (state.idle_hooks[member] ?? 0)) {
        const hooks = new Hooks(db, env);
        const task = db
          .tasks()
          .find((t) => t.owner === member && t.status === 'in_progress');
        const outcome = await hooks.run('teammate_idle', member, task, {
          member,
        });
        if (outcome.code !== 0) hooks.failure(member, task, outcome);
        state.idle_hooks[member] = seq;
        db.saveDeliveryState(state);
      }

      const tasks = db.tasks().filter((t) => t.owner === member);
      const last = db
        .inbox(team.lead)
        .filter((m) => m.from === member && !m.kind)
        .at(-1);
      const output =
        last?.body ??
        (await client.paneRead(agent.pane_id, {
          source: 'recent-unwrapped',
          lines: 20,
        }));
      db.send(
        member,
        team.lead,
        `Turn completed.\n${tasks.map((t) => `#${t.id} ${t.status}: ${t.subject}`).join('\n')}\n${output}\n${team.details?.[member]?.worktree ? JSON.stringify(worktreeStatus(team.details[member]!.worktree!)) : ''}`,
        false,
        'report',
      );
      state.reports[member] = seq;
      db.saveDeliveryState(state);
    }
    for (const [member, agent] of members) {
      if (!['idle', 'done', 'working'].includes(agent.agent_status)) continue;
      const inbox = db.inbox(member);
      const cursor = state.cursors[member];
      const index =
        cursor === undefined ? -1 : inbox.findIndex((m) => m.id === cursor);
      if (cursor !== undefined && index === -1)
        throw new Error(`Unknown inbox cursor for ${member}`);
      state.acknowledged ??= {};
      const acknowledged = new Set(state.acknowledged[member] ?? []);
      let pending = inbox
        .slice(index + 1)
        .filter((m) => !acknowledged.has(m.id));
      if (agent.agent_status === 'working')
        pending = pending.filter((m) => m.urgent);
      if (
        !pending.length &&
        agent.agent_status !== 'working' &&
        member !== team.lead &&
        team.auto_claim !== false &&
        team.details?.[member]?.auto_claim !== false
      ) {
        const task = db.autoClaim(member);
        if (task) {
          if (task.worktree?.required && !task.worktree.binding) {
            try {
              await new Worktrees(db, client).create(task.id);
            } catch (error) {
              db.change(task.id, 'release', team.lead);
              throw error;
            }
          }
          pending = [
            db.send(
              team.lead,
              member,
              `You claimed task #${task.id}: ${task.subject}\n${task.description}\n${task.plan_mode || team.details?.[member]?.plan_mode ? 'Before editing, submit a plan: herdr-teams plan submit ' + task.id + ' --file plan.md. Follow the team plan approval policy.\n' : ''}${db.task(task.id).worktree?.binding ? `Work in ${JSON.stringify(db.task(task.id).worktree!.binding!.path)}` : ''}`,
            ),
          ];
        }
      }
      if (!pending.length) continue;
      // Recheck after reports and disk operations; herdr also rejects blocked agents.
      const current = (await client.agentGet(agent.pane_id)).agent;
      if (
        current.agent_status === 'blocked' ||
        current.agent_status === 'unknown'
      )
        continue;
      if (current.agent_status === 'working') {
        pending = pending.filter((m) => m.urgent);
        if (!pending.length) continue;
        if (team.details?.[member]?.kind !== 'codex') {
          await client.sendKeys(agent.pane_id, 'esc');
          continue;
        }
      }
      await client.agentPrompt(
        agent.pane_id,
        pending.map((m) => wrap(team.name, m)).join('\n\n'),
      );
      for (const message of pending) acknowledged.add(message.id);
      for (const message of db.inbox(member).slice(index + 1)) {
        if (!acknowledged.has(message.id)) break;
        state.cursors[member] = message.id;
        acknowledged.delete(message.id);
      }
      state.acknowledged[member] = [...acknowledged];
      db.saveDeliveryState(state);
    }
  } finally {
    await rm(lease, { recursive: true, force: true });
  }
}
