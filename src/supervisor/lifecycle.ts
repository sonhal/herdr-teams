import { adapter } from '../adapters/index.js';
import { Store } from '../core/store.js';
import { HerdrClient, HerdrApiError, type AgentInfo } from '../herdr/index.js';

export async function syncMembers(
  db: Store,
  client: HerdrClient,
  agents: AgentInfo[],
): Promise<void> {
  const team = db.config();
  for (const [name, member] of Object.entries(team.details ?? {})) {
    if (member.ended || member.state === 'starting') continue;
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
        member.shutdown_accepted ? 'shut-down' : 'crashed',
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
      continue;
    }
    if (live.agent_status !== member.state) {
      db.patchMember(name, { state: live.agent_status });
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
  }
}
