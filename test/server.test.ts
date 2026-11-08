import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.ts';
import { demoBundle, listDemos, rehearsalProposal } from '../src/demo.ts';
import { checkPatch } from '../src/engine.ts';
import { MAX_WORKSPACES } from '../src/store.ts';
import type { DemoEvidence } from '../src/types.ts';
import { smallBundle } from './support.ts';

const statusSchema = z.object({ csrfToken: z.string(), keyConfigured: z.boolean(), liveValidated: z.literal(false) });
const workspaceSchema = z.object({ id: z.string().uuid(), demoAvailable: z.boolean(), analysis: z.object({ findings: z.array(z.unknown()) }), draft: z.unknown().nullable() });
const errorSchema = z.object({ error: z.string(), details: z.array(z.string()).optional(), action: z.string().optional() });
const jobSchema = z.object({ id: z.string(), status: z.enum(['running', 'failed', 'complete']), error: z.string().optional(), result: z.object({ origin: z.string(), report: z.object({ accepted: z.boolean(), diagnostics: z.array(z.unknown()), files: z.record(z.string()) }), demo: z.object({ kind: z.string(), candidateVerified: z.boolean(), checks: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'not-run']), detail: z.string() })), note: z.string(), sources: z.array(z.object({ label: z.string(), url: z.string().url() })), operator: z.object({ headline: z.string(), nextAction: z.string(), rows: z.array(z.object({ name: z.string(), rule: z.string().optional() })) }).nullable() }) }).optional() });

