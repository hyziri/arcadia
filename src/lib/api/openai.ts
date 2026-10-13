import * as v from 'valibot';

import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { type ProviderConfig } from '#lib/model';

const log = getLogger('api/openai');

const REQUEST_TIMEOUT_MS = 120_000;

/** Roles accepted by OpenAI-compatible chat completion messages. */
export const OpenAiMessageRoleSchema = v.picklist(['assistant', 'system', 'user']);

/** Request message shape sent to an OpenAI-compatible endpoint. */
export const OpenAiMessageRequestSchema = v.object({
	role: OpenAiMessageRoleSchema,
	content: v.string()
});

/** Assistant or provider message returned by an OpenAI-compatible endpoint. */
export const OpenAiMessageSchema = v.object({
	role: OpenAiMessageRoleSchema,
	content: v.string(),
	reasoning: v.optional(v.string())
});

/** Request body sent to an OpenAI-compatible chat completion endpoint. */
export const OpenAiChatCompletionRequestSchema = v.object({
	model: v.optional(v.pipe(v.string(), v.minLength(1))),
	messages: v.array(OpenAiMessageRequestSchema)
});

/** Complete normalized response returned by a chat completion call. */
export const OpenAiChatCompletionResultSchema = v.object({
	message: OpenAiMessageSchema,
	finishReason: v.optional(v.string())
});

const OpenAiResponseMessageSchema = v.object({
	role: OpenAiMessageRoleSchema,
	content: v.nullable(v.string()),
	reasoning: v.optional(v.string()),
	reasoning_content: v.optional(v.string())
});

const OpenAiCompletionResponseSchema = v.object({
	choices: v.pipe(
		v.array(
			v.object({
				message: OpenAiResponseMessageSchema,
				finish_reason: v.optional(v.nullable(v.string()))
			})
		),
		v.minLength(1)
	)
});

/** Role accepted by an OpenAI-compatible chat completion message. */
export type OpenAiMessageRole = v.InferOutput<typeof OpenAiMessageRoleSchema>;
/** Request message sent to an OpenAI-compatible chat completion endpoint. */
export type OpenAiMessageRequest = v.InferOutput<typeof OpenAiMessageRequestSchema>;
/** Request body sent to an OpenAI-compatible chat completion endpoint. */
export type OpenAiChatCompletionRequest = v.InferOutput<typeof OpenAiChatCompletionRequestSchema>;
/** Complete normalized response returned by a chat completion call. */
export type OpenAiChatCompletionResult = v.InferOutput<typeof OpenAiChatCompletionResultSchema>;

/** Credentials and endpoint used for an OpenAI-compatible completion request. */
export type OpenAiCredentials = Pick<ProviderConfig, 'endpoint'> &
	Partial<Pick<ProviderConfig, 'apiKey' | 'model'>>;

/** Validated provider response for a non-streaming completion. */
type OpenAiCompletionResponse = v.InferOutput<typeof OpenAiCompletionResponseSchema>;

/** Represents a non-successful HTTP response from an OpenAI-compatible endpoint. */
export class OpenAiApiError extends AppError {
	readonly kind = 'openai_api';
	readonly status: number;

	/** Creates an OpenAI-compatible API error. */
	constructor(status: number, message: string, options?: ErrorOptions) {
		super(message, options);
		this.status = status;
	}
}

/** Represents a failure to connect to an OpenAI-compatible endpoint. */
export class OpenAiNetworkError extends AppError {
	readonly kind = 'openai_network';

	/** Creates an OpenAI-compatible network error. */
	constructor(options?: ErrorOptions) {
		super('OpenAI network request failed', options);
	}
}

/** Represents a request that exceeded the configured timeout. */
export class OpenAiTimeoutError extends AppError {
	readonly kind = 'openai_timeout';

	/** Creates an OpenAI-compatible timeout error. */
	constructor(options?: ErrorOptions) {
		super('OpenAI request timed out', options);
	}
}

