import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createApp } from '../src/server.ts';
import { NVIDIA_MODEL } from '../src/nemotron.ts';
import { listDemos } from '../src/demo.ts';
import { simulatedNvidia } from './support.ts';

test('full live-draft route completes against a real loopback NVIDIA protocol fixture', async () => {
  for (const demo of listDemos()) await liveDraft(demo.id);
});

async function liveDraft(demoId: string) {
  const remote = await simulatedNvidia(demoId);
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-protocol-'));
  const app = await createApp({ dataDirectory: directory, apiKey: 'local-fixture-only', fetchImpl: remote.fetchImpl });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const status = z.object({ csrfToken: z.string(), keyConfigured: z.literal(true), liveValidated: z.literal(false) }).parse(await (await fetch(`${base}/api/status`)).json());
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ketchup-Token': status.csrfToken }, body: JSON.stringify(body) });
    const workspace = z.object({ id: z.string() }).parse(await (await post('/api/demo', { id: demoId })).json());
    const start = await post(`/api/workspaces/${workspace.id}/draft`, { mode: 'nemotron' });
    assert.equal(start.status, 202);
    const jobId = z.object({ id: z.string() }).parse(await start.json()).id;
    const schema = z.object({ status: z.string(), error: z.string().optional(), events: z.array(z.object({ kind: z.string(), title: z.string() })), result: z.object({ origin: z.string(), model: z.string().optional(), report: z.object({ accepted: z.boolean(), resolvedCount: z.number() }), review: z.object({ origin: z.literal('nemotron'), summary: z.string(), risks: z.array(z.unknown()) }).nullable() }).optional() });
    let job = schema.parse(await (await fetch(`${base}/api/jobs/${jobId}`)).json());
    for (let attempt = 0; job.status === 'running' && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = schema.parse(await (await fetch(`${base}/api/jobs/${jobId}`)).json());
    }
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.result?.origin, 'nemotron');
    assert.equal(job.result?.model, NVIDIA_MODEL);
    assert.equal(job.result?.report.accepted, true);
    assert.ok((job.result?.report.resolvedCount ?? 0) >= 1);
    assert.deepEqual(job.result?.review, { origin: 'nemotron', ...remote.review });
    assert.deepEqual(job.events.filter((event) => event.kind === 'complete').map((event) => event.title), ['Draft ready for review'], demoId);
    remote.verify();
    const report = await (await fetch(`${base}/api/workspaces/${workspace.id}/export?format=report`)).text();
    assert.ok(report.includes(`Origin: NVIDIA Nemotron (${NVIDIA_MODEL}) draft, compiler-checked`));
    assert.ok(report.includes(`Behavior review by NVIDIA Nemotron (a model review, not a runtime test): ${remote.review.summary}`));
    assert.equal(report.includes('## Check it on your Prometheus'), demoId === 'northmark-gpu-alerts', demoId);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const saved = await readFile(path.join(directory, files[0] ?? ''), 'utf8');
    assert.equal(saved.includes('local-fixture-only'), false, 'The API credential must never enter persisted workspace data.');
    const statusText = await (await fetch(`${base}/api/status`)).text();
    assert.equal(statusText.includes('local-fixture-only'), false);
  } finally { await app.close(); await remote.close(); await rm(directory, { recursive: true, force: true }); }
}
