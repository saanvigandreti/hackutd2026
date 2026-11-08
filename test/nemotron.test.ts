import assert from 'node:assert/strict';
import test from 'node:test';
import { complete, correctiveMessages, NVIDIA_ENDPOINT, NVIDIA_MODEL, redact, requestCompletion, REQUEST_TIMEOUT_MS } from '../src/nemotron.ts';
import type { ToolCall } from '../src/nemotron.ts';
import { lookupPackage } from '../src/registry.ts';

const request = { apiKey: 'offline-dummy-key', messages: [{ role: 'user', content: 'Inspect the selected migration.' }], tools: [] } satisfies Parameters<typeof complete>[0];
const completion = (finishReason: string | null, message: unknown, extra: Record<string, unknown> = {}) => Response.json({
  choices: [{ finish_reason: finishReason, message }], ...extra,
});
const inspectCall: ToolCall = { id: 'c1', type: 'function', function: { name: 'inspect_migration', arguments: '{}' } };

test('simulated protocol: native tool response is parsed and sends the documented nonstreaming request', async () => {
  let sent: unknown;
  let authorization: string | null = null;
  const result = await complete({ ...request, fetchImpl: async (url, init) => {
    assert.equal(String(url), NVIDIA_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    authorization = new Headers(init?.headers).get('Authorization');
    sent = JSON.parse(String(init?.body));
    return completion('tool_calls', { role: 'assistant', content: null, tool_calls: [inspectCall] });
  } });
  assert.deepEqual(result, { role: 'assistant', content: null, tool_calls: [inspectCall] });
  assert.equal(authorization, 'Bearer offline-dummy-key');
  assert.deepEqual(sent, {
    model: NVIDIA_MODEL, messages: request.messages, tools: [], tool_choice: 'auto',
    temperature: 1, max_tokens: 12_288, reasoning_budget: 2_048,
    chat_template_kwargs: { enable_thinking: true }, stream: false,
  });
  assert.equal(REQUEST_TIMEOUT_MS, 150_000);
});

test('simulated protocol: null finish_reason with tool calls is a tool turn, and reasoning, usage and request id are read', async () => {
  const turn = await requestCompletion({ ...request, fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: null, reasoning_content: 'Inspect first.', tool_calls: [inspectCall] } }],
    usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } },
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'NVCF-REQID': '3fa85f64-5717-4562-b3fc-2c963f66afa6' } }) });
  assert.equal(turn.finishReason, null);
  assert.deepEqual(turn.message.tool_calls, [inspectCall]);
  assert.equal(turn.reasoningField, 'reasoning_content');
  assert.equal(turn.reasoning, 'Inspect first.');
  assert.deepEqual(turn.usage, { promptTokens: 10, completionTokens: 40, reasoningTokens: 30 });
  assert.equal(turn.requestId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  const prose = await requestCompletion({ ...request, fetchImpl: async () => completion(null, { role: 'assistant', content: 'Done.', reasoning: 'r' }) });
  assert.equal(prose.message.tool_calls, undefined);
  assert.equal(prose.reasoningField, 'reasoning');
});

test('missing credentials fail before network access', async () => {
  await assert.rejects(complete({ ...request, apiKey: ' ', fetchImpl: async () => {
    throw new Error('Network access must not happen');
  } }), /Set NVIDIA_API_KEY/);
});

