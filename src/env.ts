/** Declares environment variables exposed to client code. */
import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	LLM_ENDPOINT: { public: true },
	LLM_MODEL: { public: true },
	LLM_API_KEY: { public: true }
});
