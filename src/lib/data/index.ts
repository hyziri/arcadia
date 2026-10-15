/** Public API for validated data repositories. */

export {
	DbSettingSchema,
	SettingsCorruptError,
	SettingsDatabaseError,
	SettingsRepo
} from './settings';
export type { DbSetting } from './settings';
export { CommitCorruptError, CommitRepo, CreateDbCommitParamSchema } from './commit';
export type { CreateDbCommitParam } from './commit';
export { CreateDbRefParamSchema, RefCorruptError, RefRepo, UpdateDbRefParamSchema } from './ref';
export type { CreateDbRefParam, UpdateDbRefParam } from './ref';
export { RepoCorruptError, RepoRepo } from './repo';

export {
	VersionControlDatabaseError,
	VersionControlOwnershipError
} from './version-control-errors';
export type { VersionControlOperation, VersionControlResource } from './version-control-errors';
