/** Defines the application-wide base class for typed operational errors.
 *
 * Extend `AppError` for errors that callers may need to distinguish from unexpected failures.
 * Subclasses should add a collision-resistant `kind` discriminator and any structured context
 * needed by their owning layer. The base class preserves the subclass prototype and supports
 * the standard `cause` option for retaining the underlying failure.
 *
 * @example
 * ```ts
 * import { AppError } from '#lib/error';
 *
 * class CharacterNotFoundError extends AppError {
 * 	readonly kind = 'character_not_found';
 *
 * 	constructor(characterId: string) {
 * 		super(`Character not found: ${characterId}`);
 * 	}
 * }
 *
 * try {
 * 	throw new CharacterNotFoundError('character-123');
 * } catch (error) {
 * 	if (error instanceof AppError) {
 * 		console.error(error.kind, error.message);
 * 	}
 * }
 * ```
 */

/** Base class for typed application errors. */
export class AppError extends Error {
	/**
	 * Creates an application error while preserving subclass identity and an optional underlying cause.
	 *
	 * @param message - A human-readable description of the failure.
	 * @param options - Standard error options, including an optional underlying cause.
	 */
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Indicates that an asynchronous application operation exceeded its deadline. */
export class OperationTimeoutError extends AppError {
	readonly kind = 'operation_timeout';
	readonly operation: string;
	readonly timeoutMs: number;

	/** Creates an error describing an operation that exceeded its deadline. */
	constructor(operation: string, timeoutMs: number) {
		super(`Operation timed out: ${operation} (${timeoutMs}ms)`);
		this.operation = operation;
		this.timeoutMs = timeoutMs;
	}
}
