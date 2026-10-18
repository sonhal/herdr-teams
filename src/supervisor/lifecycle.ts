import { adapter } from '../adapters/index.js';
import { each } from './each.js';
import { Store } from '../core/store.js';
import { HerdrClient, HerdrApiError, type AgentInfo } from '../herdr/index.js';

export async function syncMembers(
  db: Store,
  client: HerdrClient,
  agents: AgentInfo[],
): Promise<void> {
  const team = db.config();
  await each(Object.entries(team.details ?? {}), async (name, member) => {
    if (member.ended) return;
    if (member.state === 'starting') {
      if (
        !member.launch_pid ||
        Date.now() - (member.started_at ?? Date.now()) < 30000
      )
        return;
      try {
        process.kill(member.launch_pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
      db.endMember(
        name,
        'failed-to-launch',
        'Launch process exited before recording readiness',
      );
      return;
    }
    const live = agents.find(
      (a) => a.name === name && a.pane_id === member.pane_id,
    );
    if (!live) {
      let output = '';
      if (member.pane_id)
        try {
          output = await client.paneRead(member.pane_id, {
            lines: 40,
            source: 'recent-unwrapped',
          });
        } catch {
          /* The pane may have closed. */
        }
      db.endMember(
        name,
        member.shutdown_accepted
          ? 'shut-down'
          : member.focused_at && Date.now() - member.focused_at < 300000
            ? 'closed-by-user'
            : 'crashed',
        output,
      );
      if (member.shutdown_accepted && member.pane_id) {
        try {
          await client.paneClose(member.pane_id);
        } catch (error) {
          if (
            !(error instanceof HerdrApiError) ||
            !['pane_not_found', 'not_found'].includes(error.code)
          )
            throw error;
        }
      }
      return;
    }
    if (live.agent_status !== member.state) {
      db.patchMember(name, {
        state: live.agent_status,
        state_since: Date.now(),
        progress_at: Date.now(),
        ...(live.agent_status === 'working' ? { interrupted: false } : {}),
      });
      db.event('member.state', { member: name, state: live.agent_status });
    }
    if (
      member.shutdown_accepted &&
      !member.shutdown_exit_sent &&
      ['idle', 'done'].includes(live.agent_status)
    ) {
      await client.agentPrompt(name, adapter(member.kind).exit);
      db.patchMember(name, { shutdown_exit_sent: true });
    }
  });
}
