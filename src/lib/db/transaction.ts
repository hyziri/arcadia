/** Provides shared IndexedDB transaction ownership for data and service workflows.
 *
 * A supplied transaction remains caller-owned: this helper validates its store scope and runs the
 * operation, but does not complete or abort it. Caller-owned operations are not timed out because
 * returning early could leave a write running after the caller handles the failure. Otherwise, the
 * helper creates a transaction for the requested stores, waits for completion, and aborts it if the
 * operation fails or times out.
 *
 * @example
 * ```ts
 * import { getDatabase, withTransaction } from '#lib/db';
 *
 * const database = await getDatabase();
 * await withTransaction(database, ['repos'], 'readwrite', undefined, async (transaction) => {
 * 	await transaction.objectStore('repos').add(repository);
 * });
 * ```
 */

import type { IDBPTransaction, StoreNames } from 'idb';

import { withTimeout } from '#lib/async';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';

import type { Database } from './database';
import type { ArcadiaDbSchema } from './schema';

/** Transaction modes supported by Arcadia persistence operations. */
export type ArcadiaTransactionMode = 'readonly' | 'readwrite';

/** Names of stores defined by the Arcadia IndexedDB schema. */
export type ArcadiaStoreName = StoreNames<ArcadiaDbSchema>;

/** A typed IndexedDB transaction over Arcadia stores. */
export type ArcadiaTransaction<Mode extends ArcadiaTransactionMode = ArcadiaTransactionMode> =
	IDBPTransaction<ArcadiaDbSchema, ArcadiaStoreName[], Mode>;

const TRANSACTION_TIMEOUT_MS = 5_000;
const log = getLogger('db/transaction');

/** Raised when a supplied transaction does not include a required object store. */
export class TransactionScopeError extends AppError {
	readonly kind = 'transaction_scope_error';
	readonly storeName: ArcadiaStoreName;

	/** Creates an error describing the missing store in a caller-owned transaction. */
	constructor(storeName: ArcadiaStoreName, options?: ErrorOptions) {
		super(`The supplied transaction does not include the '${storeName}' store`, options);
		this.storeName = storeName;
	}
}

/**
 * Runs an operation in a caller-owned transaction or in a transaction created for the requested stores.
 *
 * @param database - Database used when a transaction must be created.
 * @param storeNames - Stores required by the operation.
 * @param mode - Transaction access mode.
 * @param transaction - Optional caller-owned transaction.
 * @param operation - Operation to execute in the transaction.
 * @returns The operation result.
 * @throws {TransactionScopeError|OperationTimeoutError|DOMException} when the scope is invalid, a locally owned transaction times out, or IndexedDB fails.
 */
export async function withTransaction<T, Mode extends ArcadiaTransactionMode>(
	database: Database,
	storeNames: ArcadiaStoreName[],
	mode: Mode,
	transaction: ArcadiaTransaction<Mode> | undefined,
	operation: (transaction: ArcadiaTransaction<Mode>) => Promise<T>
): Promise<T> {
	if (transaction !== undefined) {
		for (const storeName of storeNames) {
			try {
				transaction.objectStore(storeName);
			} catch (cause: unknown) {
				if (
					typeof cause === 'object' &&
					cause !== null &&
					'name' in cause &&
					cause.name === 'NotFoundError'
				) {
					const error = new TransactionScopeError(storeName, { cause });
					log.error('transaction is missing a required store', { err: error, storeName });
					throw error;
				}

				throw cause;
			}
		}

		return operation(transaction);
	}

	const ownedTransaction = database.transaction(storeNames, mode) as ArcadiaTransaction<Mode>;
	void ownedTransaction.done.catch(() => undefined);

	const operationPromise = (async () => {
		try {
			const result = await operation(ownedTransaction);
			await ownedTransaction.done;
			return result;
		} catch (error: unknown) {
			abortTransaction(ownedTransaction);
			await ownedTransaction.done.catch(() => undefined);
			throw error;
		}
	})();

	return withTimeout(
		operationPromise,
		TRANSACTION_TIMEOUT_MS,
		`transaction:${storeNames.join(',')}`,
		() => abortTransaction(ownedTransaction)
	);
}

/** Aborts an owned transaction if it is still active. */
function abortTransaction(transaction: ArcadiaTransaction): void {
	try {
		transaction.abort();
	} catch {
		// It may already have completed or aborted.
	}
}
