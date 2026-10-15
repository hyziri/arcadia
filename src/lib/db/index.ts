/** Public API for opening Arcadia's IndexedDB connection. */

export { getDatabase } from './database';
export type { Database } from './database';
export type { ArcadiaDbSchema } from './schema';
export { TransactionScopeError, withTransaction } from './transaction';
export type { ArcadiaStoreName, ArcadiaTransaction, ArcadiaTransactionMode } from './transaction';
