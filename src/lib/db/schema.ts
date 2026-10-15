/** Defines the IndexedDB stores, keys, values, and indexes used by Arcadia. */

import type { DBSchema } from 'idb';

import type { Commit, Ref, Repo } from '#lib/model';

/** IndexedDB stores and row shapes persisted by Arcadia. */
export interface ArcadiaDbSchema extends DBSchema {
	/** Application settings keyed by setting name. */
	settings: {
		key: string;
		value: {
			key: string;
			value: string;
		};
		indexes: Record<string, never>;
	};

	/** Version-control repositories. */
	repos: {
		key: string;
		value: Repo;
		indexes: Record<string, never>;
	};

	/** Named branch references within repositories. */
	refs: {
		key: string;
		value: Ref;
		indexes: {
			/** Lists refs belonging to a repository. */
			'by-repo': string;
			/** Uniquely identifies a ref name within a repository. */
			'by-repo-name': [string, string];
			/** Finds refs targeting a commit. */
			'by-target-commit': string;
		};
	};

	/** Immutable version-control commits. */
	commits: {
		key: string;
		value: Commit;
		indexes: {
			/** Finds child commits; root commits with no parent are not indexed. */
			'by-parent': string;
			/** Finds commits that use another commit as an alternate. */
			'by-alternate': string;
		};
	};
}
