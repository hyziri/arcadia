/** Public API for version-control repositories. */

export {
	CommitCorruptError,
	CommitRepo,
	CreateDbCommitParamSchema,
	CommitAncestryCorruptError
} from './commit';
export type { CreateDbCommitParam } from './commit';
export { CreateDbRefParamSchema, RefCorruptError, RefRepo, UpdateDbRefParamSchema } from './ref';
export type { CreateDbRefParam, UpdateDbRefParam } from './ref';
export { RepoCorruptError, RepoRepo } from './repo';
export {
	CreateDbRepoAlternateParamSchema,
	RepoAlternateCorruptError,
	RepoAlternateRepo
} from './repo-alternate';
export type { CreateDbRepoAlternateParam } from './repo-alternate';
export {
	VersionControlDatabaseError,
	VersionControlOwnershipError,
	VersionControlResourceNotFoundError
} from './version-control-errors';
export type { VersionControlOperation, VersionControlResource } from './version-control-errors';
