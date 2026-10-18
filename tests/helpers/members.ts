import type { Store } from '../../src/core/store.js';

/** A member without a lifecycle record, such as one started outside herdr-teams. */
export function addMember(db: Store, member: string): void {
  db.updateTeam((team) => {
    team.members.push(member);
  });
}
