/** Defines shared errors and failure reporting for version-control repositories. */

import * as v from 'valibot';

import { AppError } from '#lib/error';
import type { Logger } from '#lib/logger';

/** Version-control data resources handled by the repositories. */
export type VersionControlResource = 'repo' | 'ref' | 'commit';

/** Persistence operations supported by version-control repositories. */
export type VersionControlOperation = 'create' | 'read' | 'update' | 'delete';

/** Indicates that an IndexedDB operation on a version-control store failed. */
export class VersionControlDatabaseError extends AppError {
	readonly kind = 'version_control_database';
	readonly resource: VersionControlResource;
	readonly operation: VersionControlOperation;
	readonly resourceId: string;
	readonly repoId: string | undefined;

	/** Creates an error describing a failed version-control persistence operation. */
	constructor(
		resource: VersionControlResource,
		operation: VersionControlOperation,
		resourceId: string,
		repoId: string | undefined,
		options?: ErrorOptions
	) {
		super(`${resource} ${operation} operation failed: ${resourceId}`, options);
		this.resource = resource;
		this.operation = operation;
		this.resourceId = resourceId;
		this.repoId = repoId;
	}
}

/** Indicates that a reference ID was accessed through the wrong repository. */
export class VersionControlOwnershipError extends AppError {
	readonly kind = 'version_control_ownership';
	readonly resource = 'ref';
	readonly resourceId: string;
	readonly expectedRepoId: string;
	readonly actualRepoId: string;

	/** Creates an error describing a repository ownership mismatch. */
	constructor(resourceId: string, expectedRepoId: string, actualRepoId: string) {
		super(`ref ${resourceId} does not belong to repository ${expectedRepoId}`);
		this.resourceId = resourceId;
		this.expectedRepoId = expectedRepoId;
		this.actualRepoId = actualRepoId;
	}
}

/** Preserves typed application and Valibot errors, wrapping other failures as database errors.
 *
 * @param logger - The repository-scoped logger.
 * @param resource - The version-control resource involved.
 * @param operation - The persistence operation that failed.
 * @param resourceId - The ID of the resource being accessed.
 * @param repoId - The owning repository ID, when applicable.
 * @param cause - The original failure.
 * @throws {AppError|Error|VersionControlDatabaseError} with the original cause or as a database error.
 */
export function throwVersionControlDatabaseFailure(
	logger: Logger,
	resource: VersionControlResource,
	operation: VersionControlOperation,
	resourceId: string,
	repoId: string | undefined,
	cause: unknown
): never {
	if (cause instanceof AppError || cause instanceof v.ValiError) {
		throw cause;
	}

	throw reportVersionControlDatabaseFailure(logger, resource, operation, resourceId, repoId, cause);
}

/** Logs and wraps an IndexedDB failure at the repository boundary. */
export function reportVersionControlDatabaseFailure(
	logger: Logger,
	resource: VersionControlResource,
	operation: VersionControlOperation,
	resourceId: string,
	repoId: string | undefined,
	cause: unknown
): VersionControlDatabaseError {
	const error = new VersionControlDatabaseError(resource, operation, resourceId, repoId, {
		cause
	});
	logger.error(`version-control ${resource} ${operation} failed`, {
		err: error,
		resourceId,
		...(repoId === undefined ? {} : { repoId })
	});
	return error;
}

/** Logs and creates a reference ownership error at the repository boundary. */
export function reportVersionControlOwnershipFailure(
	logger: Logger,
	resourceId: string,
	expectedRepoId: string,
	actualRepoId: string
): VersionControlOwnershipError {
	const error = new VersionControlOwnershipError(resourceId, expectedRepoId, actualRepoId);
	logger.error('version-control ref ownership mismatch', {
		err: error,
		resourceId,
		expectedRepoId,
		actualRepoId
	});
	return error;
}
