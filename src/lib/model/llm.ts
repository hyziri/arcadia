import * as v from 'valibot';

/** Validates the optional endpoint and credentials for an LLM provider. */
export const ProviderConfigSchema = v.object({
	endpoint: v.optional(v.string(), ''),
	model: v.optional(v.string(), ''),
	apiKey: v.optional(v.string(), '')
});

/** LLM provider endpoint and credentials used to make requests. */
export type ProviderConfig = v.InferOutput<typeof ProviderConfigSchema>;
