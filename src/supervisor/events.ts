import { Store } from '../core/store.js';

export function applyEvent(db: Store, event: unknown, now = Date.now()): void {
  if (!event || typeof event !== 'object') return;
  const { event: kind, data } = event as {
    event?: unknown;
    data?: Record<string, unknown>;
  };
  if (!data || typeof data !== 'object') return;
  for (const [name, member] of Object.entries(db.config().details ?? {})) {
    if (member.ended) continue;
    if (
      ['pane.focused', 'pane_focused'].includes(String(kind)) &&
      data.pane_id === member.pane_id
    )
      db.patchMember(name, { focused_at: now });
    if (
      ['pane.moved', 'pane_moved'].includes(String(kind)) &&
      data.previous_pane_id === member.pane_id &&
      data.pane &&
      typeof data.pane === 'object'
    ) {
      const pane = data.pane as Record<string, unknown>;
      if (
        typeof pane.pane_id === 'string' &&
        typeof pane.workspace_id === 'string' &&
        typeof pane.tab_id === 'string'
      )
        db.patchMember(name, {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
        });
    }
  }
}
