import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runAgent } from './agent.ts';
import { checkMetricNames, prometheusStatus } from './connectors/prometheus.ts';
import { checkPatch, failedChecks, repairAccepted } from './engine.ts';
import { contractOrigin, demoBundle, demoEvidence, isDemoBundle, listDemos, rehearsalProposal } from './demo.ts';
import { NVIDIA_MODEL } from './nemotron.ts';
import { isNodeBuiltin, type PrepareOptions, type ProjectInspection } from './intake.ts';
import { CapacityError, WorkspaceStore } from './store.ts';
import type { AgentEvent, ApiChange, Diagnostic, DraftResult, Job, MigrationBundle, Workspace } from './types.ts';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const draftSchema = z.object({ mode: z.enum(['rehearsal', 'nemotron']) }).strict();
const uuid = z.string().uuid();
const demoSchema = z.object({ id: z.string().min(1).max(80).optional() }).strict();
const prepareSchema = z.object({ path: z.string().min(1).max(4096), dependency: z.string().min(1).max(214), version: z.string().min(1).max(80) }).strict();
const prometheusCheckSchema = z.object({
  names: z.array(z.string().regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/, 'is not a Prometheus metric name')).min(1).max(50),
  confirmHost: z.string().min(1).max(300),
}).strict();
/** Engine limits are 16 MiB per bundle; JSON escaping of source text needs headroom above that. */
const MAX_BODY = 18 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly details: string[];
  /** What the page can offer next: `bundle` links the example bundle. */
  action?: 'bundle';
  constructor(status: number, message: string, details: string[] = []) { super(message); this.status = status; this.details = details; }
}

/** Turns schema and bundle validation failures into one plain sentence plus a short list of what to fix. */
function invalidInput(error: unknown, sentence: string): HttpError | null {
  const plain = (where: string, message: string) => message === 'Required' ? `${where || 'A required field'} is missing` : where ? `${where}: ${message}` : message;
  let details: string[] | null = null;
  if (error instanceof z.ZodError) details = error.issues.map((issue) => plain(issue.path.join('.'), issue.message));
  else if (error instanceof Error && error.message.startsWith('Invalid migration bundle: ')) {
    details = error.message.slice('Invalid migration bundle: '.length).split('; ').map((item) => {
      const [where = '', ...rest] = item.split(': ');
      return rest.length ? plain(where === 'bundle' ? '' : where, rest.join(': ')) : item;
    });
  }
  return details ? new HttpError(400, sentence, [...new Set(details)].slice(0, 6)) : null;
}

