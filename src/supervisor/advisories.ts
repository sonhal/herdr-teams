import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';

export function screenHash(text: string): string {
  return createHash('sha256')
    .update(
      stripVTControlCharacters(text)
        .replace(/[\u2800-\u28ff|/\\\-⠂⠄◐◓◑◒]/gu, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .digest('hex');
}

export async function checkAdvisories(
  db: Store,
  client: HerdrClient,
  now = Date.now(),
): Promise<void> {
  const team = db.config();
  for (const [name, member] of Object.entries(team.details ?? {})) {
    if (member.ended || member.state === 'starting' || !member.pane_id)
      continue;
    let hash = member.screen_hash;
    try {
      hash = screenHash(
        await client.paneRead(member.pane_id, {
          source: 'recent-unwrapped',
          lines: 40,
        }),
      );
    } catch {
      /* A missing pane is classified by lifecycle reconciliation. */
    }
    let progress = member.progress_at ?? now;
    const changed =
      hash !== member.screen_hash || (member.last_activity ?? 0) > progress;
    if (changed) progress = now;
    const quiet =
      member.interactive ||
      (member.focused_at !== undefined && now - member.focused_at < 300000);
    const type =
      member.state === 'working'
        ? 'no-progress'
        : member.state === 'blocked'
          ? 'needs-input'
          : member.state === 'unknown'
            ? 'unclassified'
            : undefined;
    const minutes =
      type === 'no-progress'
        ? (team.supervisor?.no_progress_minutes ?? 10)
        : type === 'needs-input'
          ? (team.supervisor?.needs_input_minutes ?? 2)
          : (team.supervisor?.unknown_minutes ?? 5);
    const elapsed =
      type === 'no-progress'
        ? now - progress
        : now - (member.state_since ?? now);
    const active =
      type && minutes > 0 && elapsed >= minutes * 60000 ? type : null;
    if (
      member.advisory &&
      (!active ||
        (changed && type === 'no-progress') ||
        member.advisory !== active)
    ) {
      if (member.advisory_notified)
        db.send(
          name,
          team.lead,
          `${name} recovered from ${member.advisory}`,
          false,
          'advisory',
        );
      db.event('advisory.recovered', {
        member: name,
        advisory: member.advisory,
      });
    }
    const next = changed && type === 'no-progress' ? null : active;
    const fresh = next && next !== member.advisory;
    let notified = member.advisory_notified ?? false;
    let nudged = member.nudged ?? false;
    if (!next) {
      notified = false;
      nudged = false;
    }
    if (fresh) {
      db.event('advisory.raised', {
        member: name,
        advisory: next,
        quiet: Boolean(quiet),
      });
      if (
        !quiet &&
        next === 'no-progress' &&
        team.supervisor?.on_no_progress === 'nudge'
      ) {
        db.send(
          team.lead,
          name,
          'Status check: report progress or the blocker.',
          true,
        );
        nudged = true;
      } else if (!quiet) {
        db.send(
          name,
          team.lead,
          `${name}: ${next}. Inspect with peek, steer, interrupt or kill.`,
          false,
          'advisory',
        );
        notified = true;
      }
      if (!quiet && next === 'needs-input')
        await client.command([
          'notification',
          'show',
          `${name} needs input`,
          '--body',
          'Answer the permission or question prompt in its pane.',
          '--sound',
          'request',
        ]);
    } else if (
      next &&
      nudged &&
      !notified &&
      !quiet &&
      elapsed >= (minutes + 1) * 60000
    ) {
      db.send(
        name,
        team.lead,
        `${name}: no progress after a status check. Inspect with peek or interrupt.`,
        false,
        'advisory',
      );
      notified = true;
    }
    db.patchMember(name, {
      ...(hash ? { screen_hash: hash } : {}),
      progress_at: progress,
      state_since: member.state_since ?? now,
      advisory: next,
      advisory_notified: notified,
      nudged,
    });
  }
}
