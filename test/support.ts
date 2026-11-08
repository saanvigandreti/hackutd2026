import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { demoBundle, rehearsalProposal } from '../src/demo.ts';
import { NVIDIA_ENDPOINT, NVIDIA_MODEL } from '../src/nemotron.ts';
import type { MigrationBundle } from '../src/types.ts';

export function smallBundle(): MigrationBundle {
  return {
    format: 1,
    name: 'Formatting helper upgrade',
    description: 'An independent test fixture: a positional prefix argument becomes an options object.',
    dependency: {
      name: 'label-kit',
      before: { version: '1.0.0', entry: 'index.d.ts', files: { 'index.d.ts': 'export declare function label(value: string, prefix: string): string;\n' } },
      after: { version: '2.0.0', entry: 'index.d.ts', files: { 'index.d.ts': 'export declare function label(value: string, options: { prefix: string }): string;\n' } },
    },
    sources: { 'src/label.ts': "import { label } from 'label-kit';\nexport const title = label('Cooling', 'Rack: ');\n" },
  };
}

const requestSchema = z.object({
  model: z.string(), stream: z.boolean(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable().optional(), tool_call_id: z.string().optional() })),
});

/** The loopback fixture drafts an example's reference repair (the default example unless `demoId` names another) and returns this
 * behavior review; local test data, not model output. */
export async function simulatedNvidia(demoId?: string) {
  const bundle = demoBundle(demoId);
  const proposal = rehearsalProposal(bundle);
  const edited = proposal.edits[0]?.path ?? '';
  const review = { summary: 'Local protocol fixture review.', risks: [{ file: edited, line: 1, concern: 'Local fixture concern: confirm the changed code still behaves the same at runtime.' }] };
  let requests = 0;
  let reviews = 0;
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const payload = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(payload.model, NVIDIA_MODEL);
      assert.equal(payload.stream, false);
      const call = (name: string, args: unknown, suffix = '') => ({ id: `local-${requests}-${reviews}-${name}${suffix}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const reply = (calls: unknown[]) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] }));
      };
      if (payload.tools.some((tool) => tool.function.name === 'submit_review')) {
        assert.deepEqual(payload.tools.map((tool) => tool.function.name), ['read_file', 'submit_review']);
        if (reviews++ > 0) throw new Error('The local fixture received an unexpected extra review request.');
        reply([call('submit_review', review)]); return;
      }
      assert.deepEqual(payload.tools.map((tool) => tool.function.name), ['inspect_migration', 'read_file', 'check_patch', ...(bundle.dependency.source ? [] : ['lookup_package']), 'submit_patch']);
      let calls: unknown[];
      switch (requests++) {
        case 0: calls = [call('inspect_migration', {})]; break;
        case 1: {
          const result = payload.messages.findLast((message) => message.role === 'tool');
          assert.ok(result?.content);
          assert.ok(result.content.includes(edited));
          calls = [call('read_file', { path: `source/${edited}` }, 'source'), call('read_file', { path: `before/${bundle.dependency.before.entry}` }, 'before'), call('read_file', { path: `after/${bundle.dependency.after.entry}` }, 'after')];
          break;
        }
        case 2: calls = [call('check_patch', { edits: proposal.edits })]; break;
        case 3: {
          const result = payload.messages.findLast((message) => message.role === 'tool');
          assert.ok(result?.content);
          assert.match(result.content, /"accepted":true/);
          calls = [call('submit_patch', proposal)]; break;
        }
        default: throw new Error('The local fixture received an unexpected extra model request.');
      }
      reply(calls);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'Local fixture failed');
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Local protocol fixture failed' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), NVIDIA_ENDPOINT, 'Only the documented model endpoint may be requested.');
    return fetch(endpoint, init);
  };
  return {
    fetchImpl, review,
    verify: () => { assert.deepEqual(failures, []); assert.equal(requests, 4); assert.equal(reviews, 1); },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
