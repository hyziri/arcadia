import * as v from 'valibot';

/** Validates the endpoint, model, and API key for an LLM provider. */
export const ProviderConfigSchema = v.object({
	endpoint: v.string(),
	model: v.string(),
	apiKey: v.string()
});

/** LLM provider endpoint and credentials used to make requests. */
export type ProviderConfig = v.InferOutput<typeof ProviderConfigSchema>;
