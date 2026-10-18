import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store.js';
import { HerdrClient } from '../herdr/index.js';
import { snapshot, plain } from '../board/model.js';
export async function syncSidebar(db: Store, client: HerdrClient) {
  await db.exclusive('sidebar', async () => {
    const path = join(db.root, 'sidebar.json');
    const previous = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)
      : {};
    const data = snapshot(db);
    const team = db.config();
    const cache: Record<string, string> = {};
    const token = (s: string) => plain(s).slice(0, 80);
    for (const member of data.members) {
      const details = team.details?.[member.name];
      if (!details?.pane_id || details.ended) continue;
      const task = data.tasks.find((t) => member.tasks.includes(t.id));
      const argv = [
        'pane',
        'report-metadata',
        details.pane_id,
        '--source',
        'herdr-teams',
        '--display-agent',
        token(member.name),
        '--title',
        token(`${member.state}${task ? ` · #${task.id} ${task.subject}` : ''}`),
        '--token',
        `team=${token(team.name)}`,
        '--token',
        `task=${task ? token('#' + task.id) : ''}`,
        '--token',
        `branch=${token(member.branch ?? '')}`,
      ];
      const fingerprint = JSON.stringify(argv);
      cache[details.pane_id] = fingerprint;
      if (previous[details.pane_id] !== fingerprint) await client.quiet(argv);
    }
    if (team.workspace_id) {
      const summary = `${data.tasks.filter((t) => t.status === 'completed').length}/${data.tasks.length} done · ${data.members.filter((m) => m.state === 'blocked').length} blocked`;
      const argv = [
        'workspace',
        'report-metadata',
        team.workspace_id,
        '--source',
        'herdr-teams',
        '--token',
        `team_status=${token(summary)}`,
      ];
      cache[team.workspace_id] = JSON.stringify(argv);
      if (previous[team.workspace_id] !== cache[team.workspace_id])
        await client.quiet(argv);
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(cache));
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  });
}
