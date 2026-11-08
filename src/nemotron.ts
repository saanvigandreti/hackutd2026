import { z } from 'zod';

export const NVIDIA_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
export const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: 'function', function: {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  } };
}

const toolCallSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function').default('function'),
  /** Missing or blank arguments mean a call with no arguments. */
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(262_144).optional().transform(text => text?.trim() || '{}') }),
});

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().max(262_144).nullable().optional(),
      tool_calls: z.array(toolCallSchema).max(20).nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
    }),
  })).min(1).max(16),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    completion_tokens_details: z.object({ reasoning_tokens: z.number().nullable().optional() }).nullable().optional(),
  }).nullable().optional(),
});

const errorBodySchema = z.object({
  type: z.string().optional(), title: z.string().optional(), status: z.number().optional(),
  detail: z.string().optional(), requestId: z.string().optional(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

export function requireApiKey(apiKey: string): void {
  if (!apiKey.trim()) throw new Error('Set NVIDIA_API_KEY before requesting a live draft.');
}

export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error('The service response exceeded the size limit.');
  }
  if (!response.body) throw new Error('The service returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error('The service response exceeded the size limit.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('The service returned invalid JSON.'); }
}

export const REQUEST_TIMEOUT_MS = 150_000;

export interface CompletionTurn {
  message: AssistantMessage;
  finishReason: string | null;
  reasoning: string | null;
  reasoningField: 'reasoning_content' | 'reasoning' | null;
  usage: { promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null } | null;
  requestId: string | null;
}

/** Removes the key, bearer tokens and NVIDIA key-shaped strings, then bounds the text. */
export function redact(text: string, apiKey: string, maximum = 300): string {
  let clean = text;
  if (apiKey.trim()) clean = clean.split(apiKey.trim()).join('[redacted]');
  clean = clean.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/nvapi-[\w-]+/g, '[redacted]').replace(/\s+/g, ' ').trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
}

const requestIdPattern = /^[\w-]{1,100}$/;

async function providerError(response: Response, apiKey: string): Promise<Error> {
  let body: z.infer<typeof errorBodySchema> = {};
  try {
    const parsed = errorBodySchema.safeParse(await readBoundedJson(response, 16_384));
    if (parsed.success) body = parsed.data;
  } catch { await response.body?.cancel().catch(() => undefined); }
  const status = response.status;
  const base = status === 401 ? 'NVIDIA rejected the API key (HTTP 401). Check NVIDIA_API_KEY, then restart Ketchup.'
    : status === 403 ? 'NVIDIA refused this key (HTTP 403). Check that the key is active and that your account can use this model.'
    : status === 404 ? `The model ${NVIDIA_MODEL} is not available to this key (HTTP 404).`
    : status === 402 ? 'NVIDIA reports that this account has no remaining credits or needs billing attention (HTTP 402).'
    : status === 429 ? 'NVIDIA rate limit reached (HTTP 429). Wait a minute before starting another draft.'
    : status === 202 ? 'NVIDIA returned a pending request (HTTP 202). No draft was produced; try again later.'
    : status === 422 ? 'NVIDIA rejected the request as invalid (HTTP 422).'
    : `NVIDIA could not complete the request (HTTP ${status}).`;
  const said = [body.title, body.detail].filter((part): part is string => Boolean(part?.trim())).map(part => redact(part, apiKey, 200));
  const requestId = [response.headers.get('nvcf-reqid'), body.requestId].find(id => id && requestIdPattern.test(id) && redact(id, apiKey, 100) === id);
  return new Error(`${base}${said.length ? ` NVIDIA said: ${said.join(': ')}.` : ''}${requestId ? ` Request id: ${requestId}.` : ''}`);
}

