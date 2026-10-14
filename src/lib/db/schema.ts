/** Defines the IndexedDB stores, keys, values, and indexes used by Arcadia. */

import type { DBSchema } from 'idb';

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
}
