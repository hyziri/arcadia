/** Public API for version-control services. */

export {
	VersionControlCommitConflictError,
	VersionControlCommitNotPreparedError,
	VersionControlCommitPreparationError,
	VersionControlCommitNotOnRefHistoryError,
	VersionControlCommitAncestryCycleError,
	VersionControlService
} from './version-control';
export type { ForkedRepository, PreparedCommit } from './version-control';