/** Sends one nonstreaming request and returns the first choice without judging its finish reason beyond the documented set. */
/** Rate limits and gateway errors are retried with growing waits, honoring Retry-After. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('The NVIDIA request was cancelled or exceeded its time limit.')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('The NVIDIA request was cancelled or exceeded its time limit.')); }, { once: true });
  });
}

export async function requestCompletion(options: {
  apiKey: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<CompletionTurn> {
  requireApiKey(options.apiKey);
  options.signal?.throwIfAborted();
  let response: Response;
  let signal: AbortSignal;
  for (let attempt = 0; ; attempt++) {
    signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      response = await (options.fetchImpl ?? fetch)(NVIDIA_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages: options.messages,
          tools: options.tools,
          tool_choice: 'auto',
          temperature: 1,
          max_tokens: 12_288,
          reasoning_budget: 2_048,
          chat_template_kwargs: { enable_thinking: true },
          stream: false,
        }),
      });
    } catch {
      if (signal.aborted) throw new Error('The NVIDIA request was cancelled or exceeded its time limit.');
      if (attempt === 0) { await pause(RETRY_DELAYS_MS[0] ?? 0, options.signal); continue; }
      throw new Error('Could not reach NVIDIA. Check your network connection and try again.');
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) break;
    const retryHeader = response.headers.get('retry-after');
    const retryAfter = retryHeader === null ? Number.NaN : Number(retryHeader);
    await response.body?.cancel();
    await pause(Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 30_000) : RETRY_DELAYS_MS[attempt] ?? 0, options.signal);
  }
  if (response.status !== 200) throw await providerError(response, options.apiKey);
  const header = response.headers.get('nvcf-reqid');
  let payload: unknown;
  try { payload = await readBoundedJson(response, 1_048_576); }
  catch {
    if (signal.aborted) throw new Error('The NVIDIA response was cancelled or exceeded its time limit.');
    throw new Error('NVIDIA returned an unreadable or oversized response. No draft was accepted.');
  }
  const parsed = completionSchema.safeParse(payload);
  if (!parsed.success) throw new Error('NVIDIA returned an invalid completion. No draft was accepted.');
  const first = parsed.data.choices[0];
  if (!first) throw new Error('NVIDIA returned no completion.');
  const finishReason = first.finish_reason ?? null;
  const toolCalls = first.message.tool_calls?.length ? first.message.tool_calls : undefined;
  if (finishReason !== null && !toolCalls && !['stop', 'tool_calls', 'length'].includes(finishReason)) {
    throw new Error('NVIDIA stopped without a usable completion. No draft was accepted.');
  }
  const { usage } = parsed.data;
  const reasoningField = typeof first.message.reasoning_content === 'string' ? 'reasoning_content'
    : typeof first.message.reasoning === 'string' ? 'reasoning' : null;
  return {
    message: { role: 'assistant', content: first.message.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    finishReason,
    reasoning: reasoningField ? first.message[reasoningField] ?? null : null,
    reasoningField,
    usage: usage ? { promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null } : null,
    requestId: header && requestIdPattern.test(header) ? header : null,
  };
}

export async function complete(options: Parameters<typeof requestCompletion>[0]): Promise<AssistantMessage> {
  const turn = await requestCompletion(options);
  if (turn.finishReason === 'length') throw new Error('NVIDIA reached its output limit. The incomplete draft was rejected.');
  return turn.message;
}

/**
 * Decides how a tool-using loop continues after a turn: null when the turn carries tool calls,
 * otherwise the corrective messages to append. One prose reply and one truncated reply are retried; a repeat before
 * the next tool turn throws. A tool turn restores both retries.
 */
export function correctiveMessages(turn: CompletionTurn, budget: { prose: number; length: number }, finishTool: string): ChatMessage[] | null {
  if (turn.finishReason === 'length') {
    if (budget.length-- <= 0) throw new Error('NVIDIA reached its output limit twice. The incomplete draft was rejected.');
    return [{ role: 'user', content: 'Your last reply reached the output limit and was discarded. Think briefly, then reply with one tool call. Keep each edit to a small exact snippet.' }];
  }
  if (turn.message.tool_calls?.length) { budget.prose = 1; budget.length = 1; return null; }
  if (budget.prose-- <= 0) throw new Error(`Nemotron replied without a tool call after a reminder and ended without calling ${finishTool}. No result was accepted.`);
  return [
    { role: 'assistant', content: turn.message.content ?? '' },
    { role: 'user', content: `Your reply had no tool call. Ketchup only accepts work through the declared tools. Call the next tool now; to finish, call ${finishTool}.` },
  ];
}
