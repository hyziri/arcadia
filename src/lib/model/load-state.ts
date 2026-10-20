/**
 * Defines the generic states of an asynchronously loaded resource.
 *
 * A resource is not yet loaded, currently loading, or loaded with a value. The
 * `state` field discriminates the variants, and `data` is present only when the
 * resource is loaded. Include `null` in the data type when null is a valid loaded
 * result.
 */

export const LoadState = {
	NotLoaded: 'not-loaded',
	Loading: 'loading',
	Loaded: 'loaded',
	Error: 'error'
} as const;

export type LoadState<T> =
	| { state: typeof LoadState.NotLoaded }
	| { state: typeof LoadState.Loading }
	| { state: typeof LoadState.Loaded; data: T }
	| { state: typeof LoadState.Error; error: unknown };

export type Loaded<T> = {
	state: typeof LoadState.Loaded;
	data: T;
};

/**
 * Creates the loaded variant of a resource state.
 *
 * @typeParam T - The type of the loaded value.
 * @param data - The loaded value.
 * @returns The loaded state containing the value.
 */
export function loaded<T>(data: T): Loaded<T> {
	return { state: LoadState.Loaded, data };
}
