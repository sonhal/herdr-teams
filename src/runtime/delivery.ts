import { Hooks } from '../core/hooks.js';
import { syncMembers } from './lifecycle.js';
import { each } from './each.js';
import {
  Store,
  agentName,
  clip,
  MAX_MESSAGE_BYTES,
  type Message,
  type Task,
  type Team,
} from '../core/store.js';
import { HerdrClient, type AgentInfo } from '../herdr/index.js';

// Leaves room below 128 KiB for herdr's other arguments.
const MAX_PROMPT_BYTES = 96 * 1024;

function wrap(team: string, message: Message): string {
  // clip() covers mail written before Store.send enforced the limit.
  // Advisories come from herdr-teams, often about a teammate that has ended,
  // so a reply hint would point at no one.
  if (message.kind === 'advisory')
    return `[herdr-teams] notice about ${message.from} — team "${team}":\n${clip(message.body)}\nInspect: herdr-teams status · Tasks: herdr-teams task list`;
  return `[herdr-teams] message from ${message.from} (teammate, not the user) — team "${team}":\n${clip(message.body)}\nReply: herdr-teams msg send ${message.from} "…" · Tasks: herdr-teams task list`;
}

/** The longest prefix of pending mail that fits in one prompt; never empty. */
function batch(team: string, pending: Message[]): Message[] {
  let bytes = 0;
  const fitting: Message[] = [];
  for (const message of pending) {
    bytes += Buffer.byteLength(wrap(team, message)) + 2;
    if (fitting.length && bytes > MAX_PROMPT_BYTES) break;
    fitting.push(message);
  }
  return fitting;
}

/**
 * Teammates match on agent name and pane: pane IDs are reused after restarts.
 * Whatever agent runs in the lead pane is the lead, as it is for CLI authority.
 */
export function liveMember(
  team: Team,
  member: string,
  agents: AgentInfo[],
): AgentInfo | undefined {
  if (member === team.lead)
    return team.lead_pane_id
      ? agents.find((a) => a.pane_id === team.lead_pane_id)
      : agents.find((a) => a.name === member);
  const pane = team.details?.[member]?.pane_id;
  const name = agentName(team, member);
  return agents.find(
    (a) => a.name === name && (pane === undefined || a.pane_id === pane),
  );
}

