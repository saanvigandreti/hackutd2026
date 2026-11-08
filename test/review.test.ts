import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBundle, checkPatch, validateBundle } from '../src/engine.ts';
import { NVIDIA_ENDPOINT } from '../src/nemotron.ts';
import { reviewPatch } from '../src/review.ts';
import type { AgentEvent, MigrationBundle } from '../src/types.ts';

const original = `import { readSensor } from 'sensor-sdk';\nexport const temperature = readSensor().temperature;\n`;
const bundle: MigrationBundle = validateBundle({
  format: 1, name: 'Sensor migration', description: 'A synthetic migration fixture.', intent: 'Report Celsius readings.',
  dependency: { name: 'sensor-sdk',
    before: { version: '1.0.0', entry: 'index.d.ts', files: { 'index.d.ts': 'export declare function readSensor(): { temperature: number };' } },
    after: { version: '2.0.0', entry: 'index.d.ts', files: { 'index.d.ts': 'export declare function readSensor(): { temperatureC: number };' } },
  }, sources: { 'monitor.ts': original },
});
const analysis = analyzeBundle(bundle);
const proposal = { edits: [{ path: 'monitor.ts', before: '.temperature;', after: '.temperatureC;' }], summary: 'Rename the field.', rationale: 'The new API names it temperatureC.' };
const report = checkPatch(bundle, proposal.edits);
type Call = { id: string; type: string; function: { name: string; arguments: string } };
const call = (id: string, name: string, args: unknown): Call => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function scripted(steps: Call[][], requests: { tools: { function: { name: string } }[]; messages: { role: string; content: string | null }[] }[] = []): typeof fetch {
  let index = 0;
  return async (url, init) => {
    assert.equal(String(url), NVIDIA_ENDPOINT);
    requests.push(JSON.parse(String(init?.body)));
    const step = steps[index++];
    assert.ok(step, 'The reviewer made an unexpected extra inference request');
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: step } }] });
  };
}
const review = (fetchImpl: typeof fetch, onEvent: (event: AgentEvent) => void = () => {}) =>
  reviewPatch({ bundle, analysis, proposal, report, apiKey: 'offline-dummy-key', fetchImpl, onEvent });

test('simulated protocol: the reviewer reads original and candidate code and returns risks', async () => {
  const events: AgentEvent[] = [];
  const requests: Parameters<typeof scripted>[1] = [];
  const result = await review(scripted([
    [call('a', 'read_file', { path: 'source/monitor.ts' }), call('b', 'read_file', { path: 'candidate/monitor.ts' })],
    [call('c', 'submit_review', { summary: 'Same reading, renamed field.', risks: [{ file: 'candidate/monitor.ts', line: null, concern: 'Check the unit stays Celsius.' }] })],
  ], requests), event => events.push(event));
  assert.deepEqual(result, { origin: 'nemotron', summary: 'Same reading, renamed field.', risks: [{ file: 'monitor.ts', line: null, concern: 'Check the unit stays Celsius.' }] });
  assert.deepEqual(requests[0]?.tools.map(tool => tool.function.name), ['read_file', 'submit_review']);
  assert.match(requests[0]?.messages[0]?.content ?? '', /dropped registrations.*changed defaults.*lost side effects.*units/s);
  assert.match(requests[0]?.messages[1]?.content ?? '', /Report Celsius readings\..*\+export const temperature = readSensor\(\)\.temperatureC;/s);
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /temperatureC/);
  assert.deepEqual(events.map(event => [event.kind, event.title]), [['review', 'Behavior review started'], ['plan', 'Reviewer asked to read 2 files'],
    ['review', 'Reviewer read monitor.ts'], ['review', 'Reviewer read the repaired monitor.ts'], ['review', 'Behavior review flagged 1 risk']]);
  assert.match(events.at(-1)?.detail ?? '', /^Same reading, renamed field\. A model's reading, not a test\.$/);
});

test('simulated protocol: the reviewer is read-only and cannot reach paths outside the migration', async () => {
  const requests: Parameters<typeof scripted>[1] = [];
  await assert.rejects(review(scripted([
    [call('a', 'submit_patch', proposal)],
    [call('b', 'read_file', { path: '/etc/passwd' })],
    [call('c', 'check_patch', { edits: proposal.edits })],
  ], requests)), /three invalid tool requests/);
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /read-only/);
  assert.match(requests[2]?.messages.at(-1)?.content ?? '', /not available to the reviewer/);
});

test('simulated protocol: risks must name a source file of this migration', async () => {
  const requests: Parameters<typeof scripted>[1] = [];
  const result = await review(scripted([
    [call('a', 'submit_review', { summary: 'x', risks: [{ file: 'elsewhere.ts', line: 1, concern: 'invented' }] })],
    [call('b', 'submit_review', { summary: 'No behavior difference found.', risks: [] })],
  ], requests));
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /elsewhere\.ts is not a source file/);
  assert.deepEqual(result.risks, []);
});

test('simulated protocol: the reviewer checks the repair against the description, intent and published contract source', async () => {
  const source = { kind: 'published-contract' as const, publisher: 'NVIDIA', url: 'https://github.com/NVIDIA/dcgm-exporter' };
  const requests: Parameters<typeof scripted>[1] = [];
  await reviewPatch({ bundle: { ...bundle, dependency: { ...bundle.dependency, source } }, analysis, proposal, report, apiKey: 'offline-dummy-key', onEvent: () => {},
    fetchImpl: scripted([[call('a', 'submit_review', { summary: 'No behavior difference found.', risks: [] })]], requests) });
  assert.match(requests[0]?.messages[0]?.content ?? '', /scenario description and the stated intent: each rule, registration, unit and configured limit/);
  const data = requests[0]?.messages[1]?.content ?? '';
  assert.match(data, /"description":"A synthetic migration fixture\."/);
  assert.match(data, /"source":\{"kind":"published-contract","publisher":"NVIDIA","url":"https:\/\/github\.com\/NVIDIA\/dcgm-exporter"\}/);
});

test('simulated protocol: each reviewer turn shows Nemotron\'s stated next move, so the live reason never goes stale', async () => {
  const events: AgentEvent[] = [];
  let index = 0;
  const steps = [
    { reasoning: 'The patch renames one field. I will compare the original monitor with the repaired one to confirm the unit.', calls: [call('a', 'read_file', { path: 'candidate/monitor.ts' })] },
    { reasoning: 'Both files read the same sensor in Celsius, so I will call submit_review with no risks.', calls: [call('b', 'submit_review', { summary: 'No behavior difference found.', risks: [] })] },
  ];
  await review(async () => {
    const step = steps[index++];
    assert.ok(step);
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: step.reasoning, tool_calls: step.calls } }] });
  }, event => events.push(event));
  assert.deepEqual(events.filter(event => event.kind === 'plan').map(event => [event.title, event.detail]), [
    ['Reviewer asked to read 1 file', 'I will compare the original monitor with the repaired one to confirm the unit.'],
    ['Reviewer submitted its verdict', 'Both files read the same sensor in Celsius, so I will call the submit tool with no risks.'],
  ]);
});
