/** Public API for validated data repositories. */

export {
	DbSettingSchema,
	SettingsCorruptError,
	SettingsDatabaseError,
	SettingsRepo
} from './settings';
export type { DbSetting } from './settings';
export {
	CommitCorruptError,
	CommitRepo,
	CreateDbCommitParamSchema,
	DbCommitSchema
} from './commit';
export type { CreateDbCommitParam, DbCommit } from './commit';
export {
	CreateDbRefParamSchema,
	DbRefSchema,
	RefCorruptError,
	RefRepo,
	UpdateDbRefParamSchema
} from './ref';
export type { CreateDbRefParam, DbRef, UpdateDbRefParam } from './ref';
export { DbRepoSchema, RepoCorruptError, RepoRepo } from './repo';
export type { DbRepo } from './repo';
export {
	VersionControlDatabaseError,
	VersionControlOwnershipError
} from './version-control-errors';
export type { VersionControlOperation, VersionControlResource } from './version-control-errors';
