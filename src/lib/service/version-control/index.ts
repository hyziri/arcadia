/** Public API for version-control services. */

export {
	VersionControlCommitConflictError,
	VersionControlCommitNotPreparedError,
	VersionControlCommitPreparationError,
	VersionControlCommitNotOnRefHistoryError,
	VersionControlCommitAncestryCycleError,
	VersionControlAlternateMembershipError,
	VersionControlService
} from './version-control';
export type { ForkedRepository, PreparedCommit } from './version-control';
export { GarbageCollectionService } from './garbage-collection';
