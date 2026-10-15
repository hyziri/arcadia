/** Defines durable garbage-collection jobs and their per-commit work items. */

import * as v from 'valibot';

/** Validates the reason a repository-scoped collection job was submitted. */
export const GarbageJobReasonSchema = v.picklist([
	'repository-deleted',
	'reference-deleted',
	'reference-moved'
]);

/** Validates the persisted state of a garbage-collection job. */
export const GarbageJobSchema = v.strictObject({
	id: v.string(),
	repoId: v.string(),
	reason: GarbageJobReasonSchema,
	status: v.picklist(['discovering', 'sweeping', 'cleaning', 'completed']),
	submittedAt: v.number(),
	completedAt: v.optional(v.number()),
	sweepCursor: v.optional(v.string()),
	sweepDeleted: v.boolean()
});

/** Validates the persisted state of a commit candidate in a garbage-collection job. */
export const GarbageJobItemSchema = v.strictObject({
	jobId: v.string(),
	commitId: v.string(),
	state: v.picklist(['pending', 'discovered', 'collected'])
});

/** Reason a repository-scoped garbage-collection job was submitted. */
export type GarbageJobReason = v.InferOutput<typeof GarbageJobReasonSchema>;

/** Durable garbage-collection job metadata. */
export type GarbageJob = v.InferOutput<typeof GarbageJobSchema>;

/** Durable per-commit work item belonging to a garbage-collection job. */
export type GarbageJobItem = v.InferOutput<typeof GarbageJobItemSchema>;