/** Represents a successful HTTP response with invalid JSON or an invalid payload. */
export class OpenAiResponseError extends AppError {
	readonly kind = 'openai_response';

	/** Creates an invalid OpenAI-compatible response error. */
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

export async function completeOpenAiChat(
	credentials: OpenAiCredentials,
	messages: OpenAiMessageRequest[]
): Promise<OpenAiChatCompletionResult> {
	log.trace('completion enter', {
		model: credentials.model,
		messageCount: messages.length
	});

	const body = createOpenAiChatCompletionRequest(credentials, messages);
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetchCompletion(credentials, body, signal);
	} catch (cause: unknown) {
		throwTransportError(cause, signal);
	}

	if (!response.ok) {
		const error = await apiError(response);
		log.error('completion request failed', { err: error });
		throw error;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (cause: unknown) {
		if (cause instanceof SyntaxError) {
			const error = new OpenAiResponseError('OpenAI returned invalid JSON', { cause });
			log.error('completion response invalid', { err: error });
			throw error;
		}

		throwTransportError(cause, signal);
	}

	const parsed = v.safeParse(OpenAiCompletionResponseSchema, payload);
	if (!parsed.success) {
		const error = new OpenAiResponseError('OpenAI returned an invalid completion response');
		log.error('completion response invalid', { err: error });
		throw error;
	}

	return toCompletionResult(parsed.output);
}

/** Creates a validated OpenAI-compatible chat completion request. */
function createOpenAiChatCompletionRequest(
	config: Pick<OpenAiCredentials, 'model'>,
	messages: OpenAiMessageRequest[]
) {
	return v.parse(OpenAiChatCompletionRequestSchema, {
		...(config.model === undefined ? {} : { model: config.model }),
		messages
	});
}

/** Appends the chat completions path to a configured provider endpoint. */
function completionUrl(endpoint: string): string {
	return `${endpoint.replace(/\/$/, '')}/chat/completions`;
}

/** Creates authenticated JSON headers without exposing the API key to logs. */
function headers(apiKey: string | undefined): HeadersInit {
	return {
		'Content-Type': 'application/json',
		...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` })
	};
}

/** Sends a completion request with the common provider request settings. */
async function fetchCompletion(
	credentials: OpenAiCredentials,
	body: OpenAiChatCompletionRequest,
	signal: AbortSignal
): Promise<Response> {
	return fetch(completionUrl(credentials.endpoint), {
		method: 'POST',
		headers: headers(credentials.apiKey),
		body: JSON.stringify(body),
		signal
	});
}

/** Converts a transport failure into the matching timeout or network error. */
function throwTransportError(cause: unknown, signal: AbortSignal): never {
	const error = signal.aborted
		? new OpenAiTimeoutError({ cause })
		: new OpenAiNetworkError({ cause });
	log.error('completion transport failed', { err: error });
	throw error;
}

/** Converts a non-successful provider response into a typed API error. */
async function apiError(response: Response): Promise<OpenAiApiError> {
	let detail = '';
	try {
		const body: unknown = await response.json();
		if (typeof body === 'object' && body !== null && 'error' in body) {
			const error = body.error;
			if (
				typeof error === 'object' &&
				error !== null &&
				'message' in error &&
				typeof error.message === 'string'
			) {
				detail = `: ${error.message}`;
			}
		}
	} catch {
		// The status is sufficient when the provider does not return JSON.
	}
	return new OpenAiApiError(
		response.status,
		`OpenAI request failed with status ${response.status}${detail}`
	);
}

/** Converts a validated provider response into the application's response shape. */
function toCompletionResult(response: OpenAiCompletionResponse): OpenAiChatCompletionResult {
	const { message, finish_reason: finishReason } = response.choices[0];
	const reasoning = message.reasoning ?? message.reasoning_content;

	return {
		message: {
			role: message.role,
			content: message.content ?? '',
			...(reasoning === undefined ? {} : { reasoning })
		},
		...(finishReason === undefined || finishReason === null ? {} : { finishReason })
	};
}