test('simulated protocol: non-JSON provider error bodies are never exposed', async () => {
  for (const status of [202, 401, 403, 404, 402, 422, 429, 500]) {
    await assert.rejects(complete({ ...request, fetchImpl: async () => new Response('private-provider-body offline-dummy-key', { status, headers: { 'retry-after': '0' } }) }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-provider-body|offline-dummy-key/);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  }
});

test('simulated protocol: status codes map to key, model, account and rate-limit problems', async () => {
  const cases: [number, RegExp][] = [[401, /rejected the API key/], [403, /refused this key/], [404, /not available to this key/], [402, /credits or needs billing/], [429, /rate limit/]];
  for (const [status, pattern] of cases) {
    await assert.rejects(complete({ ...request, fetchImpl: async () => new Response(null, { status, headers: { 'retry-after': '0' } }) }), pattern);
  }
});

test('simulated protocol: documented error bodies surface a redacted, truncated title, detail and request id', async () => {
  const body = { type: 'urn:nvcf-worker-service:problem-details:unprocessable-entity', title: 'Unprocessable Entity', status: 422,
    detail: `Unsupported field tool_choice; Authorization: Bearer offline-dummy-key nvapi-abc_DEF-123 ${'x'.repeat(500)}`,
    instance: '/v2/nvcf/pexec/functions/abc', requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' };
  await assert.rejects(complete({ ...request, fetchImpl: async () => Response.json(body, { status: 422 }) }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 422\)\. NVIDIA said: Unprocessable Entity: Unsupported field tool_choice/);
    assert.match(error.message, /Request id: 3fa85f64-5717-4562-b3fc-2c963f66afa6\./);
    assert.doesNotMatch(error.message, /offline-dummy-key|nvapi-abc|x{250}/);
    return true;
  });
  await assert.rejects(complete({ ...request, fetchImpl: async () => new Response('{}', { status: 500, headers: { 'NVCF-REQID': 'req-1' } }) }), /HTTP 500\)\. Request id: req-1\.$/);
  assert.equal(redact('key offline-dummy-key', 'offline-dummy-key'), 'key [redacted]');
  for (const headers of [{ 'NVCF-REQID': 'offline-dummy-key' }, { 'NVCF-REQID': 'nvapi-abc' }]) {
    await assert.rejects(complete({ ...request, fetchImpl: async () => new Response('{}', { status: 500, headers }) }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /offline-dummy-key|nvapi-abc|Request id/);
      return true;
    });
  }
});

test('simulated protocol: tool calls without a type field or with an undocumented finish_reason still parse as a tool turn', async () => {
  const untyped = await requestCompletion({ ...request, fetchImpl: async () => completion('function_call', {
    role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'inspect_migration', arguments: '{}' } }],
  }) });
  assert.equal(untyped.finishReason, 'function_call');
  assert.deepEqual(untyped.message.tool_calls, [inspectCall]);
  for (const args of [{}, { arguments: '' }, { arguments: '  ' }]) {
    const bare = await requestCompletion({ ...request, fetchImpl: async () => completion('tool_calls', {
      role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect_migration', ...args } }],
    }) });
    assert.deepEqual(bare.message.tool_calls, [inspectCall], 'missing or blank arguments read as {}');
  }
});

test('network failures discard underlying exception text', async () => {
  await assert.rejects(complete({ ...request, fetchImpl: async () => {
    throw new Error('Authorization: Bearer offline-dummy-key');
  } }), { message: 'Could not reach NVIDIA. Check your network connection and try again.' });
});

test('simulated protocol: truncated output and malformed tool calls cannot become a patch', async () => {
  await assert.rejects(complete({ ...request, fetchImpl: async () => completion('length', {
    role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submit_patch', arguments: '{}' } }],
  }) }), /incomplete draft was rejected/);
  await assert.rejects(complete({ ...request, fetchImpl: async () => completion('tool_calls', {
    role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: { path: 'file.ts' } } }],
  }) }), /invalid completion/);
  await assert.rejects(complete({ ...request, fetchImpl: async () => completion('content_filter', { role: 'assistant', content: '' }) }), /without a usable completion/);
});

