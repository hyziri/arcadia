/** Public API for version-control services. */

export {
	VersionControlCommitConflictError,
	VersionControlCommitNotPreparedError,
	VersionControlCommitPreparationError,
	VersionControlResourceNotFoundError,
	VersionControlService
} from './version-control';
export type { ForkedRepository, PreparedCommit } from './version-control';