async function projectFolder(input: string | null): Promise<string> {
  if (!input?.trim()) throw new HttpError(400, 'Enter the full path to a project folder.');
  if (!path.isAbsolute(input)) throw new HttpError(400, 'Use the absolute path to the project folder.');
  const folder = path.resolve(input);
  const info = await stat(folder).catch(() => null);
  if (!info) throw new HttpError(400, 'That folder does not exist on this computer.');
  if (!info.isDirectory()) throw new HttpError(400, 'That path is a file. Choose the project folder that contains package.json.');
  return folder;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send the request as JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new HttpError(413, 'The request is too large. A migration bundle may hold up to 4000 files, 1 MiB per file and 16 MiB in total.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'This file is not valid JSON. Download the example bundle to see the format.'); }
}

const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, ' ');
const cell = (text: string) => oneLine(text).replace(/\|/g, '\\|');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function exportStem(workspace: Workspace): string {
  const { dependency } = workspace.bundle;
  return `ketchup-${dependency.name.replace(/^@/, '')}-${dependency.before.version}-to-${dependency.after.version}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** The next action names its Prometheus queries; this note says how to read them without listing them again. */
function prometheusChecks(nextAction: string): string[] {
  if (!/\b(?:count|absent)\([a-zA-Z_:][a-zA-Z0-9_:]*\)/.test(nextAction)) return [];
  return ['', '## Check it on your Prometheus', '', 'Ketchup did not query any Prometheus server for this report. After the upgrade, run the queries in the next action above on the Prometheus that evaluates these alerts. A count() query that returns nothing means the rules that watch that metric cannot fire.'];
}

/** Hunks of the repair whose original lines are not within a hunk's context of any compiler finding or API-change location. */
function unanchoredHunks(workspace: Workspace): string[] {
  const { analysis, draft } = workspace;
  const anchors = [...analysis.findings, ...analysis.apiChanges.flatMap((change) => change.locations)];
  const found: string[] = [];
  let file = '';
  for (const line of draft?.report.diff.split('\n') ?? []) {
    if (line.startsWith('--- a/')) file = line.slice('--- a/'.length);
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const end = start + Math.max(Number(hunk[2] ?? 1), 1) - 1;
    if (!anchors.some((anchor) => anchor.file === file && anchor.line >= start && anchor.line <= end)) found.push(`${file}:${start === end ? start : `${start}-${end}`}`);
  }
  return found;
}

function handoff(workspace: Workspace): string {
  const { bundle, analysis, draft } = workspace;
  const { dependency } = bundle;
  const published = dependency.source;
  /** In a generated contract, a one-number function returning a branded unit is Ketchup's helper, not the publisher's API. */
  const unitHelper = (change: ApiChange) => published !== undefined && /^function \w+\(value: number\): \w+$/.test(change.before ?? change.after ?? '');
  const leftOut = bundle.origin?.omitted ?? [];
  const nodeTypesLeftOut = leftOut.some((item) => item.startsWith('@types/node:'));
  /** Errors that only exist because @types/node was left out, such as "Cannot find module 'node:test'". */
  const fromNodeTypes = (item: Diagnostic) => nodeTypesLeftOut && (/type definitions for node/i.test(item.message)
    || ((item.code === 2307 || item.code === 2792) && isNodeBuiltin(/Cannot find module '([^']+)'/.exec(item.message)?.[1] ?? '')));
  const nodeErrors = analysis.baseline.filter(fromNodeTypes);
  const install = `npm install ${dependency.name}@${dependency.after.version}`;
  const summary = [`This upgrade moves ${bundle.origin ? `the ${bundle.origin.folder} project` : 'the code'} from ${dependency.name} ${dependency.before.version} to ${dependency.after.version}.`, bundle.description.trim()];
  if (bundle.intent?.trim()) summary.push(`The change must keep this behavior: ${bundle.intent.trim()}`);
  summary.push(draft
    ? `Ketchup located ${plural(analysis.findings.length, 'affected place')} in ${plural(analysis.affectedFileCount, 'file')} and prepared a repair for review.`
    : `Ketchup located ${plural(analysis.findings.length, 'affected place')} in ${plural(analysis.affectedFileCount, 'file')}. No repair has been drafted yet.`);
  const lines = [`# Upgrade ${dependency.name} from ${dependency.before.version} to ${dependency.after.version}`, '', `Project: ${bundle.name}`, '', '## Summary', '', summary.filter(Boolean).join(' ')];

  const operator = draft?.demo?.operator;
  if (operator) {
    const alertName = (row: (typeof operator.rows)[number]) => row.rule ? `${cell(row.rule)}: ${cell(row.name)}` : cell(row.name);
    lines.push('', '## Operator handoff', '', operator.headline, '', 'An alert whose rule cannot fire means on-call gets no alert for that condition.', '',
      '| Alert | Original code | Repaired code |', '| --- | --- | --- |');
    for (const row of operator.rows) lines.push(`| ${alertName(row)} | ${cell(row.original)} | ${cell(row.repaired)} |`);
    const stated = operator.rows.filter((row) => row.alert);
    if (stated.length) {
      lines.push('', 'Each alert as its rule states it. Thresholds keep the team\'s own configured limits; a changed unit is converted in the expression.', '',
        '| Alert | Original metric and threshold | Repaired metric and threshold |', '| --- | --- | --- |');
      for (const row of stated) lines.push(`| ${cell(row.rule ?? row.name)} | \`${cell(row.alert?.original ?? '')}\` | \`${cell(row.alert?.repaired ?? '')}\` |`);
    }
    lines.push('', 'Next action:', '', operator.nextAction);
    lines.push(...prometheusChecks(operator.nextAction));
  }

  lines.push('', '## Affected code', '');
  const helpers = new Set(analysis.apiChanges.filter(unitHelper).map((change) => change.symbol));
  for (const finding of analysis.findings) {
    const helper = finding.code === 2305 ? /has no exported member '(\w+)'/.exec(finding.detail)?.[1] : undefined;
    const title = helper && helpers.has(helper)
      ? `\`${helper}\` is a unit helper in the contract Ketchup generates, not part of ${published?.publisher}'s API, and the ${dependency.after.version} contract no longer has it`
      : oneLine(finding.title).replace(/\.$/, '');
    const compiler = `Compiler: ${oneLine(finding.detail)} (TS${finding.code})`;
    lines.push(`- \`${finding.file}:${finding.line}\` ${title === oneLine(finding.detail).replace(/\.$/, '') ? compiler : `${title}. ${compiler}`}`);
  }
  if (!analysis.findings.length) lines.push(`Ketchup found no new compiler errors on ${dependency.after.version} in the analyzed code.`);
  if (analysis.apiChanges.length) {
    lines.push('', '## API changes', '');
    const unlocated = analysis.apiChanges.filter((change) => !change.locations.length);
    const label = (change: ApiChange) => `\`${change.symbol}\`${unitHelper(change) ? ` (a unit helper in the contract Ketchup generates, not part of ${published?.publisher}'s API)` : ''}`;
    for (const change of analysis.apiChanges.filter((item) => item.locations.length)) lines.push(`- ${label(change)} was ${change.kind}: used at ${change.locations.map((item) => `\`${item.file}:${item.line}\``).join(', ')}.`);
    if (unlocated.length) lines.push(`- Listed but not used in the analyzed code: ${unlocated.map((change) => `${label(change)} (${change.kind})`).join(', ')}.`);
  }
  const { coverage } = analysis;
  lines.push('', `Analysis coverage: ${coverage.status === 'complete' ? 'complete for the analyzed files and declarations.' : coverage.status === 'partial' ? 'partial. Some changes may not be listed.' : 'not available. The lists above may be incomplete.'}`);
  for (const note of coverage.notes) lines.push(`- ${note}`);
  if (leftOut.length) {
    lines.push('', '## Left out of the analysis', '');
    for (const item of leftOut) lines.push(`- ${item}`);
    if (nodeErrors.length) lines.push(`- Because @types/node is left out, the original code has ${plural(nodeErrors.length, 'compiler error')} such as ${[...new Set(nodeErrors.map((item) => `"${oneLine(item.message)}"`))].slice(0, 2).join(' and ')}. These come from the analysis setup and are not counted as the project's own errors.`);
  }
  if (!draft) { lines.push(''); return lines.join('\n'); }

  lines.push('', '## Update the dependency', '');
  if (published) lines.push(`${dependency.name} is ${contractOrigin(bundle)}, not an npm package. Move the integration to version ${dependency.after.version} as described at ${published.url}.`);
  else lines.push('```sh', install, '```', '', 'This updates package.json and the lockfile. Commit both with the code change. With pnpm or Yarn, add the same version with that tool instead.');
  const files = [...new Set(draft.proposal.edits.map((edit) => edit.path))];
  const { report } = draft;
  const failed = failedChecks(draft.demo);
  const checked = !report.accepted ? 'did not pass the latest compiler check' : failed.length ? 'compiler-checked, but a scenario check failed' : 'compiler-checked';
  lines.push('', '## The repair', '', draft.proposal.summary, '', draft.proposal.rationale, '',
    `- Files changed: ${files.map((file) => `\`${file}\``).join(', ')}`,
    `- Origin: ${draft.origin === 'nemotron' ? `NVIDIA Nemotron${draft.model ? ` (${draft.model})` : ''} draft, ${checked}` : `Ketchup reference repair, ${checked}`}`);

  const patchFile = `${exportStem(workspace)}.patch`;
  if (!report.accepted) lines.push('', '## Apply it', '', 'The patch is not available for download because the repair did not pass the latest compiler check. Draft the repair again before applying it.');
  else if (!repairAccepted(report, draft.demo)) lines.push('', '## Apply it', '', `The patch is not available for download because the repair failed ${failed.length === 1 ? 'a scenario check' : 'scenario checks'}: ${failed.map((check) => check.name).join(', ')}. Draft the repair again before applying it.`);
  else lines.push('', '## Apply it', '',
    `1. Save the patch as \`${patchFile}\` in the repository root.`,
    `2. Check and apply it: \`git apply --check ${patchFile}\`, then \`git apply ${patchFile}\`.`,
    published ? `3. Update the ${dependency.name} integration to ${dependency.after.version}.` : `3. Update the dependency: \`${install}\`.`,
    '4. Run the project\'s typecheck (for example `npx tsc --noEmit`) and its tests.');

  lines.push('', '## Checks performed', '',
    `- Compiler, original code on ${dependency.before.version}: ${plural(analysis.baseline.length, 'error')}${nodeErrors.length ? ` (${nodeErrors.length} from leaving out @types/node)` : ''}.`,
    `- Compiler, original code on ${dependency.after.version}: ${plural(analysis.target.length, 'error')} (${analysis.introduced.length} introduced by the upgrade).`,
    `- Compiler, repaired code on ${dependency.after.version}: ${report.accepted ? 'passed' : 'failed'} (${plural(report.remaining.length, 'new error')} remaining).`);
  const preexisting = report.preexisting.filter((item) => !fromNodeTypes(item));
  if (preexisting.length) lines.push(`- Errors that existed before the upgrade and are unchanged: ${preexisting.length}.`);
  lines.push(report.violations.length ? `- Repair rules: ${plural(report.violations.length, 'violation')}.` : '- Repair rules: no violations found (no erased exports, new type bypasses or newly unused bindings).');
  for (const violation of report.violations) lines.push(`  - \`${violation.file}\`: ${violation.message}`);
  for (const check of draft.demo?.checks ?? []) lines.push(`- ${check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Failed' : 'Not run'}: ${check.name}. ${check.detail}`);
  if (draft.review) {
    lines.push(`- Behavior review by NVIDIA Nemotron (a model review, not a runtime test): ${draft.review.summary}`);
    for (const risk of draft.review.risks) lines.push(`  - \`${risk.file}${risk.line === null ? '' : `:${risk.line}`}\`: ${risk.concern}`);
  } else if (draft.origin === 'nemotron') lines.push('- Behavior review by NVIDIA Nemotron: none was recorded for this draft. Review the changed behavior yourself.');
  lines.push(`- Checked at ${report.checkedAt}.`);

  lines.push('', '## Still to verify', '',
    '- Ketchup checks types only. It did not run this project, its tests or the new dependency. Run the test suite after applying the patch.',
    `- Exercise the changed code paths (${files.join(', ')}) in a test or staging environment before release.`);
  const unanchored = unanchoredHunks(workspace);
  if (unanchored.length) lines.push(`- Review note: ${unanchored.length === 1 ? 'this edit is' : 'these edits are'} not near any compiler finding or API change, so confirm the upgrade needs ${unanchored.length === 1 ? 'it' : 'them'}: ${unanchored.map((at) => `\`${at}\``).join(', ')}.`);
  if (draft.demo?.note) lines.push(`- ${draft.demo.note}`);

  const sources = [...(draft.demo?.sources ?? []), ...(published ? [{ label: `${published.publisher} source of the ${dependency.name} contract Ketchup generates`, url: published.url }] : [])];
  if (sources.length) {
    lines.push('', '## Sources', '');
    for (const source of sources) lines.push(`- ${source.label}: ${source.url}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function createApp(options: {
  dataDirectory: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  inspectProject?: (root: string) => Promise<ProjectInspection>;
  prepareProject?: (input: PrepareOptions) => Promise<MigrationBundle>;
  /** Connector configuration; defaults to process.env. */
  env?: Record<string, string | undefined>;
}) {
  const env = options.env ?? process.env;
  const store = new WorkspaceStore(options.dataDirectory);
  await store.initialize();
  const cacheDirectory = path.join(options.dataDirectory, 'cache');
  const inspectProject = options.inspectProject ?? (async (root: string) => (await import('./intake.ts')).inspectProject(root, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}));
  const prepareProject = options.prepareProject ?? (async (input: PrepareOptions) => (await import('./intake.ts')).prepareProject(input));
  const csrfToken = randomBytes(32).toString('hex');
  const jobs = new Map<string, Job>();
  const controllers = new Map<string, AbortController>();
  const finalizing = new Set<string>();
  const pendingJobs = new Set<Promise<void>>();
  let closing = false;

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (closing) throw new HttpError(503, 'Ketchup is shutting down. Restart it to continue.');
      const address = server.address();
      if (!address || typeof address === 'string') throw new HttpError(503, 'The server is starting.');
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(request.headers.host ?? '')) throw new HttpError(403, 'Ketchup accepts local requests only.');
      const origin = request.headers.origin;
      if (origin && !allowedHosts.some((host) => origin === `http://${host}`)) throw new HttpError(403, 'This request came from another website.');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are blocked.');
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const method = request.method ?? 'GET';
      if (!['GET', 'POST'].includes(method)) throw new HttpError(405, 'This method is not supported.');
      if (method === 'POST') {
        const token = request.headers['x-ketchup-token'];
        if (typeof token !== 'string' || token.length !== csrfToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) {
          throw new HttpError(403, 'Reload Ketchup before making changes.');
        }
      }
      if (method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, { name: 'Ketchup', version: '1.0.0', model: NVIDIA_MODEL, keyConfigured: Boolean(options.apiKey?.trim()), liveValidated: false, csrfToken, warnings: store.warnings, demos: listDemos() });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/connectors') { sendJson(response, 200, { prometheus: prometheusStatus(env) }); return; }
      if (method === 'POST' && url.pathname === '/api/connectors/prometheus/check') {
        const input = prometheusCheckSchema.parse(await readJson(request));
        const status = prometheusStatus(env);
        if (!status.configured) {
          throw new HttpError(409, env['KETCHUP_PROMETHEUS_URL']?.trim()
            ? 'KETCHUP_PROMETHEUS_URL is set but Ketchup cannot use it. Check the URL and the credential variable, then restart Ketchup.'
            : 'Prometheus is not configured. Set KETCHUP_PROMETHEUS_URL to check your own server.');
        }
        if (input.confirmHost !== status.host) throw new HttpError(409, `Confirm the host ${status.host} before Ketchup contacts it.`);
        const controller = new AbortController();
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        let checked: Awaited<ReturnType<typeof checkMetricNames>>;
        try { checked = await checkMetricNames({ names: input.names, env, signal: controller.signal }); }
        catch (error) { throw new HttpError(502, error instanceof Error ? error.message : 'The Prometheus check failed.'); }
        sendJson(response, 200, checked); return;
      }
      if (method === 'GET' && url.pathname === '/api/demos') { sendJson(response, 200, { demos: listDemos() }); return; }
      if (method === 'GET' && url.pathname === '/api/archive') { sendJson(response, 200, { projects: await store.listArchived() }); return; }
      if (method === 'GET' && url.pathname === '/api/projects/inspect') {
        sendJson(response, 200, await inspectProject(await projectFolder(url.searchParams.get('path')))); return;
      }
      if (method === 'POST' && url.pathname === '/api/projects/prepare') {
        const input = prepareSchema.parse(await readJson(request));
        const root = await projectFolder(input.path);
        store.assertCapacity();
        const controller = new AbortController();
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        const prepared = await prepareProject({ root, dependency: input.dependency, targetVersion: input.version, cacheDirectory, signal: controller.signal, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
        try { sendJson(response, 201, await store.create(prepared)); }
        catch (error) { throw invalidInput(error, 'Ketchup could not build an analysis from this project.') ?? error; }
        return;
      }
      const restoreMatch = /^\/api\/archive\/([^/]+)\/restore$/.exec(url.pathname);
      if (method === 'POST' && restoreMatch) {
        const id = uuid.parse(restoreMatch[1]);
        await readJson(request);
        if (store.items.has(id)) throw new HttpError(409, 'This project is already open.');
        sendJson(response, 200, await store.restore(id)); return;
      }
      if (method === 'GET' && url.pathname === '/api/workspaces') { sendJson(response, 200, { workspaces: store.list() }); return; }
      if (method === 'GET' && url.pathname === '/api/example') {
        response.setHeader('Content-Disposition', 'attachment; filename="ketchup-example.json"');
        sendJson(response, 200, demoBundle()); return;
      }
      if (method === 'POST' && url.pathname === '/api/demo') {
        const { id: demoId } = demoSchema.parse(await readJson(request));
        if (demoId !== undefined && !listDemos().some((demo) => demo.id === demoId)) throw new HttpError(404, 'This example was not found.');
        const fresh = demoBundle(demoId);
        const copies = store.list().filter((item) => item.demoAvailable && item.bundle.dependency.name === fresh.dependency.name
          && item.bundle.dependency.after.version === fresh.dependency.after.version && item.bundle.name.startsWith(fresh.name));
        const undrafted = copies.find((item) => item.draft === null);
        if (undrafted) { sendJson(response, 200, undrafted); return; }
        const names = new Set(store.list().map((item) => item.bundle.name));
        let copy = 2;
        while (names.has(`${fresh.name} (${copy})`)) copy++;
        const numbered: MigrationBundle = { ...fresh, name: `${fresh.name} (${copy})` };
        sendJson(response, 201, await store.create(copies.length && isDemoBundle(numbered) ? numbered : fresh)); return;
      }
      if (method === 'POST' && url.pathname === '/api/import') {
        try { sendJson(response, 201, await store.create(await readJson(request))); }
        catch (error) {
          const failure = invalidInput(error, 'This file is not a valid Ketchup migration bundle. Download the example bundle to see the format.')
            ?? (error instanceof HttpError && error.status === 400 ? error : null);
          if (!failure) throw error;
          failure.action = 'bundle';
          throw failure;
        }
        return;
      }
      const workspaceMatch = /^\/api\/workspaces\/([^/]+)(?:\/(draft|export|archive))?$/.exec(url.pathname);
      if (workspaceMatch) {
        const id = uuid.parse(workspaceMatch[1]);
        const workspace = store.items.get(id);
        if (!workspace) throw new HttpError(404, 'This workspace was not found.');
        const action = workspaceMatch[2];
        if (method === 'GET' && !action) { sendJson(response, 200, workspace); return; }
        if (method === 'POST' && action === 'archive') {
          await readJson(request);
          if ([...jobs.values()].some((job) => job.status === 'running' && job.workspaceId === id)) throw new HttpError(409, 'A draft is running for this project. Finish or cancel it before archiving.');
          await store.archive(id);
          sendJson(response, 200, { ok: true, archived: id }); return;
        }
        if (method === 'GET' && action === 'export') {
          const format = url.searchParams.get('format') ?? 'report';
          if (!['patch', 'report', 'bundle'].includes(format)) throw new HttpError(400, 'Choose patch, report or bundle.');
          if (format === 'patch' && !workspace.draft) throw new HttpError(409, 'Create a draft before exporting a patch.');
          if (format === 'patch' && workspace.draft && !repairAccepted(workspace.draft.report, workspace.draft.demo)) throw new HttpError(409, 'This patch has not passed static validation and every scenario check.');
          const filename = `${exportStem(workspace)}.${format === 'patch' ? 'patch' : format === 'report' ? 'md' : 'json'}`;
          response.writeHead(200, { 'Content-Type': format === 'bundle' ? 'application/json' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
          response.end(format === 'patch' ? workspace.draft?.report.diff : format === 'report' ? handoff(workspace) : JSON.stringify(workspace.bundle, null, 2));
          return;
        }
        if (method === 'POST' && action === 'draft') {
          const { mode } = draftSchema.parse(await readJson(request));
          if (controllers.size) throw new HttpError(409, 'A migration is already running. Finish or cancel it before starting another.');
          if (mode === 'nemotron' && !options.apiKey?.trim()) throw new HttpError(409, 'Add NVIDIA_API_KEY to the .env file in the Ketchup folder (or set it in your environment) and restart Ketchup to use Nemotron. The reference repair works without a key.');
          if (mode === 'rehearsal' && !workspace.demoAvailable) throw new HttpError(400, 'The reference repair is available only for Ketchup\'s built-in examples. Other projects need a Nemotron draft.');
          const jobId = randomUUID();
          const controller = new AbortController();
          const events: AgentEvent[] = [];
          const job: Job = { id: jobId, status: 'running', workspaceId: id, events };
          jobs.set(jobId, job); controllers.set(jobId, controller);
          sendJson(response, 202, job);
          const onEvent = (event: AgentEvent) => { if (events.length < 200) events.push(event); };
          const task = (async () => {
            try {
              let result: DraftResult;
              if (mode === 'rehearsal') {
                onEvent({ at: new Date().toISOString(), kind: 'plan', title: 'Reference repair check', detail: 'Checking the bundled reference repair against the supplied target API. No model call is made.' });
                const proposal = rehearsalProposal(workspace.bundle);
                const report = checkPatch(workspace.bundle, proposal.edits);
                result = { origin: 'rehearsal', proposal, report, demo: demoEvidence(workspace.bundle, report, 'rehearsal') };
                onEvent({ at: new Date().toISOString(), kind: 'check', title: 'Compiler check complete', detail: `${report.diagnostics.length} target diagnostics remain.` });
              } else {
                const live = await runAgent({ bundle: workspace.bundle, analysis: workspace.analysis, apiKey: options.apiKey ?? '', onEvent, signal: controller.signal, attempts: 2, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
                result = { origin: 'nemotron', model: NVIDIA_MODEL, proposal: live.proposal, report: live.report, review: live.review ?? null, demo: demoEvidence(workspace.bundle, live.report, 'nemotron') };
              }
              if (controller.signal.aborted) throw new Error('Migration cancelled. Your previous draft is unchanged.');
              if (!result.report.accepted) throw new Error('The proposed patch did not pass static validation. No draft was saved.');
              const failed = failedChecks(result.demo);
              if (failed.length) throw new Error(`The proposed patch failed ${failed.length === 1 ? 'a scenario check' : 'scenario checks'}: ${failed.map((check) => check.name).join(', ')}. No draft was saved.`);
              if (mode === 'rehearsal') onEvent({ at: new Date().toISOString(), kind: 'complete', title: 'Ready for review', detail: 'The patch passed the supplied target declarations. Review the diff and runtime limits before using it.' });
              const updated = { ...(store.items.get(id) ?? workspace), draft: result, events };
              finalizing.add(jobId);
              await store.save(updated);
              jobs.set(jobId, { id: jobId, status: 'complete', workspaceId: id, events, result });
            } catch (error) {
              const message = controller.signal.aborted ? 'Migration cancelled. Your previous draft is unchanged.' : safeError(error, options.apiKey);
              onEvent({ at: new Date().toISOString(), kind: 'error', title: 'Draft stopped', detail: message });
              try { await store.save({ ...(store.items.get(id) ?? workspace), events }); }
              catch { onEvent({ at: new Date().toISOString(), kind: 'error', title: 'Activity could not be saved', detail: 'The previous workspace file is preserved. Check local disk space and permissions.' }); }
              jobs.set(jobId, { id: jobId, status: 'failed', workspaceId: id, events, error: message });
            } finally {
              finalizing.delete(jobId);
              controllers.delete(jobId);
              if (jobs.size > 40) {
                const oldest = jobs.keys().next().value;
                if (oldest) jobs.delete(oldest);
              }
            }
          })();
          pendingJobs.add(task);
          void task.finally(() => pendingJobs.delete(task));
          return;
        }
        throw new HttpError(405, 'This workspace action does not support that method.');
      }
      const jobMatch = /^\/api\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname);
      if (jobMatch) {
        const id = uuid.parse(jobMatch[1]);
        const job = jobs.get(id);
        if (!job) throw new HttpError(404, 'This job is no longer available. Open the saved workspace.');
        if (method === 'GET' && !jobMatch[2]) { sendJson(response, 200, job); return; }
        if (method === 'POST' && jobMatch[2] === 'cancel') {
          await readJson(request);
          if (finalizing.has(id) || jobs.get(id)?.status === 'complete') throw new HttpError(409, 'The checked draft is being saved or has completed. Wait for its result before starting another draft.');
          controllers.get(id)?.abort();
          sendJson(response, 200, { ok: true }); return;
        }
      }
      if (method === 'GET' && ['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg', '/assets/nmc2-logo.svg'].includes(url.pathname)) {
        const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const contentType = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
        response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
        response.end(await readFile(path.join(publicDirectory, filename))); return;
      }
      throw new HttpError(404, 'This page does not exist.');
    } catch (error) {
      if (!response.headersSent) {
        const failure = error instanceof HttpError ? error : error instanceof CapacityError ? new HttpError(409, error.message) : invalidInput(error, 'The request was not in the expected form.') ?? error;
        const status = failure instanceof HttpError ? failure.status : 400;
        const details = failure instanceof HttpError ? failure.details.map((detail) => safeError(new Error(detail), options.apiKey)) : [];
        sendJson(response, status, { error: safeError(failure, options.apiKey), ...(details.length ? { details } : {}), ...(error instanceof CapacityError ? { action: 'archive' } : failure instanceof HttpError && failure.action ? { action: failure.action } : {}) });
      } else response.end();
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return {
    server, store,
    close: async () => {
      closing = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...pendingJobs]);
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function safeError(error: unknown, key?: string): string {
  let message = error instanceof z.ZodError
    ? error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; ')
    : error instanceof Error ? error.message : 'The request failed. Try again after checking your input.';
  if (key) message = message.split(key).join('[redacted]');
  return message.slice(0, 1500);
}