test('corrective messages retry one prose reply and one truncated reply, then fail', () => {
  const turn = (finishReason: string | null, toolCalls?: ToolCall[]) => ({ message: { role: 'assistant' as const, content: 'prose', ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    finishReason, reasoning: null, reasoningField: null, usage: null, requestId: null });
  const budget = { prose: 1, length: 1 };
  assert.equal(correctiveMessages(turn(null, [inspectCall]), budget, 'submit_patch'), null);
  assert.match(JSON.stringify(correctiveMessages(turn('stop'), budget, 'submit_patch')), /no tool call.*submit_patch/);
  assert.throws(() => correctiveMessages(turn('stop'), budget, 'submit_patch'), /without a tool call after a reminder/);
  assert.match(JSON.stringify(correctiveMessages(turn('length', [inspectCall]), budget, 'submit_patch')), /output limit/);
  assert.throws(() => correctiveMessages(turn('length'), budget, 'submit_patch'), /output limit twice/);
  const later = { prose: 1, length: 1 };
  assert.ok(correctiveMessages(turn('stop'), later, 'submit_patch'));
  assert.equal(correctiveMessages(turn('tool_calls', [inspectCall]), later, 'submit_patch'), null);
  assert.ok(correctiveMessages(turn('stop'), later, 'submit_patch'), 'a tool turn restores the reminder');
});

test('oversized and non-JSON response bodies fail closed', async () => {
  await assert.rejects(complete({ ...request, fetchImpl: async () => new Response('x'.repeat(1_048_577), { status: 200 }) }), /oversized response/);
  await assert.rejects(complete({ ...request, fetchImpl: async () => new Response('<html>private error</html>', { status: 200 }) }), /unreadable/);
});

test('inflight cancellation reaches the transport and exposes a safe error', async () => {
  const controller = new AbortController();
  const pending = complete({ ...request, signal: controller.signal, fetchImpl: async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('transport cancellation detail')), { once: true });
      controller.abort();
    });
  } });
  await assert.rejects(pending, { message: 'The NVIDIA request was cancelled or exceeded its time limit.' });
});

test('npm reads only fixed-host metadata and returns an exact version', async () => {
  const urls: string[] = [];
  const result = await lookupPackage('@example/sensor', '2.0.0', { fetchImpl: async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return Response.json({ name: '@example/sensor', version: urls.length === 1 ? '2.0.0' : '2.1.0', description: 'A sensor contract' });
  } });
  assert.deepEqual(urls, ['https://registry.npmjs.org/%40example%2Fsensor/2.0.0', 'https://registry.npmjs.org/%40example%2Fsensor/latest']);
  assert.deepEqual(result, { name: '@example/sensor', version: '2.0.0', latest: '2.1.0',
    description: 'A sensor contract', publishedAt: null, deprecated: null,
    source: 'https://registry.npmjs.org/%40example%2Fsensor/2.0.0' });
});

test('npm rejects arbitrary URLs, ranges, missing versions, and mismatched responses', async () => {
  for (const [name, version] of [['https://localhost/secret', '1.0.0'], ['sensor', '../../secret'], ['sensor', '^1.0.0']]) {
    await assert.rejects(lookupPackage(name ?? '', version ?? '', { fetchImpl: async () => { throw new Error('No request permitted'); } }), /exact semantic version/);
  }
  await assert.rejects(lookupPackage('sensor', '1.0.0', { fetchImpl: async () => new Response('private-body', { status: 404 }) }), /not found in the public npm registry/);
  await assert.rejects(lookupPackage('sensor', '1.0.0', { fetchImpl: async () => Response.json({ name: 'another-package', version: '1.0.0' }) }), /does not match/);
});

test('simulated protocol: a rate limit or gateway error is retried with Retry-After, then the completion is read', async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const turn = await requestCompletion({ ...request, fetchImpl: async () => ++calls === 1
      ? new Response('busy', { status, headers: { 'retry-after': '0' } })
      : completion('tool_calls', { role: 'assistant', content: null, tool_calls: [inspectCall] }) });
    assert.equal(calls, 2);
    assert.equal(turn.message.tool_calls?.[0]?.function.name, 'inspect_migration');
  }
});
