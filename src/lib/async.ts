/** Provides shared timeout handling for asynchronous application operations.
 *
 * `withTimeout` rejects with a typed, logged timeout error when an operation exceeds its deadline.
 * It does not cancel the underlying operation unless the caller supplies an `onTimeout` cleanup callback.
 *
 * @example
 * ```ts
 * import { withTimeout } from '#lib/async';
 *
 * await withTimeout(refreshCache(), 5_000, 'refresh cache');
 * ```
 */

import { OperationTimeoutError } from '#lib/error';
import { getLogger } from '#lib/logger';

const log = getLogger('async');

/**
 * Resolves an operation before its deadline or rejects with a typed timeout error.
 *
 * @param promise - The asynchronous operation to bound.
 * @param timeoutMs - The maximum duration in milliseconds.
 * @param operation - A diagnostic operation name.
 * @param onTimeout - Optional cleanup to run before rejecting.
 * @returns The operation result.
 * @throws {OperationTimeoutError} when the deadline is exceeded.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	operation: string,
	onTimeout?: () => void
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			try {
				onTimeout?.();
			} catch {
				// Cleanup failures should not replace the timeout error.
			}
			const error = new OperationTimeoutError(operation, timeoutMs);
			log.error('operation timed out', { err: error, operation, timeoutMs });
			reject(error);
		}, timeoutMs);
	});

	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}