/** Hooks and commands share one delivery lease; never hold the store lock across I/O. */
export async function reconcile(
  db: Store,
  client: HerdrClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const failures: unknown[] = [];
  const idleHooks: [string, Task | undefined][] = [];
  await db.exclusive(
    'delivery',
    async () => {
      let team = db.config();
      const state = db.deliveryState();
      const agents = (await client.agentList()).agents;
      await syncMembers(db, client, agents).catch((error: unknown) =>
        failures.push(error),
      );
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
        const agent = liveMember(team, member, agents);
        if (agent) members.set(member, agent);
      }
      state.incarnations ??= {};
      state.interrupts ??= {};
      state.report_messages ??= {};
      for (const [member, agent] of members) {
        const incarnation = JSON.stringify([
          agent.pane_id,
          team.details?.[member]?.started_at,
          agent.agent_session,
        ]);
        if (state.incarnations[member] !== incarnation) {
          state.incarnations[member] = incarnation;
          delete state.reports[member];
          if (state.idle_hooks) delete state.idle_hooks[member];
          if (state.blocked) delete state.blocked[member];
          delete state.interrupts[member];
        }
      }
      state.blocked ??= {};
      for (const [member, agent] of members) {
        if (agent.agent_status !== 'blocked') {
          delete state.blocked[member];
          continue;
        }
        if (member === team.lead || state.blocked[member]) continue;
        const inbox = db.inbox(member);
        if (!inbox.length || inbox.at(-1)!.id === state.cursors[member])
          continue;
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
      await each(members, async (member, agent) => {
        if (
          member === team.lead ||
          !['idle', 'done'].includes(agent.agent_status)
        )
          return;
        const seq = agent.completion_seq ?? 0;
        if (seq <= (state.reports[member] ?? 0)) return;
        state.idle_hooks ??= {};
        if (seq > (state.idle_hooks[member] ?? 0)) {
          idleHooks.push([
            member,
            db
              .tasks()
              .find((t) => t.owner === member && t.status === 'in_progress'),
          ]);
          state.idle_hooks[member] = seq;
          db.saveDeliveryState(state);
        }

        const active = db
          .tasks()
          .filter(
            (t) =>
              t.owner === member &&
              (t.status === 'in_progress' || t.status === 'planning'),
          );
        const last = db
          .inbox(team.lead)
          .filter(
            (m) =>
              m.from === member &&
              !m.kind &&
              Date.parse(m.createdAt) >=
                (team.details?.[member]?.started_at ?? 0),
          )
          .at(-1);
        const messaged = last && last.id !== state.report_messages![member];
        // Completions and plans reach the lead as the teammate's own mail.
        // A turn that ends silently is reported only when the lead would
        // otherwise not learn why work stopped: an active task, or the spawn
        // prompt's turn. The pane is then the only record of what happened.
        const first = state.reports[member] === undefined;
        if (!messaged && (active.length || first)) {
          const output = await client.paneRead(agent.pane_id, {
            source: 'recent-unwrapped',
            lines: 20,
          });
          const tasks = active
            .map((t) => `#${t.id} ${t.status}: ${t.subject}`)
            .join('\n');
          db.send(
            member,
            team.lead,
            clip(
              `${member} stopped without messaging you${tasks ? ` while holding:\n${tasks}` : '.'}\n${output}`,
            ),
            false,
            'report',
          );
        }
        state.reports[member] = seq;
        if (last) state.report_messages![member] = last.id;
        db.saveDeliveryState(state);
      }).catch((error: unknown) => failures.push(error));
      await each(members, async (member, agent) => {
        if (!['idle', 'done', 'working'].includes(agent.agent_status)) return;
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
        const steers = team.details?.[member]?.kind !== 'codex';
        if (agent.agent_status === 'working') {
          pending = pending.filter((m) => m.urgent);
          if (
            steers &&
            (state.interrupts![member] ||
              pending.some((m) => m.id === state.steered![member]))
          )
            return;
        }
        if (agent.agent_status !== 'working' && db.autoClaims(member)) {
          const task = db.autoClaim(member, pending.length > 0);
          if (task) {
            pending = [
              ...pending,
              db.send(
                team.lead,
                member,
                `You claimed task #${task.id}: ${task.subject}\n${clip(task.description, MAX_MESSAGE_BYTES / 2)}\n${task.plan_mode || team.details?.[member]?.plan_mode ? 'Before editing, submit a plan: herdr-teams plan submit ' + task.id + ' --file plan.md. Follow the team plan approval policy.\n' : ''}`,
              ),
            ];
          }
        }
        if (!pending.length) return;
        // Recheck after reports and disk operations; herdr also rejects blocked agents.
        const current = (await client.agentGet(agent.pane_id)).agent;
        if (current.pane_id !== agent.pane_id || current.name !== agent.name)
          return;
        if (
          current.agent_status === 'blocked' ||
          current.agent_status === 'unknown'
        )
          return;
        if (current.agent_status === 'working') {
          pending = pending.filter((m) => m.urgent);
          if (!pending.length) return;
          if (steers) {
            // Saved first so a retried reconcile doesn't press Esc again.
            if (
              state.interrupts![member] ||
              pending.some((m) => m.id === state.steered![member])
            )
              return;
            state.interrupts![member] = true;
            state.steered![member] = pending.at(-1)!.id;
            db.saveDeliveryState(state);
            await client.sendKeys(agent.pane_id, 'esc');
            return;
          }
        }
        // The rest waits for the next idle turn.
        pending = batch(team.name, pending);
        await client.agentPrompt(
          agent.pane_id,
          pending.map((m) => wrap(team.name, m)).join('\n\n'),
        );
        delete state.interrupts![member];
        delete state.steered![member];
        for (const message of pending) acknowledged.add(message.id);
        for (const message of db.inbox(member).slice(index + 1)) {
          if (!acknowledged.has(message.id)) break;
          state.cursors[member] = message.id;
          acknowledged.delete(message.id);
        }
        state.acknowledged[member] = [...acknowledged];
        db.saveDeliveryState(state);
      }).catch((error: unknown) => failures.push(error));
    },
    'Delivery is busy; retry',
  );
  // Hooks may run for minutes; under the lease they would stall every delivery.
  const hooks = new Hooks(db, env);
  await each(idleHooks, async (member, task) => {
    const outcome = await hooks.run('teammate_idle', member, task, { member });
    if (outcome.code !== 0) hooks.failure(member, task, outcome);
  }).catch((error: unknown) => failures.push(error));
  if (failures.length)
    throw new Error(failures.map((e) => (e as Error).message).join('; '));
}