test('local API rehearses, exports an applicable patch and restores saved work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-http-'));
  const app = await createApp({ dataDirectory: path.join(directory, 'state') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const status = statusSchema.parse(await (await fetch(`${base}/api/status`)).json());
    assert.equal(status.keyConfigured, false);
    assert.equal(status.liveValidated, false);
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ketchup-Token': status.csrfToken, ...headers }, body: JSON.stringify(body),
    });
    const create = await post('/api/demo', {});
    assert.equal(create.status, 201);
    const workspace = workspaceSchema.parse(await create.json());
    assert.equal(workspace.demoAvailable, true);
    assert.ok(workspace.analysis.findings.length >= 1);
    const missingKey = await post(`/api/workspaces/${workspace.id}/draft`, { mode: 'nemotron' });
    assert.equal(missingKey.status, 409);
    assert.match(errorSchema.parse(await missingKey.json()).error, /NVIDIA_API_KEY to the \.env file in the Ketchup folder/);
    const start = await post(`/api/workspaces/${workspace.id}/draft`, { mode: 'rehearsal' });
    assert.equal(start.status, 202);
    const running = jobSchema.parse(await start.json());
    let job = jobSchema.parse(await (await fetch(`${base}/api/jobs/${running.id}`)).json());
    for (let attempt = 0; job.status === 'running' && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = jobSchema.parse(await (await fetch(`${base}/api/jobs/${running.id}`)).json());
    }
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.result?.origin, 'rehearsal');
    assert.equal(job.result?.report.accepted, true);
    assert.deepEqual(job.result?.report.diagnostics, []);
    assert.equal(job.result?.demo.candidateVerified, true);
    assert.equal(job.result?.demo.checks.some(check => check.status === 'failed'), false);
    const patchResponse = await fetch(`${base}/api/workspaces/${workspace.id}/export?format=patch`);
    const { dependency } = demoBundle();
    const patchFile = `ketchup-${dependency.name.replace(/^@/, '')}-${dependency.before.version}-to-${dependency.after.version}.patch`.replace(/[^a-zA-Z0-9._-]+/g, '-');
    assert.equal(patchResponse.headers.get('content-disposition'), `attachment; filename="${patchFile}"`);
    const patch = await patchResponse.text();
    assert.match(patch, /^diff --git a\//);
    const project = path.join(directory, 'original');
    for (const [filename, source] of Object.entries(demoBundle().sources)) {
      await mkdir(path.dirname(path.join(project, filename)), { recursive: true });
      await writeFile(path.join(project, filename), source);
    }
    execFileSync('git', ['apply', '--check', '-'], { cwd: project, input: patch });
    execFileSync('git', ['apply', '-'], { cwd: project, input: patch });
    for (const [filename, source] of Object.entries(job.result?.report.files ?? {})) assert.equal(await readFile(path.join(project, filename), 'utf8'), source);
    const report = await (await fetch(`${base}/api/workspaces/${workspace.id}/export?format=report`)).text();
    const demo = job.result?.demo;
    assert.ok(report.startsWith(`# Upgrade ${dependency.name} from ${dependency.before.version} to ${dependency.after.version}\n`));
    for (const heading of ['## Summary', '## Affected code', '## The repair', '## Apply it', '## Checks performed', '## Still to verify']) assert.ok(report.includes(`\n${heading}\n`), heading);
    assert.ok(report.includes(demoBundle().description));
    if (!demoBundle().dependency.source) assert.ok(report.includes(`npm install ${dependency.name}@${dependency.after.version}`));
    assert.ok(report.includes(`git apply ${patchFile}`));
    assert.match(report, /Origin: Ketchup reference repair, compiler-checked/);
    assert.match(report, /Compiler, repaired code on .*: passed/);
    assert.ok(report.includes(demo?.note ?? '(missing note)'));
    for (const check of demo?.checks ?? []) assert.ok(report.includes(`${check.status === 'passed' ? 'Passed' : 'Not run'}: ${check.name}. ${check.detail}`), check.name);
    for (const source of demo?.sources ?? []) assert.ok(report.includes(source.url));
    assert.equal(report.includes('## Operator handoff'), Boolean(demo?.operator));
    if (demo?.operator) assert.ok(report.includes(`Next action:\n\n${demo.operator.nextAction}`));
    assert.doesNotMatch(report, /RACK-B4|Usable readings/);
    assert.doesNotMatch(report, /protocol fixture|real-key run|\]\(\.{0,2}\/?docs\/|docs\/[a-z-]+\.md/);
    await app.close();
    const reopened = await createApp({ dataDirectory: path.join(directory, 'state') });
    try {
      assert.equal(reopened.store.list().length, 1);
      assert.equal(reopened.store.list()[0]?.draft?.origin, 'rehearsal');
      assert.equal(reopened.store.list()[0]?.draft?.report.accepted, true);
    } finally { await reopened.close(); }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP boundary rejects cross-site writes, invalid bundles, oversized requests and path traversal', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-boundary-'));
  const app = await createApp({ dataDirectory: directory });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const status = statusSchema.parse(await (await fetch(`${base}/api/status`)).json());
    const headers = { 'Content-Type': 'application/json', 'X-Ketchup-Token': status.csrfToken };
    const denied = await fetch(`${base}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const origin = await fetch(`${base}/api/demo`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{}' });
    assert.equal(origin.status, 403);
    const imported = demoBundle();
    imported.sources = { '../outside.ts': 'export const bad = true;' };
    const traversal = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify(imported) });
    assert.equal(traversal.status, 400);
    const traversalBody = errorSchema.parse(await traversal.json());
    assert.match(traversalBody.details?.join(' ') ?? '', /relative path/);
    assert.equal(traversalBody.action, 'bundle');
    const malformed = await fetch(`${base}/api/import`, { method: 'POST', headers, body: '{not json}' });
    assert.equal(malformed.status, 400);
    assert.equal(errorSchema.parse(await malformed.json()).action, 'bundle', 'an unreadable import offers the example bundle');
    const large = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify({ huge: 'x'.repeat(18 * 1024 * 1024) }) });
    assert.equal(large.status, 413);
    assert.match(errorSchema.parse(await large.json()).error, /4000 files, 1 MiB per file and 16 MiB in total/);
    const overOldLimit = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify({ format: 1, name: 'x'.repeat(900_000) }) });
    assert.equal(overOldLimit.status, 400, 'Bundles larger than 800 KB reach validation instead of being refused by size.');
    const invalid = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify({ format: 1, name: 'Partial bundle' }) });
    assert.equal(invalid.status, 400);
    const invalidBody = z.object({ error: z.string(), details: z.array(z.string()).min(1).max(6), action: z.literal('bundle') }).parse(await invalid.json());
    assert.equal(invalidBody.error, 'This file is not a valid Ketchup migration bundle. Download the example bundle to see the format.');
    assert.ok(invalidBody.details.includes('description is missing'), 'each detail names its field');
    assert.ok(invalidBody.details.every((detail) => !detail.includes('Invalid migration bundle') && !detail.includes('"code"')));
    const badId = await fetch(`${base}/api/workspaces/not-a-uuid/archive`, { method: 'POST', headers, body: '{}' });
    assert.equal(badId.status, 400);
    const files = await readdir(directory);
    assert.deepEqual(files, []);
    const outside = await fetch(`${base}/package.json`);
    assert.equal(outside.status, 404);
    assert.match(outside.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cancellation is refused after the atomic-save boundary begins', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-cancel-save-'));
  const app = await createApp({ dataDirectory: directory });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let release = () => {};
  let saving = () => {};
  const saveStarted = new Promise<void>((resolve) => { saving = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const status = statusSchema.parse(await (await fetch(`${base}/api/status`)).json());
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ketchup-Token': status.csrfToken }, body: JSON.stringify(body) });
    const workspace = workspaceSchema.parse(await (await post('/api/demo', {})).json());
    const originalSave = app.store.save.bind(app.store);
    app.store.save = async (item) => { if (item.draft) { saving(); await gate; } await originalSave(item); };
    const running = jobSchema.parse(await (await post(`/api/workspaces/${workspace.id}/draft`, { mode: 'rehearsal' })).json());
    await saveStarted;
    const cancel = await post(`/api/jobs/${running.id}/cancel`, {});
    assert.equal(cancel.status, 409);
    assert.match(await cancel.text(), /being saved/);
    release();
    let job = jobSchema.parse(await (await fetch(`${base}/api/jobs/${running.id}`)).json());
    for (let attempt = 0; job.status === 'running' && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = jobSchema.parse(await (await fetch(`${base}/api/jobs/${running.id}`)).json());
    }
    assert.equal(job.status, 'complete');
    assert.equal(app.store.items.get(workspace.id)?.draft?.origin, 'rehearsal');
  } finally { release(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('accepted cancellation prevents a live draft from replacing the workspace and preserves its trace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-cancel-request-'));
  let requested = () => {};
  const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
  const fetchImpl: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    requested();
    init?.signal?.addEventListener('abort', () => reject(new Error('Local fixture aborted')), { once: true });
  });
  const app = await createApp({ dataDirectory: directory, apiKey: 'local-fixture-only', fetchImpl });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const status = statusSchema.parse(await (await fetch(`${base}/api/status`)).json());
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ketchup-Token': status.csrfToken }, body: JSON.stringify(body) });
    const workspace = workspaceSchema.parse(await (await post('/api/demo', {})).json());
    const running = jobSchema.parse(await (await post(`/api/workspaces/${workspace.id}/draft`, { mode: 'nemotron' })).json());
    await requestStarted;
    const archiveWhileRunning = await post(`/api/workspaces/${workspace.id}/archive`, {});
    assert.equal(archiveWhileRunning.status, 409);
    assert.match(await archiveWhileRunning.text(), /running/);
    const cancel = await post(`/api/jobs/${running.id}/cancel`, {});
    assert.equal(cancel.status, 200);
    let job = jobSchema.parse(await (await fetch(`${base}/api/jobs/${running.id}`)).json());
    for (let attempt = 0; job.status === 'running' && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = jobSchema.parse(await (await fetch(`${base}/api/jobs/${running.id}`)).json());
    }
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /cancelled/);
    const saved = app.store.items.get(workspace.id);
    assert.equal(saved?.draft, null);
    assert.match(saved?.events.at(-1)?.detail ?? '', /cancelled/);
    const raw = await readFile(path.join(directory, `${workspace.id}.json`), 'utf8');
    assert.match(raw, /Migration cancelled/);
    assert.equal(raw.includes('local-fixture-only'), false);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

async function serve(app: Awaited<ReturnType<typeof createApp>>) {
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const statusText = await (await fetch(`${base}/api/status`)).text();
  const { csrfToken } = statusSchema.parse(JSON.parse(statusText));
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ketchup-Token': csrfToken, ...headers }, body: JSON.stringify(body),
  });
  return { base, post, statusText };
}

const fullWorkspace = workspaceSchema.extend({ bundle: z.object({ name: z.string() }), updatedAt: z.string(), demoId: z.string().nullable() });

test('examples open without duplicates, list by recency and archive reversibly at capacity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-archive-'));
  const app = await createApp({ dataDirectory: directory, apiKey: 'local-fixture-only' });
  try {
    const { base, post, statusText } = await serve(app);
    assert.equal(statusText.includes('local-fixture-only'), false);
    const demoList = z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })).min(1);
    const demos = z.object({ demos: demoList }).parse(await (await fetch(`${base}/api/demos`)).json()).demos;
    assert.deepEqual(z.object({ demos: demoList }).parse(JSON.parse(statusText)).demos, demos);
    const opened = new Map<string, string>();
    for (const demo of demos) {
      const first = await post('/api/demo', { id: demo.id });
      assert.equal(first.status, 201);
      const workspace = fullWorkspace.parse(await first.json());
      assert.equal(workspace.demoAvailable, true);
      assert.equal(workspace.demoId, demo.id);
      const again = await post('/api/demo', { id: demo.id });
      assert.equal(again.status, 200);
      assert.equal(fullWorkspace.parse(await again.json()).id, workspace.id);
      opened.set(demo.id, workspace.id);
    }
    const fallback = await post('/api/demo', {});
    assert.equal(fallback.status, 200);
    assert.ok([...opened.values()].includes(fullWorkspace.parse(await fallback.json()).id));
    const missing = await post('/api/demo', { id: 'no-such-example' });
    assert.equal(missing.status, 404);
    assert.equal(errorSchema.parse(await missing.json()).error, 'This example was not found.');

    const firstDemo = demos[0];
    assert.ok(firstDemo);
    const draftedId = opened.get(firstDemo.id) ?? '';
    const job = jobSchema.parse(await (await post(`/api/workspaces/${draftedId}/draft`, { mode: 'rehearsal' })).json());
    let state = jobSchema.parse(await (await fetch(`${base}/api/jobs/${job.id}`)).json());
    for (let attempt = 0; state.status === 'running' && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = jobSchema.parse(await (await fetch(`${base}/api/jobs/${job.id}`)).json());
    }
    assert.equal(state.status, 'complete', state.error);
    const listed = z.object({ workspaces: z.array(fullWorkspace) }).parse(await (await fetch(`${base}/api/workspaces`)).json()).workspaces;
    assert.equal(listed[0]?.id, draftedId, 'The most recently updated project comes first.');
    assert.deepEqual(listed.map((item) => item.updatedAt), listed.map((item) => item.updatedAt).sort().reverse());
    const copy = await post('/api/demo', { id: firstDemo.id });
    assert.equal(copy.status, 201);
    const copied = fullWorkspace.parse(await copy.json());
    assert.notEqual(copied.id, draftedId);
    assert.equal(copied.demoAvailable, true);
    assert.equal(copied.bundle.name, `${listed[0]?.bundle.name} (2)`, 'A second copy of a drafted example gets a numbered name.');
    assert.equal(copied.demoId, firstDemo.id, 'The workspace names the example it came from.');
    assert.equal(fullWorkspace.parse(await (await post('/api/demo', { id: firstDemo.id })).json()).id, copied.id);

    const template = app.store.items.get(copied.id);
    assert.ok(template);
    const placeholders: string[] = [];
    while (app.store.items.size < MAX_WORKSPACES) {
      const id = randomUUID();
      placeholders.push(id);
      app.store.items.set(id, { ...template, id });
    }
    const full = await post('/api/import', smallBundle());
    assert.equal(full.status, 409);
    const fullBody = errorSchema.parse(await full.json());
    assert.equal(fullBody.action, 'archive');
    assert.match(fullBody.error, /Archive a project/);

    assert.equal((await fetch(`${base}/api/workspaces/${draftedId}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const archived = await post(`/api/workspaces/${draftedId}/archive`, {});
    assert.equal(archived.status, 200);
    assert.deepEqual(await readdir(path.join(directory, 'archive')), [`${draftedId}.json`]);
    assert.equal((await readdir(directory)).includes(`${draftedId}.json`), false);
    assert.equal((await fetch(`${base}/api/workspaces/${draftedId}`)).status, 404);
    const archiveList = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), dependency: z.string(), from: z.string(), to: z.string(), drafted: z.boolean(), updatedAt: z.string() })) });
    const shelf = archiveList.parse(await (await fetch(`${base}/api/archive`)).json()).projects;
    assert.deepEqual(shelf.map((item) => [item.id, item.drafted]), [[draftedId, true]]);

    assert.equal((await post('/api/import', smallBundle())).status, 201);
    const blocked = await post(`/api/archive/${draftedId}/restore`, {});
    assert.equal(blocked.status, 409);
    assert.equal(errorSchema.parse(await blocked.json()).action, 'archive');
    app.store.items.delete(placeholders.pop() ?? '');
    const restored = await post(`/api/archive/${draftedId}/restore`, {});
    assert.equal(restored.status, 200);
    const back = z.object({ id: z.string(), draft: z.object({ origin: z.literal('rehearsal'), report: z.object({ accepted: z.literal(true) }) }) }).parse(await restored.json());
    assert.equal(back.id, draftedId);
    assert.deepEqual(await readdir(path.join(directory, 'archive')), []);
    assert.equal((await post(`/api/archive/${draftedId}/restore`, {})).status, 409);
    assert.equal((await post(`/api/archive/${randomUUID()}/restore`, {})).status, 409);
    for (const id of placeholders) app.store.items.delete(id);
    assert.equal(errorSchema.parse(await (await post(`/api/archive/${randomUUID()}/restore`, {})).json()).error, 'This archived project was not found.');

    await app.close();
    const reopened = await createApp({ dataDirectory: directory });
    try {
      const ids = reopened.store.list().map((item) => item.id);
      assert.equal(ids.length, demos.length + 2);
      assert.ok(ids.includes(draftedId));
      assert.deepEqual(reopened.store.list().map((item) => item.updatedAt), reopened.store.list().map((item) => item.updatedAt ?? '').sort().reverse());
    } finally { await reopened.close(); }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('project intake validates folders, prepares a workspace and reports a project with no draft', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-intake-'));
  const project = path.join(directory, 'service');
  await mkdir(project);
  await writeFile(path.join(project, 'package.json'), '{}');
  const state = path.join(directory, 'state');
  const inspected: string[] = [];
  const prepared: { root: string; dependency: string; targetVersion: string; cacheDirectory: string; signal?: AbortSignal }[] = [];
  const app = await createApp({
    dataDirectory: state,
    inspectProject: async (root) => { inspected.push(root); return { folder: 'service', dependencies: [{ name: 'label-kit', range: '^1.0.0', installed: '1.0.0', imported: true, dev: false, latest: null }], sourceCount: 1 }; },
    prepareProject: async (input) => {
      prepared.push(input);
      if (input.dependency === 'missing-kit') throw new Error('missing-kit is not listed in package.json.');
      return smallBundle();
    },
  });
  try {
    const { base, post } = await serve(app);
    const inspect = (query: string) => fetch(`${base}/api/projects/inspect${query}`);
    for (const [query, message] of [
      ['', 'Enter the full path to a project folder.'],
      ['?path=service', 'Use the absolute path to the project folder.'],
      [`?path=${encodeURIComponent(path.join(directory, 'absent'))}`, 'That folder does not exist on this computer.'],
      [`?path=${encodeURIComponent(path.join(project, 'package.json'))}`, 'That path is a file. Choose the project folder that contains package.json.'],
    ] as const) {
      const response = await inspect(query);
      assert.equal(response.status, 400);
      assert.equal(errorSchema.parse(await response.json()).error, message);
    }
    const crossSite = await fetch(`${base}/api/projects/inspect?path=${encodeURIComponent(project)}`, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(crossSite.status, 403);
    const found = await inspect(`?path=${encodeURIComponent(project + path.sep)}`);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { folder: 'service', dependencies: [{ name: 'label-kit', range: '^1.0.0', installed: '1.0.0', imported: true, dev: false, latest: null }], sourceCount: 1 });
    assert.deepEqual(inspected, [project]);

    const request = { path: project, dependency: 'label-kit', version: '2.0.0' };
    assert.equal((await fetch(`${base}/api/projects/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 403);
    const extra = await post('/api/projects/prepare', { ...request, script: 'postinstall' });
    assert.equal(extra.status, 400);
    const extraBody = errorSchema.parse(await extra.json());
    assert.equal(extraBody.error, 'The request was not in the expected form.');
    assert.ok(extraBody.details?.length);
    const notListed = await post('/api/projects/prepare', { ...request, dependency: 'missing-kit' });
    assert.equal(notListed.status, 400);
    assert.equal(errorSchema.parse(await notListed.json()).error, 'missing-kit is not listed in package.json.');
    assert.equal(app.store.items.size, 0);
    const created = await post('/api/projects/prepare', request);
    assert.equal(created.status, 201);
    const workspace = fullWorkspace.parse(await created.json());
    assert.equal(workspace.bundle.name, smallBundle().name);
    assert.equal(workspace.demoAvailable, false);
    assert.ok(workspace.analysis.findings.length >= 1);
    const last = prepared.at(-1);
    assert.deepEqual({ root: last?.root, dependency: last?.dependency, targetVersion: last?.targetVersion }, { root: project, dependency: 'label-kit', targetVersion: '2.0.0' });
    assert.equal(last?.cacheDirectory, path.join(state, 'cache'), 'The registry adds its own npm folder inside the cache.');
    assert.ok(last?.signal instanceof AbortSignal);

    assert.equal((await fetch(`${base}/api/workspaces/${workspace.id}/export?format=patch`)).status, 409);
    const report = await (await fetch(`${base}/api/workspaces/${workspace.id}/export?format=report`)).text();
    assert.ok(report.startsWith('# Upgrade label-kit from 1.0.0 to 2.0.0\n'));
    assert.match(report, /No repair has been drafted yet\./);
    assert.ok(report.includes(smallBundle().description));
    assert.match(report, /`src\/label\.ts:2`/);
    assert.doesNotMatch(report, /## Apply it|## The repair|npm install|git apply/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the handoff states a Nemotron draft precisely and renders the operator table, review and sources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-handoff-'));
  const app = await createApp({ dataDirectory: directory });
  try {
    const { base, post } = await serve(app);
    const { id } = workspaceSchema.parse(await (await post('/api/demo', {})).json());
    const workspace = app.store.items.get(id);
    assert.ok(workspace);
    const proposal = rehearsalProposal(workspace.bundle);
    const report = checkPatch(workspace.bundle, proposal.edits);
    const edited = proposal.edits[0]?.path ?? '';
    const demo: DemoEvidence = {
      kind: 'test-fixture', candidateVerified: false, note: 'Test fixture note.',
      checks: [{ name: 'Fixture scenario', status: 'failed', detail: 'Fixture detail.' }],
      operator: { headline: 'Fixture headline.', rows: [{ name: 'fixture_field', meaning: 'fixture meaning', original: 'missing | no alert', repaired: 'present' }], nextAction: 'Fixture next action.' },
      sources: [{ label: 'Fixture source', url: 'https://example.com/fixture-source' }],
    };
    await app.store.save({ ...workspace, draft: { origin: 'nemotron', model: 'nvidia/recorded-model', proposal, report, demo, review: { origin: 'nemotron', summary: 'Fixture review.', risks: [{ file: edited, line: null, concern: 'Fixture concern.' }] } } });
    const text = await (await fetch(`${base}/api/workspaces/${id}/export?format=report`)).text();
    for (const expected of [
      '- Origin: NVIDIA Nemotron (nvidia/recorded-model) draft, compiler-checked',
      '- Failed: Fixture scenario. Fixture detail.',
      '- Behavior review by NVIDIA Nemotron (a model review, not a runtime test): Fixture review.',
      `  - \`${edited}\`: Fixture concern.`,
      '- Test fixture note.',
      '## Operator handoff\n\nFixture headline.\n\nAn alert whose rule cannot fire means on-call gets no alert for that condition.\n\n| Alert | Original code | Repaired code |\n| --- | --- | --- |\n| fixture_field | missing \\| no alert | present |\n\nNext action:\n\nFixture next action.',
      '- Fixture source: https://example.com/fixture-source',
    ]) assert.ok(text.includes(expected), expected);
    assert.ok(text.includes('The patch is not available for download because the repair failed a scenario check: Fixture scenario. Draft the repair again before applying it.'));
    assert.ok(text.indexOf('\n## Operator handoff\n') < text.indexOf('\n## Affected code\n'), 'the operator consequence comes before the compiler detail');
    assert.doesNotMatch(text, /git apply/);
    assert.equal((await fetch(`${base}/api/workspaces/${id}/export?format=patch`)).status, 409, 'a failed scenario check blocks the patch even though it compiles');
    const saved = app.store.items.get(id);
    assert.ok(saved?.draft);
    await app.store.save({ ...saved, draft: { ...saved.draft, review: null } });
    const unreviewed = await (await fetch(`${base}/api/workspaces/${id}/export?format=report`)).text();
    assert.ok(unreviewed.includes('- Behavior review by NVIDIA Nemotron: none was recorded for this draft. Review the changed behavior yourself.'));
    await app.store.save({ ...saved, draft: { ...saved.draft } });
    const reopened = await createApp({ dataDirectory: directory });
    try { assert.equal(reopened.store.items.get(id)?.draft?.model, 'nvidia/recorded-model', 'The drafting model is saved with the draft.'); }
    finally { await reopened.close(); }
    const unrecorded = app.store.items.get(id);
    assert.ok(unrecorded?.draft);
    await app.store.save({ ...unrecorded, draft: { origin: 'nemotron', proposal: unrecorded.draft.proposal, report: unrecorded.draft.report, demo: null } });
    const legacy = await (await fetch(`${base}/api/workspaces/${id}/export?format=report`)).text();
    assert.ok(legacy.includes('- Origin: NVIDIA Nemotron draft, compiler-checked\n'), 'A draft saved without its model does not claim one.');
    assert.equal((await fetch(`${base}/api/workspaces/${id}/export?format=patch`)).status, 200);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('simultaneous archive and restore requests move the file once and answer in plain words', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-race-'));
  const app = await createApp({ dataDirectory: directory });
  try {
    const { post } = await serve(app);
    const { id } = workspaceSchema.parse(await (await post('/api/demo', {})).json());
    const archived = await Promise.all([post(`/api/workspaces/${id}/archive`, {}), post(`/api/workspaces/${id}/archive`, {})]);
    assert.deepEqual(archived.map((response) => response.status === 200), archived[0]?.status === 200 ? [true, false] : [false, true]);
    assert.ok(archived.every((response) => [200, 400, 404].includes(response.status)));
    const restored = await Promise.all([post(`/api/archive/${id}/restore`, {}), post(`/api/archive/${id}/restore`, {})]);
    assert.equal(restored.filter((response) => response.status === 200).length, 1);
    assert.ok(restored.every((response) => [200, 400, 409].includes(response.status)));
    for (const response of [...archived, ...restored].filter((item) => item.status !== 200)) {
      assert.match(errorSchema.parse(await response.json()).error, /^This (workspace was not found|project is already open)\.$/);
    }
    assert.ok(app.store.items.has(id));
    assert.ok((await readdir(directory)).includes(`${id}.json`));
    assert.deepEqual(await readdir(path.join(directory, 'archive')), []);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

async function rehearse(base: string, post: (route: string, body: unknown) => Promise<Response>, demoId: string) {
  const workspace = workspaceSchema.parse(await (await post('/api/demo', { id: demoId })).json());
  const job = jobSchema.parse(await (await post(`/api/workspaces/${workspace.id}/draft`, { mode: 'rehearsal' })).json());
  let state = jobSchema.parse(await (await fetch(`${base}/api/jobs/${job.id}`)).json());
  for (let attempt = 0; state.status === 'running' && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = jobSchema.parse(await (await fetch(`${base}/api/jobs/${job.id}`)).json());
  }
  assert.equal(state.status, 'complete', state.error);
  const events = z.object({ events: z.array(z.object({ kind: z.string(), title: z.string() })) }).parse(await (await fetch(`${base}/api/jobs/${job.id}`)).json()).events;
  const report = await (await fetch(`${base}/api/workspaces/${workspace.id}/export?format=report`)).text();
  return { demo: state.result?.demo, events, report };
}

test('both examples rehearse; only the GPU alert handoff names Prometheus checks, once, right after the summary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-promql-'));
  const app = await createApp({ dataDirectory: directory, env: {} });
  try {
    const { base, post } = await serve(app);
    const ids = listDemos().map((demo) => demo.id);
    assert.deepEqual(ids, ['northmark-gpu-alerts', 'opentelemetry-metrics']);
    const gpu = await rehearse(base, post, 'northmark-gpu-alerts');
    const otel = await rehearse(base, post, 'opentelemetry-metrics');
    for (const run of [gpu, otel]) {
      assert.deepEqual(run.events.filter((event) => event.kind === 'complete').map((event) => event.title), ['Ready for review']);
      assert.ok(run.events.some((event) => event.title === 'Reference repair check'));
      assert.doesNotMatch(run.report, /synthetic|fake|mock|simulated|rehearsal/i);
      assert.equal(run.demo?.checks.find((check) => check.name === 'Matches the reference repair')?.status, 'not-run');
      assert.doesNotMatch(run.report, /Review note/, 'every reference edit sits at a finding or API change');
    }
    const nextAction = gpu.demo?.operator?.nextAction ?? '';
    const watched = [...nextAction.matchAll(/count\(([A-Z0-9_]+)\)/g)].map((match) => match[1]);
    const guard = /absent\(([A-Z0-9_]+)\)/.exec(nextAction)?.[1];
    assert.ok(watched.length >= 1 && guard);
    const section = gpu.report.slice(gpu.report.indexOf('\n## Check it on your Prometheus\n'));
    assert.ok(section.startsWith('\n## Check it on your Prometheus\n\nKetchup did not query any Prometheus server for this report.'));
    for (const query of [...watched.map((metric) => `count(${metric})`), `absent(${guard})`]) {
      assert.equal(gpu.report.split(query).length - 1, 1, `${query} appears once, in the next action from the scenario evidence`);
    }
    const order = ['## Summary', '## Operator handoff', '## Check it on your Prometheus', '## Affected code', '## Sources'].map((heading) => gpu.report.indexOf(`\n${heading}\n`));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'the operator consequence comes right after the summary');
    assert.ok(order.every((index) => index > 0));
    assert.equal(otel.demo?.operator, null);
    assert.doesNotMatch(otel.report, /## Check it on your Prometheus|count\(|absent\(/);
    assert.ok(gpu.report.includes('| Alert | Original code | Repaired code |'));
    assert.equal(gpu.report.match(/on-call gets no/gi)?.length, 1, 'the consequence is stated once');
    for (const row of gpu.demo?.operator?.rows ?? []) assert.ok(gpu.report.includes(`| ${row.rule}: ${row.name} |`), `${row.rule} is named in its row`);
    for (const named of [...(gpu.demo?.operator?.nextAction.split('\n')[1] ?? '').matchAll(/(\w+): /g)].map((match) => match[1])) assert.ok(gpu.report.includes(`| ${named}: `), `${named} from the next action has a row`);
    assert.ok(gpu.report.includes('| GpuIdle | `DCGM_FI_DEV_GPU_UTIL below percent(limits.idleUtilizationPercent)` | `DCGM_FI_DEV_GPU_UTIL_RATIO below ratio(limits.idleUtilizationPercent / 100)` |'));
    assert.match(gpu.report, /- `src\/gpu-alerts\.ts:23` GpuBoardPowerHigh never fires: [^\n]+\. Compiler: Type '"DCGM_FI_DEV_POWER_USAGE"' is not assignable to type 'MetricName'\. \(TS2322\)/);
    assert.match(gpu.report, /`mebibytes` is a unit helper in the contract Ketchup generates, not part of NVIDIA's API/);
    assert.ok(gpu.report.includes("dcgm-exporter is a TypeScript contract Ketchup generates from NVIDIA's published default-counters.csv, not an npm package."));
    assert.doesNotMatch(gpu.report, /published by NVIDIA|contract published by/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('errors caused by leaving out @types/node are listed as left out of the analysis, not as the project\'s own errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-node-types-'));
  const app = await createApp({ dataDirectory: directory, env: {} });
  try {
    const { base } = await serve(app);
    const bundle = smallBundle();
    const omitted = '@types/node: src/label.test.ts imports Node.js built-in modules; @types/node is not included, so those imports stay unresolved on both versions';
    bundle.origin = { kind: 'project', folder: 'service', declarationSources: { before: 'installed', after: 'npm' }, omitted: [omitted] };
    bundle.sources['src/label.test.ts'] = "import test from 'node:test';\nexport const named = test.name;\n";
    const workspace = await app.store.create(bundle);
    assert.ok(workspace.analysis.baseline.some((item) => item.message.includes("Cannot find module 'node:test'")));
    const edits = [{ path: 'src/label.ts', before: "label('Cooling', 'Rack: ')", after: "label('Cooling', { prefix: 'Rack: ' })" }];
    await app.store.save({ ...workspace, draft: { origin: 'nemotron', proposal: { summary: 'Use options.', rationale: 'The prefix moved.', edits }, report: checkPatch(workspace.bundle, edits), demo: null, review: null } });
    const report = await (await fetch(`${base}/api/workspaces/${workspace.id}/export?format=report`)).text();
    const section = report.slice(report.indexOf('\n## Left out of the analysis\n'), report.indexOf('\n## Update the dependency\n'));
    assert.ok(section.includes(`- ${omitted}`));
    assert.match(section, /Because @types\/node is left out, the original code has 1 compiler error such as "Cannot find module 'node:test'/);
    assert.doesNotMatch(report, /Errors that existed before the upgrade/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the Prometheus connector is off by default and runs only on a confirmed request to the configured host', async () => {
  const series = await readFile(new URL('fixtures/prometheus/series-example.json', import.meta.url));
  const seen: string[] = [];
  let answer = (response: import('node:http').ServerResponse) => { response.writeHead(200, { 'Content-Type': 'application/json' }).end(series); };
  const prometheus = createServer((request, response) => { seen.push(`${request.method} ${request.url}`); answer(response); });
  await new Promise<void>((resolve) => prometheus.listen(0, '127.0.0.1', resolve));
  const promAddress = prometheus.address();
  assert.ok(promAddress && typeof promAddress !== 'string');
  const host = `127.0.0.1:${promAddress.port}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-connector-'));
  const connectorSchema = z.object({ prometheus: z.object({ configured: z.boolean(), host: z.string().nullable() }) });
  const off = await createApp({ dataDirectory: path.join(directory, 'off'), env: {} });
  const misconfigured = await createApp({ dataDirectory: path.join(directory, 'bad'), env: { KETCHUP_PROMETHEUS_URL: `http://${host}/?token=x` } });
  const on = await createApp({ dataDirectory: path.join(directory, 'on'), env: { KETCHUP_PROMETHEUS_URL: `http://${host}/` } });
  try {
    const offApi = await serve(off);
    assert.deepEqual(connectorSchema.parse(await (await fetch(`${offApi.base}/api/connectors`)).json()), { prometheus: { configured: false, host: null } });
    const notConfigured = await offApi.post('/api/connectors/prometheus/check', { names: ['up'], confirmHost: host });
    assert.equal(notConfigured.status, 409);
    assert.equal(errorSchema.parse(await notConfigured.json()).error, 'Prometheus is not configured. Set KETCHUP_PROMETHEUS_URL to check your own server.');

    const badApi = await serve(misconfigured);
    assert.deepEqual(connectorSchema.parse(await (await fetch(`${badApi.base}/api/connectors`)).json()).prometheus, { configured: false, host: null });
    const unusable = await badApi.post('/api/connectors/prometheus/check', { names: ['up'], confirmHost: host });
    assert.equal(unusable.status, 409);
    assert.match(errorSchema.parse(await unusable.json()).error, /is set but Ketchup cannot use it/);

    const onApi = await serve(on);
    assert.deepEqual(connectorSchema.parse(await (await fetch(`${onApi.base}/api/connectors`)).json()), { prometheus: { configured: true, host } });
    assert.equal(seen.length, 0, 'Starting Ketchup and reading the connector status send nothing to Prometheus.');
    const tokenless = await fetch(`${onApi.base}/api/connectors/prometheus/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['up'], confirmHost: host }) });
    assert.equal(tokenless.status, 403);
    const unconfirmed = await onApi.post('/api/connectors/prometheus/check', { names: ['up'], confirmHost: 'prometheus.example.invalid:9090' });
    assert.equal(unconfirmed.status, 409);
    assert.equal(errorSchema.parse(await unconfirmed.json()).error, `Confirm the host ${host} before Ketchup contacts it.`);
    const missingConfirmation = await onApi.post('/api/connectors/prometheus/check', { names: ['up'] });
    assert.equal(missingConfirmation.status, 400);
    const badName = await onApi.post('/api/connectors/prometheus/check', { names: ['up{job="x"}'], confirmHost: host });
    assert.equal(badName.status, 400);
    assert.match(JSON.stringify(await badName.json()), /is not a Prometheus metric name/);
    assert.equal((await onApi.post('/api/connectors/prometheus/check', { names: Array.from({ length: 51 }, (_item, index) => `m${index}`), confirmHost: host })).status, 400);
    assert.equal(seen.length, 0, 'Refused checks send nothing to Prometheus.');

    const checked = await onApi.post('/api/connectors/prometheus/check', { names: ['up', 'DCGM_FI_DEV_GPU_TEMP_CELSIUS'], confirmHost: host });
    assert.equal(checked.status, 200);
    const body = z.object({ host: z.string(), checkedAt: z.string(), windowSeconds: z.number(), metrics: z.array(z.object({ name: z.string(), present: z.boolean(), seriesCount: z.number(), capped: z.boolean() })) }).parse(await checked.json());
    assert.equal(body.host, host);
    assert.deepEqual(body.metrics.map((metric) => [metric.name, metric.present, metric.seriesCount]), [['up', true, 2], ['DCGM_FI_DEV_GPU_TEMP_CELSIUS', false, 0]]);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((line) => line.startsWith('GET /api/v1/series?match%5B%5D=')));

    answer = (response) => { response.writeHead(500, { 'Content-Type': 'text/plain' }).end('internal detail that must not be shown'); };
    const failed = await onApi.post('/api/connectors/prometheus/check', { names: ['up'], confirmHost: host });
    assert.equal(failed.status, 502);
    const failedText = await failed.text();
    assert.match(failedText, new RegExp(`Prometheus at ${host.replace(/\./g, '\\.')} returned HTTP 500`));
    assert.doesNotMatch(failedText, /internal detail/);
  } finally {
    await off.close(); await misconfigured.close(); await on.close();
    prometheus.closeAllConnections(); await new Promise<void>((resolve) => prometheus.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('the handoff flags a repair edit that is not near any finding or API change', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ketchup-hunks-'));
  const app = await createApp({ dataDirectory: directory });
  try {
    const { base, post } = await serve(app);
    const bundle = smallBundle();
    const filler = Array.from({ length: 14 }, (_, index) => `export const note${index} = ${index};`).join('\n');
    bundle.sources = { 'src/label.ts': `import { label } from 'label-kit';\nexport const title = label('Cooling', 'Rack: ');\n${filler}\nexport const owner = 'ops';\n` };
    const { id } = workspaceSchema.parse(await (await post('/api/import', bundle)).json());
    const workspace = app.store.items.get(id);
    assert.ok(workspace);
    const proposal = { summary: 'Pass the prefix as an option.', rationale: 'label-kit 2 takes an options object.', edits: [
      { path: 'src/label.ts', before: "label('Cooling', 'Rack: ')", after: "label('Cooling', { prefix: 'Rack: ' })" },
      { path: 'src/label.ts', before: "owner = 'ops'", after: "owner = 'platform'" },
    ] };
    const report = checkPatch(workspace.bundle, proposal.edits);
    assert.equal(report.accepted, true);
    await app.store.save({ ...workspace, draft: { origin: 'nemotron', proposal, report, demo: null } });
    const text = await (await fetch(`${base}/api/workspaces/${id}/export?format=report`)).text();
    assert.ok(text.includes('- Review note: this edit is not near any compiler finding or API change, so confirm the upgrade needs it: `src/label.ts:14-17`.'), text);
    assert.doesNotMatch(text, /`src\/label\.ts:1-5`/, 'the edit at the compiler finding is not flagged');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
