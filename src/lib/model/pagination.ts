/** Defines validated pagination parameters shared by collection data and service operations. */

import * as v from 'valibot';

/** Validates one-based pagination with a maximum page size of 50 entries. */
export const PaginationSchema = v.strictObject({
	/** One-based page number; must be a positive safe integer. */
	page: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
	/** Number of entries per page; must be a safe integer from 1 through 50. */
	perPage: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(50))
});

/** Validated pagination values inferred from {@link PaginationSchema}. */
export type Pagination = v.InferOutput<typeof PaginationSchema>;
