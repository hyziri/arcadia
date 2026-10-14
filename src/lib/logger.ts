/** Provides module-scoped logging with structured metadata and development-only diagnostics.
 *
 * Create one logger per module or subsystem so log output identifies where an event originated.
 * `error`, `warn`, and `info` messages are always written, while `debug` and `trace` messages are
 * written only during development. Pass operational context as metadata; when reporting a failure,
 * use the `err` property for the thrown error so developer tools can preserve its stack trace.
 *
 * @example
 * ```ts
 * import { getLogger } from '#lib/logger';
 *
 * const log = getLogger('data/character');
 *
 * log.debug('character loaded', { characterId });
 *
 * try {
 * 	await repository.save(character);
 * } catch (error) {
 * 	log.error('character save failed', { err: error, characterId });
 * }
 * ```
 */

import { dev } from '$app/env';

/** Structured, non-secret context appended to a log message. */
export type LogMeta = Record<string, unknown>;

/** A logger whose output is scoped to the module that created it. */
export interface Logger {
	/** Records a failure that requires investigation or user-facing recovery. */
	error(message: string, meta?: LogMeta): void;

	/** Records a recoverable problem or degraded behavior. */
	warn(message: string, meta?: LogMeta): void;

	/** Records a durable or user-meaningful application state change. */
	info(message: string, meta?: LogMeta): void;

	/** Records successful, development-only operation details. */
	debug(message: string, meta?: LogMeta): void;

	/** Records low-cost, development-only call-flow diagnostics. */
	trace(message: string, meta?: LogMeta): void;
}

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Writes a formatted message to the console at the requested severity. */
function write(level: LogLevel, module: string, message: string, meta?: LogMeta): void {
	const args = [`[${module}]`, message, ...(meta === undefined ? [] : [meta])];

	switch (level) {
		case 'error':
			console.error(...args);
			break;
		case 'warn':
			console.warn(...args);
			break;
		case 'info':
			console.info(...args);
			break;
		case 'debug':
			console.debug(...args);
			break;
	}
}

/**
 * Creates a logger scoped to a module.
 *
 * @param module - The module or subsystem name shown in log output.
 * @returns A scoped logger.
 */
export function getLogger(module: string): Logger {
	return {
		error(message, meta) {
			write('error', module, message, meta);
		},

		warn(message, meta) {
			write('warn', module, message, meta);
		},

		info(message, meta) {
			write('info', module, message, meta);
		},

		debug(message, meta) {
			if (dev) {
				write('debug', module, message, meta);
			}
		},

		trace(message, meta) {
			if (dev) {
				// Deliberately use debug rather than console.trace.
				// This prevents including traceback default behavior with console.trace
				write('debug', module, message, meta);
			}
		}
	};
}
