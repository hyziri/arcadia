/** Defines shared persistence errors and failure handling for garbage-collection repositories. */

import * as v from 'valibot';

import { AppError } from '#lib/error';
import type { Logger } from '#lib/logger';

/** Store-backed garbage-collection resources. */
export type GarbageCollectionResource = 'job' | 'item';

/** Persistence operations performed by garbage-collection repositories. */
export type GarbageCollectionOperation = 'read' | 'write' | 'delete';

/** Indicates that a persisted garbage-collection record does not match its schema. */
export class GarbageCollectionCorruptError extends AppError {
	readonly kind = 'garbage_collection_corrupt';
	readonly recordId: string | undefined;
	readonly issues: readonly v.BaseIssue<unknown>[];

	/** Creates an error describing an invalid persisted garbage-collection record. */
	constructor(recordId: string | undefined, issues: readonly v.BaseIssue<unknown>[]) {
		super(
			recordId === undefined
				? 'A persisted garbage-collection record is invalid'
				: `Persisted garbage-collection record is invalid: ${recordId}`
		);
		this.recordId = recordId;
		this.issues = issues;
	}
}

/** Indicates that an IndexedDB operation on a garbage-collection store failed. */
export class GarbageCollectionDatabaseError extends AppError {
	readonly kind = 'garbage_collection_database';
	readonly resource: GarbageCollectionResource;
	readonly operation: GarbageCollectionOperation;
	readonly resourceId: string | undefined;

	/** Creates an error describing a failed garbage-collection persistence operation. */
	constructor(
		resource: GarbageCollectionResource,
		operation: GarbageCollectionOperation,
		resourceId: string | undefined,
		options?: ErrorOptions
	) {
		super(
			resourceId === undefined
				? `Garbage-collection ${resource} ${operation} operation failed`
				: `Garbage-collection ${resource} ${operation} operation failed: ${resourceId}`,
			options
		);
		this.resource = resource;
		this.operation = operation;
		this.resourceId = resourceId;
	}
}

/** Reads a string field from an unknown persisted record for corruption diagnostics.
 *
 * @param value - The untrusted persisted value.
 * @param field - The field to read.
 * @returns The string value, or `undefined` when the field is unavailable or not a string.
 */
export function getStringField(value: unknown, field: string): string | undefined {
	if (typeof value !== 'object' || value === null || !(field in value)) return undefined;
	const candidate = (value as Record<string, unknown>)[field];
	return typeof candidate === 'string' ? candidate : undefined;
}

/** Logs and throws a corruption error for an invalid persisted garbage-collection record.
 *
 * @param logger - The repository-scoped logger.
 * @param message - The corruption event to log.
 * @param recordId - The affected record identifier, when available.
 * @param issues - The schema validation issues.
 * @returns Never; this function always throws.
 * @throws {GarbageCollectionCorruptError} for the invalid persisted record.
 */
export function throwGarbageCorruptError(
	logger: Logger,
	message: string,
	recordId: string | undefined,
	issues: readonly v.BaseIssue<unknown>[]
): never {
	const error = new GarbageCollectionCorruptError(recordId, issues);
	logger.error(message, {
		err: error,
		...(recordId === undefined ? {} : { recordId })
	});
	throw error;
}

/**
 * Preserves typed errors and wraps unexpected persistence failures with garbage-collection context.
 *
 * @param logger - The repository-scoped logger.
 * @param resource - The garbage-collection store resource involved.
 * @param operation - The persistence operation that failed.
 * @param resourceId - The affected resource identifier, when available.
 * @param cause - The original failure.
 * @returns Never; this function always throws.
 * @throws {AppError|v.ValiError|GarbageCollectionDatabaseError} with the original failure or its database wrapper.
 */
export function throwGarbageDatabaseFailure(
	logger: Logger,
	resource: GarbageCollectionResource,
	operation: GarbageCollectionOperation,
	resourceId: string | undefined,
	cause: unknown
): never {
	if (cause instanceof AppError || cause instanceof v.ValiError) throw cause;

	const error = new GarbageCollectionDatabaseError(resource, operation, resourceId, { cause });
	logger.error(`garbage-collection ${resource} ${operation} failed`, {
		err: error,
		...(resourceId === undefined ? {} : { resourceId })
	});
	throw error;
}
