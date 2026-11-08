const $ = (selector, root = document) => root.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// Supporting detail stays one click away: every disclosure on the page uses this one helper and one CSS role.
const more = (label, body, { open = false, cls = '' } = {}) => `<details class="more ${cls}"${open ? ' open' : ''}><summary><span>${label}</span></summary><div class="more-body">${body}</div></details>`;
const state = { notice: '', returnTo: null, arrive: false, status: null, connectors: null, prometheus: { result: null, error: '', busy: false }, workspaces: [], demos: [], workspace: null, page: 'start', sourceTab: 'sources', sourceFile: null, contractFile: null, finding: null, location: null, job: null, jobStartedAt: 0, busy: false, error: '', errorDetails: [], errorHelp: false, intake: { path: '', info: null, dependency: '', version: '', step: '', error: '' } };
// The server allows a Nemotron draft five minutes per attempt, up to eight minutes for two attempts, plus up to 150 seconds for the behavior review; the page waits longer than that.
const DRAFT_LIMIT_MS = 12 * 60 * 1000;
const START_TITLE = 'Ketchup: catch your code up with a dependency’s new API';
let pollingGeneration = 0;
let toastTimer;

async function api(path, body, timeout = 30000) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Ketchup-Token': state.status?.csrfToken ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(typeof payload?.error === 'string' ? payload.error : `The local server returned ${response.status}. Restart Ketchup and try again.`, { cause: { archive: 'capacity', bundle: 'bundle' }[payload?.action] });
    error.details = Array.isArray(payload?.details) ? payload.details.filter(item => typeof item === 'string').slice(0, 5) : [];
    throw error;
  }
  if (payload === null) throw new Error('The local server returned an unreadable response. Restart Ketchup and try again.');
  return payload;
}

function toast(message) {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 5000);
}

function fail(error) {
  state.error = error?.name === 'TimeoutError' ? 'The local server did not respond in time. Check its terminal output and try again.' : error.message || String(error);
  state.errorDetails = error?.details ?? [];
  state.errorHelp = error?.cause === 'bundle' ? 'bundle' : error?.cause === 'capacity' ? 'capacity' : '';
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
  render();
  focusError();
}

async function refreshHistory() {
  const response = await api('/api/workspaces');
  state.workspaces = response.workspaces;
  renderShell();
}

function setWorkspace(workspace) {
  state.workspace = workspace;
  state.finding = workspace.analysis.findings[0]?.id ?? null;
  state.sourceFile = Object.keys(workspace.bundle.sources)[0] ?? null;
  const { before, after } = workspace.bundle.dependency;
  const changed = changedDeclarations(workspace.bundle);
  const member = workspace.analysis.apiChanges?.[0]?.symbol.split('.').at(-1);
  state.contractFile = (member && changed.find(path => `${before.files[path] ?? ''}${after.files[path] ?? ''}`.includes(member))) ?? changed[0] ?? after.entry;
  state.sourceTab = 'sources';
  state.location = null;
  state.error = '';
  state.errorDetails = [];
  state.notice = '';
  state.returnTo = null;
  state.prometheus = { result: null, error: '', busy: false };
  try { localStorage.setItem('ketchup-workspace', workspace.id); } catch {}
}

function showStart() {
  state.page = 'start';
  try { localStorage.removeItem('ketchup-workspace'); } catch {}
  render();
  focusWorkspace();
}

async function openWorkspace(id, page = null) {
  if (state.job || state.busy) return;
  state.busy = true;
  render();
  try {
    setWorkspace(await api(`/api/workspaces/${encodeURIComponent(id)}`));
    state.page = page && (page !== 'patch' || state.workspace.draft) ? page : state.workspace.draft ? 'patch' : 'overview';
  } finally { state.busy = false; render(); focusWorkspace(); }
}

// The address names the project and its page (#/<id>/findings, /code, /repair), so browser Back and Forward, and a reload,
// move between pages like any site. A history entry is added only when the page changes.
const PAGE_SLUGS = { overview: 'findings', source: 'code', patch: 'repair' };
const pageHash = () => state.page === 'start' || !state.workspace ? '#/' : `#/${encodeURIComponent(state.workspace.id)}/${PAGE_SLUGS[state.page] ?? 'findings'}`;
function parseHash(hash = location.hash) {
  const match = /^#\/([^/]+)\/(findings|code|repair)$/.exec(hash);
  if (match) return { id: decodeURIComponent(match[1]), page: Object.keys(PAGE_SLUGS).find(key => PAGE_SLUGS[key] === match[2]) };
  return hash === '#/' ? { start: true } : null;
}
let historyStarted = false;
let replaceHistory = false;
function syncHistory() {
  if (!state.status || state.busy) return;
  const hash = pageHash();
  if (location.hash !== hash) {
    if (historyStarted && !replaceHistory) history.pushState(null, '', hash); else history.replaceState(null, '', hash);
  }
  historyStarted = true;
  replaceHistory = false;
}

// Back from the code returns to the finding the reader left from, where they left it.
function showPage(page) {
  const back = state.page === 'source' && page === 'overview' ? state.returnTo : null;
  goTo(page);
  if (!back) { focusWorkspace(); return; }
  window.scrollTo({ top: back.scroll });
  const card = back.finding ? $(`[data-source-finding="${CSS.escape(back.finding)}"]`) : null;
  (card ?? $('#workspace h1'))?.focus({ preventScroll: true });
}

async function followHistory() {
  const target = parseHash();
  const here = state.workspace && state.page !== 'start' ? state.workspace.id : null;
  if (target?.id && target.id === here) {
    replaceHistory = true;
    showPage(target.page === 'patch' && !state.workspace.draft ? 'overview' : target.page);
    return;
  }
  if (state.job || state.busy) {
    history.pushState(null, '', pageHash());
    toast('Stop the draft, or let it finish, before leaving this project.');
    return;
  }
  replaceHistory = true;
  if (target?.id && state.workspaces.some(workspace => workspace.id === target.id)) await openWorkspace(target.id, target.page);
  else showStart();
}

async function createDemo(id) {
  if (state.job || state.busy) return;
  state.busy = true;
  render();
  try {
    setWorkspace(await api('/api/demo', id ? { id } : {}));
    state.page = 'overview';
    await refreshHistory();
  } finally { state.busy = false; render(); focusWorkspace(); }
}

async function importBundle(file) {
  if (!file || state.job || state.busy) return;
  if (file.size > 18 * 1024 * 1024) throw new Error('This file is too large. A migration bundle may hold up to 4000 files, 1 MiB per file and 16 MiB in total.');
  let bundle;
  try { bundle = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON.', { cause: 'bundle' }); }
  state.busy = true;
  render();
  try {
    setWorkspace(await api('/api/import', bundle, 120000));
    state.page = 'overview';
    await refreshHistory();
  } finally { state.busy = false; render(); focusWorkspace(); }
}

function intakeError(message) {
  state.intake.error = message;
  state.intake.step = '';
  render();
  $('#intake-error')?.focus({ preventScroll: true });
}

// Prefers a dependency the TypeScript sources import, then a runtime dependency, then one that is installed; @types packages come last.
// `imported`, `dev` and `latest` are used when the server reports them.
function defaultDependency(dependencies) {
  const rank = item => (item.imported ? 0 : 8) + (item.dev ? 4 : 0) + (item.name.startsWith('@types/') ? 2 : 0) + (item.installed ? 0 : 1);
  return [...dependencies].sort((a, b) => rank(a) - rank(b))[0];
}

async function inspectProject() {
  if (state.job || state.busy) return;
  const intake = state.intake;
  const folder = intake.path.trim();
  intake.info = null;
  if (!folder) return intakeError('Enter the absolute path to the project folder.');
  if (folder.startsWith('~')) return intakeError('Use the absolute path to the project folder instead of ~.');
  Object.assign(intake, { error: '', step: 'Reading package.json and the TypeScript files…' });
  render();
  try {
    intake.info = await api(`/api/projects/inspect?path=${encodeURIComponent(folder)}`);
    const chosen = defaultDependency(intake.info.dependencies);
    intake.dependency = chosen?.name ?? '';
    intake.version = chosen?.latest ?? '';
    intake.step = '';
    render();
    (intake.info.dependencies.length ? $('#intake-dependency') : $('#project-path'))?.focus();
  } catch (error) { intakeError(error.name === 'TimeoutError' ? 'Ketchup did not finish reading the folder in 30 seconds. Check the server terminal and try again.' : error.message); }
}

async function prepareProject() {
  if (state.job || state.busy) return;
  const intake = state.intake;
  const dependency = intake.info?.dependencies.find(item => item.name === intake.dependency);
  const version = intake.version.trim();
  if (!dependency) return intakeError('Choose the dependency to upgrade.');
  if (!version) return intakeError(`Enter the ${dependency.name} version to upgrade to, such as 2.0.0.`);
  if (/\s/.test(version)) return intakeError('Enter one version without spaces, such as 2.0.0.');
  if (version === dependency.installed) return intakeError(`${dependency.name} ${version} is already installed. Enter the version you are moving to.`);
  Object.assign(intake, { error: '', step: `Preparing ${dependency.name} ${dependency.installed ?? dependency.range} → ${version} and comparing declarations…` });
  state.busy = true;
  render();
  try {
    const prepared = await api('/api/projects/prepare', { path: intake.path.trim(), dependency: dependency.name, version }, 120000);
    const workspace = prepared.workspace ?? prepared;
    setWorkspace(workspace);
    state.page = 'overview';
    state.intake = { path: intake.path, info: null, dependency: '', version: '', step: '', error: '' };
    await refreshHistory();
    state.busy = false;
    render();
    focusWorkspace();
  } catch (error) {
    state.busy = false;
    if (error.cause === 'capacity') { intake.step = ''; fail(error); return; }
    intakeError(error.name === 'TimeoutError' ? 'Preparing took longer than two minutes and was abandoned in this page. Check the server terminal, then try again.' : error.message);
  }
}

const dateFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const secondFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
function projectLabel(project, withDate = true, seconds = false) {
  const name = project.bundle?.name ?? project.name;
  const versions = project.bundle ? `${project.bundle.dependency.before.version} → ${project.bundle.dependency.after.version}` : `${project.from} → ${project.to}`;
  const when = withDate && project.updatedAt ? `, ${(seconds ? secondFormat : dateFormat).format(new Date(project.updatedAt))}` : '';
  return `${name} (${versions}${when})`;
}

function renderShell() {
  const locked = state.busy || !!state.job;
  const select = $('#project-select');
  const starting = state.page === 'start' || !state.workspace;
  const repeated = labels => labels.map(label => labels.indexOf(label) !== labels.lastIndexOf(label));
  const plain = repeated(state.workspaces.map(workspace => projectLabel(workspace, false)));
  const dated = repeated(state.workspaces.map(workspace => projectLabel(workspace)));
  select.innerHTML = state.workspaces.map((workspace, index) => `<option value="${escape(workspace.id)}" ${!starting && workspace.id === state.workspace?.id ? 'selected' : ''}>${escape(projectLabel(workspace, plain[index], dated[index]))}</option>`).join('') + `<option value="__start" ${starting ? 'selected' : ''}>Start a new project</option>`;
  select.disabled = locked || !state.status;
  document.querySelectorAll('[data-action="import"]').forEach(button => { button.disabled = locked || !state.status; });
  const archive = $('#archive-project');
  if (archive) archive.hidden = starting;
  const model = $('#model-status');
  if (model && state.status) model.textContent = !state.status.keyConfigured ? 'Nemotron: no key' : state.status.liveValidated ? 'Nemotron: key confirmed with NVIDIA' : 'Nemotron: key configured, not verified';
  const why = state.job ? 'Unavailable while the draft runs' : '';
  select.title = why;
  $('.brand').title = why;
  const report = $('#export-report');
  // Before a repair exists the handoff report lives here; afterwards it sits beside the patch download.
  if (report && state.workspace && !starting) { report.href = exportUrl('report'); report.hidden = Boolean(state.workspace.draft); }
}

function banner() {
  if (!state.error && state.notice) return `<div class="notice-banner" role="status"><span>${escape(state.notice)}</span><button data-action="dismiss-notice" aria-label="Dismiss notice">×</button></div>`;
  const details = state.errorDetails?.length ? `<ul class="error-details">${state.errorDetails.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
  return state.error ? `<div class="error-banner" role="alert" tabindex="-1"><div><span>${escape(state.error)}</span>${details}${state.errorHelp === 'bundle' ? '<a class="button-link" href="/api/example" download>Download example bundle (.json)</a>' : state.errorHelp === 'capacity' ? '<span>To make room, open a project you no longer need and choose Archive this project at the bottom of its page. Archived projects keep their repairs and can be restored.</span>' : ''}</div><button data-action="dismiss-error" aria-label="Dismiss error">×</button></div>` : '';
}

function renderStart() {
  const intake = state.intake;
  const info = intake.info;
  const demos = state.demos.length ? state.demos : [{ id: '', name: 'Default example', summary: 'Opens the example bundled with this copy of Ketchup.' }];
  const dependency = info?.dependencies.find(item => item.name === intake.dependency);
  return `<div class="start">
    <h1>Catch your code up with a dependency’s new API.</h1>
    <p class="start-lede">Ketchup finds the TypeScript an upgrade breaks, drafts a repair with NVIDIA Nemotron, checks it with the compiler, and gives you a patch.</p>
    <section class="start-option" aria-labelledby="start-example">
      <h2 id="start-example">Open an example</h2>
      <p>No key needed: each example ships with a fix you can check.</p>
      <div class="demo-list">${demos.map(demo => `<button class="demo-choice" data-demo="${escape(demo.id)}"><span class="demo-name">${escape(demo.name)}${demo.sponsorCase ? ` <span class="case-tag">${escape(demo.sponsorCase.label)}</span>` : ''}</span><span class="demo-summary">${escape(demo.summary)}</span></button>`).join('')}</div>
    </section>
    <section class="start-option" aria-labelledby="start-folder">
      <h2 id="start-folder">Open a project folder</h2>
      <p>Ketchup reads its TypeScript files and installed type declarations. It never writes to the folder.</p>
      <form id="inspect-form" class="intake-form" novalidate>
        <label for="project-path">Folder path</label>
        <div class="field-row"><input id="project-path" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Absolute path to your TypeScript project" value="${escape(intake.path)}" ${intake.error && !info ? 'aria-invalid="true" aria-describedby="intake-error"' : ''}><button class="button button-outline" type="submit">Inspect</button></div>
      </form>
      ${info ? `<form id="prepare-form" class="intake-form" novalidate>
        <p class="intake-found">Found ${plural(info.sourceCount, 'TypeScript file')} in <code>${escape(info.folder)}</code>.</p>
        ${info.dependencies.length ? `<label for="intake-dependency">Dependency</label>
        <select id="intake-dependency">${info.dependencies.map(item => `<option value="${escape(item.name)}" ${item.name === intake.dependency ? 'selected' : ''}>${escape(item.name)} ${item.installed ? `${escape(item.installed)} installed` : `${escape(item.range)} (Ketchup downloads its declarations)`}</option>`).join('')}</select>
        <label for="target-version">Upgrade to version</label>
        <div class="field-row"><input id="target-version" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escape(dependency?.installed ? `newer than ${dependency.installed}` : 'such as 2.0.0')}" value="${escape(intake.version)}" ${intake.error ? 'aria-invalid="true" aria-describedby="intake-error"' : ''}><button class="button button-primary" type="submit">Prepare upgrade</button></div>` : '<p>This folder’s package.json lists no dependencies, so there is nothing to upgrade here.</p>'}
      </form>` : ''}
      ${intake.step ? `<p class="intake-progress" role="status"><span class="loading-ring" aria-hidden="true"></span>${escape(intake.step)}</p>` : ''}
      ${intake.error ? `<p id="intake-error" class="field-error" role="alert" tabindex="-1">${escape(intake.error)}</p>` : ''}
    </section>
    <p class="start-secondary">Already have a migration bundle? <button class="button-link" data-action="import">Import a bundle</button> <button class="button-link" data-action="help">What goes in a bundle</button></p>
  </div>`;
}

// TypeScript codes for a name or member that no longer exists; only these errors can be explained as "was removed".
const MISSING_CODES = new Set([2304, 2305, 2307, 2339, 2551, 2614, 2694, 2724]);
const compilerText = finding => finding.detail || finding.title;

function changeFor(finding) {
  const here = (state.workspace.analysis.apiChanges ?? []).filter(change => change.locations.some(location => location.file === finding.file && location.line === finding.line));
  const named = here.find(change => new RegExp(`\\b${change.symbol.split('.').at(-1).replace(/[$]/g, '\\$&')}\\b`).test(compilerText(finding)) && (change.kind !== 'removed' || MISSING_CODES.has(finding.code)));
  return { change: named ?? here[0] ?? null, named: Boolean(named) };
}

// Headlines under a status line that already names the version leave it out.
function changeVerb(change, withVersion = true) {
  const version = withVersion ? ` in ${state.workspace.bundle.dependency.after.version}` : '';
  return { removed: `was removed${version}`, changed: `changed${version}`, deprecated: `is deprecated${version}` }[change.kind] ?? `changed${version}`;
}

function signatures(change) {
  const { before, after } = state.workspace.bundle.dependency;
  const line = (side, sign, label, text) => `<code class="signature-${side}"><span class="sign" aria-label="${label}">${sign}</span>${escape(text)}</code>`;
  return `<span class="signature-change">${change.before ? line('before', '−', 'Before', change.before) : `<span class="signature-note">New in ${escape(after.version)}; not in ${escape(before.version)}</span>`} ${change.after ? line('after', '+', 'After', change.after) : `<span class="signature-note">Removed in ${escape(after.version)}</span>`}</span>`;
}

const METRIC = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g;
// Escapes text and sets metric-style names (DCGM_FI_DEV_GPU_TEMP) as code; the stylesheet wraps them only when a line is too narrow.
function withCode(text) {
  return escape(text).replace(METRIC, name => `<code class="metric">${name}</code>`);
}

const CATCHUP_TOMATO = '<svg class="catchup-tomato" viewBox="0 3.5 32 28" focusable="false"><path class="catchup-trail" d="M3 15h4M1 21h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 11C13 7 8 13 10 23c2 8 15 10 20 1 4-8-1-17-9-13Z" fill="currentColor"/><path d="m21 12-6-4 5 1 2-5 1 5 6-2-4 5-3-1-3 4Z" fill="#323e2b"/></svg>';

// lag: 'behind' (tomato at the old version), 'current' (no new errors, full coverage),
// 'caught-up' (repair passed the compiler and the repair rules, full coverage), or null (plain version line).
function dependencyLine(dependency, lag, arrive = false) {
  const name = `<code>${escape(dependency.name)}</code>`;
  if (!lag) return `<p class="dependency-line">${name} <span>${escape(dependency.before.version)} → ${escape(dependency.after.version)}</span></p>`;
  // The tomato is the code on screen; the note says where it stands, so a ready repair on another page never reads as applied here.
  const repaired = Boolean(state.workspace?.draft) && state.page === 'overview';
  const note = lag === 'caught-up' ? `This patch catches your code up to ${escape(dependency.after.version)}.`
    : lag === 'behind' ? `Your code still targets ${escape(dependency.before.version)}${repaired ? ' until you apply the repair' : ''}.` : '';
  const noteLine = note ? `<p class="catchup-note">${note}</p>` : '';
  return `<div class="catchup" data-state="${lag}"${arrive && lag === 'caught-up' ? ' data-arrive' : ''}><p class="catchup-row">${name}<span class="catchup-scale"><span class="catchup-from">${escape(dependency.before.version)}</span><span class="catchup-track" aria-hidden="true"><span class="catchup-rail"></span>${CATCHUP_TOMATO}</span><span class="catchup-sr"> to </span><span class="catchup-to">${escape(dependency.after.version)}</span></span></p>${noteLine}</div>`;
}

// Case attribution comes from the server's example list (`sponsorCase`), matched by the workspace's `demoId`;
// imported and folder projects have none.
function sponsorCase() {
  const workspace = state.workspace;
  if (!workspace?.demoAvailable || !workspace.demoId) return null;
  return state.demos.find(demo => demo.id === workspace.demoId)?.sponsorCase ?? null;
}

// In the flow the case is only its mark and label; its title, note and link sit with the sources, where people look on purpose.
function caseHeader() {
  const sponsor = sponsorCase();
  if (!sponsor) return '';
  return `<div class="case-header">${sponsor.logo ? `<span class="sponsor-mark"><img src="${escape(sponsor.logo)}" width="66" height="29" alt="${escape(sponsor.logoAlt)}"></span>` : ''}<span class="case-tag">${escape(sponsor.label)}</span></div>`;
}

function caseAttribution() {
  const sponsor = sponsorCase();
  return sponsor ? `<p class="case-attribution"><strong>${escape(sponsor.title)}</strong> ${escape(sponsor.note)} <a href="${escape(sponsor.url)}" target="_blank" rel="noreferrer">${escape(new URL(sponsor.url).host)} ↗</a></p>` : '';
}

// A plan event is a model decision in a Nemotron run; in the reference repair check it is Ketchup starting the check.
const EVENT_KINDS = { plan: 'Decision', tool: 'Tool', check: 'Compiler check', review: 'Review', complete: 'Done', error: 'Problem' };
// Workspaces saved by earlier builds title the reference repair's first event "Local rehearsal"; the page uses one name for that path.
const eventTitle = title => /^local rehearsal$/i.test(title ?? '') ? 'Reference repair check' : title;
const clock = milliseconds => { const seconds = Math.max(0, Math.round(milliseconds / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
// Labels and preambles that the trace row already states.
const plainDetail = detail => String(detail ?? '').replace(/^Nemotron['’]s reasoning \(excerpt\):\s*/i, '');

// Each row: what happened, its detail, and the time since the run began. The kind label is left out when it repeats the title.
function traceItems(events) {
  const start = Date.parse(events[0]?.at ?? '');
  const rehearsal = runOrigin(events) === 'rehearsal';
  return events.map(event => {
    const title = eventTitle(event.title);
    const kind = rehearsal && event.kind === 'plan' ? 'Start' : EVENT_KINDS[event.kind] ?? event.kind;
    return `<li class="trace-item ${event.kind === 'error' ? 'error' : ''}"><span class="trace-kind">${kind === title ? '' : escape(kind)}</span><div><div class="trace-title">${escape(title)}</div>${event.detail ? `<div class="trace-detail">${escape(plainDetail(event.detail))}</div>` : ''}</div><time class="trace-time" datetime="${escape(event.at)}">+${clock(Date.parse(event.at) - start)}</time></li>`;
  }).join('');
}

// The reference repair's run opens with the server's "Reference repair check" event; every other run is Nemotron's.
const runOrigin = events => /^(reference repair check|local rehearsal)$/i.test(events[0]?.title ?? '') ? 'rehearsal' : 'nemotron';
const stopEvent = events => events.findLast(event => event.kind === 'error' && event.title === 'Draft stopped');
const authRejected = events => /rejected (the API key|authentication)|\b401\b/i.test(stopEvent(events)?.detail ?? '');

// One sentence from the recorded events: files read, compiler checks passed, and the review's verdict. It counts what happened; it never estimates.
function runSummary(events) {
  if (runOrigin(events) === 'rehearsal') return '';
  const read = events.filter(event => event.kind === 'tool' && /\bread\b/i.test(event.title) && !/npm|package/i.test(event.title)).length;
  const checks = events.filter(event => event.kind === 'check');
  const passed = checks.filter(event => /passed/i.test(event.title)).length;
  const review = events.findLast(event => /review/i.test(event.title ?? '') && /flagged|found|no risks?|unavailable/i.test(event.title));
  const parts = [read && `${plural(read, 'file')} read`, checks.length && `${passed} of ${plural(checks.length, 'compiler check')} passed`, review && `${review.title[0].toLowerCase()}${review.title.slice(1)}`].filter(Boolean);
  const stop = stopEvent(events);
  const stopped = stop ? `Stopped${stop.detail ? `: ${stop.detail.replace(/\.$/, '')}` : ''}.` : '';
  const counts = parts.join(', ');
  return [stopped, counts && `${counts[0].toUpperCase()}${counts.slice(1)}.`].filter(Boolean).join(' ');
}
// The log counts entries, not steps, so it never competes with the four stages of the live panel.
const stepsLabel = events => `Full log (${plural(events.length, 'entry').replace(/entrys$/, 'entries')})`;

// Which page shows the saved run: a run that made the saved repair sits beside it; a stopped run, or one with no repair, stays on the
// upgrade view, so it never appears above a repair it did not make.
function traceView() {
  const events = state.workspace?.events ?? [];
  if (state.job || !events.length) return null;
  const draft = state.workspace.draft;
  return !stopEvent(events) && draft && draft.origin === runOrigin(events) ? 'patch' : 'overview';
}

function runTrace(view) {
  if (traceView() !== view) return '';
  const events = state.workspace.events;
  const stopped = Boolean(stopEvent(events));
  const nemotron = runOrigin(events) === 'nemotron';
  const heading = `${nemotron ? 'How Nemotron worked' : 'How Ketchup checked the reference repair'}${stopped ? ` before the ${nemotron ? 'draft' : 'check'} stopped` : ''}`;
  const summary = runSummary(events);
  return `<section class="run-trace section" aria-labelledby="trace-title"><h2 id="trace-title">${heading}</h2>${summary ? `<p>${escape(summary)}</p>` : ''}${more(stepsLabel(events), `<ol class="trace" tabindex="0" aria-label="Run steps">${traceItems(events)}</ol>`, { cls: 'run-steps' })}</section>`;
}

// Live progress, read from event kinds so it holds for any project: what is happening now, the latest reason Nemotron gave,
// and where the run is against its plan.
const PHASES = ['Inspect the findings', 'Read the code', 'Draft and check edits', 'Review the behavior'];
function phaseIndex(events) {
  if (events.some(event => event.kind === 'complete')) return PHASES.length;
  if (events.some(event => event.kind === 'review')) return 3;
  if (events.some(event => event.kind === 'check')) return 2;
  return events.some(event => event.kind === 'tool') ? 1 : 0;
}

// What is happening now, naming who acts. After a tool or check result, it says what just happened and that Nemotron is choosing what to do next.
function nowText(events) {
  const last = events.at(-1);
  if (!last) return 'Sending the project to Nemotron…';
  if (events.length === 1 && last.kind === 'plan') return 'Waiting for Nemotron’s first step…';
  if (last.kind === 'tool' || last.kind === 'check') return `${eventTitle(last.title).replace(/\.$/, '')}. Nemotron is choosing its next step…`;
  return `${eventTitle(last.title)}${last.kind === 'complete' ? '' : '…'}`;
}

// Why Nemotron is doing what it does now: the reason from its latest decision, or the review's purpose once the review runs.
// A reasoning excerpt usually observes first and decides last, so the sentence that states the intent leads.
function whyText(events) {
  const review = phaseIndex(events) === 3 ? events.find(event => event.kind === 'review' && event.detail) : null;
  const turn = review ?? events.findLast((event, index) => index > 0 && event.kind === 'plan' && event.detail);
  const all = sentences(plainDetail(turn?.detail));
  const decision = review ? all[0] : all.findLast(sentence => /\b(I(?:'ll|’ll| will| should| need| must| am going)|let me|next|so I|then)\b/i.test(sentence)) ?? all.at(-1);
  const text = (decision ?? '').trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function phaseItems(events) {
  const current = phaseIndex(events);
  const read = events.filter(event => event.kind === 'tool' && /\bread\b/i.test(event.title) && !/npm|package/i.test(event.title)).length;
  const checks = events.filter(event => event.kind === 'check').length;
  const counts = ['', read ? ` (${plural(read, 'file')})` : '', checks ? ` (${plural(checks, 'check')})` : '', ''];
  return PHASES.map((phase, index) => {
    const status = index < current ? 'done' : index === current ? 'now' : 'next';
    return `<li data-state="${status}">${phase}${counts[index]}${status === 'next' ? '' : `<span class="phase-mark">: ${status === 'done' ? 'done' : 'in progress'}</span>`}</li>`;
  }).join('');
}

const elapsedText = () => `${clock(Date.now() - state.jobStartedAt)} elapsed`;

const sentences = text => String(text ?? '').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9“"'(])/).filter(Boolean);

// A partly checked upgrade leads with the note that limits the result, not one that reassures.
const LIMITING = /by hand|left out|could not|only the first|not flagged|entry only|unavailable/i;

function renderOverview() {
  const { bundle, analysis, draft } = state.workspace;
  const dependency = bundle.dependency;
  const hasErrors = analysis.target.length > 0;
  const coverage = analysis.coverage ?? { status: 'complete', notes: [] };
  const unlocated = (analysis.apiChanges ?? []).filter(change => !change.locations.length);
  const lines = new Set(analysis.introduced.map(item => `${item.file}:${item.line}`)).size;
  const status = draft && !state.job ? `A checked repair is ready. Before it, ${dependency.after.version} left ${plural(analysis.introduced.length, 'new error')}${lines > 1 ? ` on ${plural(lines, 'line')}` : ''}.`
    : analysis.introduced.length ? `${dependency.after.version} breaks ${plural(lines, 'line')} of this code: ${plural(analysis.introduced.length, 'new compiler error')}. It compiled with ${dependency.before.version}${analysis.baseline.length ? ' apart from the errors listed below' : ''}.`
    : analysis.baseline.length ? 'These errors already exist before the upgrade.' : coverage.status === 'complete' ? `The compiler found no new errors with ${dependency.after.version}.` : 'The compiler found no new errors in the code Ketchup could check.';
  const origin = bundle.origin;
  const notes = coverage.notes ?? [];
  const lead = coverage.status === 'partial' ? notes.find(note => LIMITING.test(note)) ?? notes[0] : notes[0];
  const restNotes = notes.filter(note => note !== lead);
  const about = sentences(bundle.description);
  const action = state.job ? draftPanel() : draft ? '<div class="task-action"><button class="button button-primary" data-page="patch">Review the repair</button></div>' : hasErrors ? `<div class="task-action">${draftPanel()}</div>` : '';
  // The story comes first, so the status and the action below it have context; the action precedes the long list of findings.
  return `${caseHeader()}<div class="task-heading"><div><h1 class="project-name">${escape(bundle.name)}</h1>${dependencyLine(dependency, analysis.introduced.length ? 'behind' : coverage.status === 'complete' ? 'current' : null)}</div></div>
    ${about.length ? `<p class="task-intro">${escape(about.slice(0, 2).join(' '))}</p>` : ''}
    ${bundle.intent ? `<p class="project-intent"><strong>Must keep working:</strong> ${escape(bundle.intent)}</p>` : ''}
    <p class="task-status">${status}</p>
    ${coverage.status !== 'complete' ? `<div class="coverage-note">${leadNote(`<strong>${coverage.status === 'unavailable' ? 'Not checked:' : 'Partly checked:'}</strong> ${noteHtml(lead || (coverage.status === 'unavailable' ? 'Ketchup could not compare these declarations, so no errors does not mean compatible.' : 'Some of this upgrade could not be compared.'))}`)}${restNotes.length ? more(plural(restNotes.length, 'more note'), `<ul>${restNotes.map(note => `<li>${noteHtml(note)}</li>`).join('')}</ul>`) : ''}</div>` : ''}
    ${action}
    ${origin || about.length > 2 ? more(origin ? `Read from <code>${escape(origin.folder)}</code>` : 'About this project', `${about.length > 2 ? `<p>${escape(about.slice(2).join(' '))}</p>` : ''}${origin ? `<p>Declarations: ${escape(origin.declarationSources.before)}; ${escape(origin.declarationSources.after)}.</p>${origin.omitted.length ? `<p>${plural(origin.omitted.length, 'item')} left out:</p><ul>${origin.omitted.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}` : ''}`, { cls: 'origin-line' }) : ''}
    ${analysis.findings.length ? `<section class="findings" aria-labelledby="findings-title"><h2 id="findings-title">What the upgrade breaks</h2>${findingFiles(analysis.findings).map(([file, groups]) => `<h3 class="findings-file"><code>${escape(file)}</code></h3>${groups.map(renderFinding).join('')}`).join('')}</section>` : ''}
    ${unlocated.length ? more(`${plural(unlocated.length, 'other API change')} in ${escape(dependency.after.version)} not traced to a line of this code`, `${coverage.notes.some(note => /dynamic access/i.test(note)) ? '<p>Check these by hand. Dynamic access, re-exports or code outside the selected files can hide a caller.</p>' : ''}<ul>${changeGroups(unlocated)}</ul>`, { cls: 'unlocated' }) : ''}
    ${analysis.baseline.length ? `<section class="baseline-diagnostics"><h2>Pre-existing errors</h2>${analysis.baseline.map((diagnostic, index) => `<button class="baseline-item" data-baseline="${index}"><code>${escape(diagnostic.file)}:${diagnostic.line}</code><span>${escape(diagnostic.message)}</span><span class="inspect-label">See line ${diagnostic.line}</span></button>`).join('')}</section>` : ''}
    ${runTrace('overview')}
    <div class="task-links"><button class="button-link" data-contract="compare">Compare API declarations</button>${!analysis.findings.length ? '<button class="button-link" data-contract="sources">Inspect source files</button>' : ''}${runDetailsLink('overview')}</div>`;
}

// A note that lists places ("Check by hand: A at x, y; B at z") shows them as a list instead of one run-on line.
function noteHtml(note) {
  const split = /^([^:]{8,160}):\s*(.+;.+)$/s.exec(note);
  if (!split) return withCode(note);
  const items = split[2].split(/;\s*/);
  // Sentences after the last item ("and 19 more. Compiling cleanly does not…") follow the list as their own line.
  const [last, ...after] = sentences(items.pop());
  items.push(last.replace(/\.$/, ''));
  return `${withCode(split[1])}:<ul>${items.map(item => `<li>${withCode(item)}</li>`).join('')}</ul>${after.length ? `<p>${withCode(after.join(' '))}</p>` : ''}`;
}

// A paragraph cannot hold a list, so a lead note that became one is a block instead.
const leadNote = html => html.includes('<ul>') ? `<div>${html}</div>` : `<p>${html}</p>`;

// Changes that share an owner and a kind ("MetricUnits.A was removed", "MetricUnits.B was removed") read as one line with the names after it.
function changeGroups(changes) {
  const ownerOf = symbol => symbol.includes('.') ? symbol.slice(0, symbol.lastIndexOf('.')) : '';
  const groups = new Map();
  for (const change of changes) {
    const key = `${ownerOf(change.symbol)}\u0000${change.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return [...groups.values()].flatMap(group => {
    const owner = ownerOf(group[0].symbol);
    if (group.length < 3 || !owner) return group.map(change => `<li><span><code>${escape(change.symbol)}</code> ${escape(changeVerb(change, false))}</span></li>`);
    const verb = { removed: 'removed', deprecated: 'deprecated' }[group[0].kind] ?? 'changed';
    return [`<li><span><code>${escape(owner)}</code>: ${group.length} members ${verb}</span><span class="evidence-detail">${group.map(change => `<code>${escape(change.symbol.slice(owner.length + 1))}</code>`).join(', ')}</span></li>`];
  }).join('');
}

// "Run details" appears only on a page that does not already show the run, and takes the reader to the one trace.
const runDetailsLink = view => traceView() && traceView() !== view ? '<button class="button-link" data-action="run-details">Run details</button>' : '';

// A finding whose title is not the compiler's own message carries a consequence (such as an alert that never fires); those lead.
const consequence = finding => !compilerText(finding).trim().startsWith(finding.title.trim());

// Findings on the same file and line share one card and one code snippet; cards are grouped by file, consequence cards first.
function findingFiles(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  const ranked = [...groups.values()].sort((a, b) => Number(b.some(consequence)) - Number(a.some(consequence)));
  const files = new Map();
  for (const group of ranked) files.set(group[0].file, [...(files.get(group[0].file) ?? []), group]);
  return [...files.entries()];
}

// "Subject consequence: change", as in "GpuIdle never fires: A is renamed to B", reads as three parts: who, what it means, what changed.
function headlineParts(finding) {
  if (!consequence(finding)) return null;
  const match = /^(\S+) ([^:]{2,40}): (.+)$/s.exec(finding.title.trim());
  if (!match) return null;
  const version = state.workspace.bundle.dependency.after.version;
  const change = match[3].endsWith(` in ${version}`) ? match[3].slice(0, -` in ${version}`.length) : match[3];
  return `<strong class="finding-subject">${withCode(match[1])}</strong> <span class="finding-consequence">${escape(match[2])}</span><span class="finding-change">: ${withCode(change)}</span>`;
}

// A finding card leads with what broke; the compiler's own words, the API signature and the code line sit behind one disclosure.
// `data-item` pairs each headline with its detail.
function renderFinding(group) {
  const [first] = group;
  const shown = new Set();
  const items = group.map((finding, index) => {
    const { change, named } = changeFor(finding);
    const signature = change && !shown.has(change.symbol) ? (shown.add(change.symbol), signatures(change)) : '';
    const detail = compilerText(finding).trim();
    const rest = named ? detail : detail.startsWith(finding.title.trim()) ? detail.slice(finding.title.trim().length).trim() : detail;
    // A compiler message that does not name the API change gets the change on its line as a visible cause.
    const cause = !named && change && !consequence(finding) ? `<span class="finding-explanation">Caused by: <code>${escape(change.symbol)}</code> ${escape(changeVerb(change, false))}</span>` : '';
    const headline = `<span class="finding-message" data-item="${index}">${named ? `<code>${escape(change.symbol)}</code> ${escape(changeVerb(change, false))}` : headlineParts(finding) ?? withCode(finding.title)}</span>${cause}`;
    const extra = `${rest ? `<span class="finding-explanation" data-item="${index}">${withCode(rest)}</span> ` : ''}${signature}`;
    return { headline, extra };
  });
  const details = `${items.map(item => item.extra).join(' ')} <code class="finding-code">${escape(first.snippet)}</code>`;
  return `<article class="finding-card"><button class="finding-main" data-source-finding="${escape(first.id)}" aria-label="${escape(`${group.map(finding => finding.title).join('; ')}. See line ${first.line} of ${first.file}`)}"><span class="finding-body">${items.map(item => item.headline).join(' ')}</span> <span class="inspect-label">See line ${first.line}</span></button>${more('Compiler detail', `<span class="finding-detail">${details}</span>`, { cls: 'finding-more' })}</article>`;
}

function draftPanel() {
  if (state.job && state.jobMode === 'rehearsal') return '<div class="job-progress"><div><span class="loading-ring" aria-hidden="true"></span><span id="job-live" role="status">Checking the reference repair…</span></div><button class="button button-outline" data-action="cancel">Stop</button></div>';
  if (state.job) {
    const events = state.job.events;
    const why = whyText(events);
    return `<div class="job-progress"><div><span class="loading-ring" aria-hidden="true"></span><span id="job-live" role="status">${escape(nowText(events))}</span></div><button class="button button-outline" data-action="cancel">Stop draft</button>
      <p id="job-why" class="job-why"${why ? '' : ' hidden'}><strong>Why:</strong> <span>${escape(why)}</span></p>
      <ol id="job-phases" class="job-phases" aria-label="Progress against Nemotron’s plan">${phaseItems(events)}</ol>
      <p class="job-elapsed"><span id="run-summary-live">${escape(runSummary(events))}</span> <span id="job-elapsed">${elapsedText()}</span></p></div>
    <section class="run-trace live" aria-label="Steps so far"${events.length ? '' : ' hidden'}>${more(`<span id="steps-live-label">${stepsLabel(events)}</span>`, `<ol id="trace-live" class="trace" tabindex="0" aria-label="Steps so far" data-count="${events.length}">${traceItems(events)}</ol>`, { open: state.stepsOpen, cls: 'run-steps' })}</section>`;
  }
  const configured = state.status?.keyConfigured;
  const sample = state.workspace.demoAvailable;
  const rejected = authRejected(state.workspace.events ?? []);
  const reference = label => `<button class="button-link" data-action="rehearsal">${label}</button>`;
  if (configured && rejected) return `<button class="button button-primary" data-action="setup">Set up Nemotron</button><p>NVIDIA rejected the configured key.</p>${sample ? reference('Check the fix that ships with this example') : ''}`;
  if (configured) return `<button class="button button-primary" data-action="nemotron">Draft a repair with Nemotron</button><p>You see what is sent before anything leaves this machine.</p>${sample ? reference('Or check the fix that ships with this example') : ''}`;
  if (sample) return '<button class="button button-primary" data-action="rehearsal">Check the fix that ships with this example</button><p>Ketchup compiles this example’s reference repair and runs its checks. No key needed.</p><button class="button-link" data-action="setup">Or set up Nemotron to draft your own</button>';
  return '<button class="button button-primary" data-action="setup">Set up Nemotron to draft a repair</button>';
}

function updateActivity() {
  if (!state.job) return;
  const events = state.job.events;
  const set = (selector, text) => { const element = $(selector); if (element && element.textContent !== text) element.textContent = text; };
  if (state.jobMode !== 'rehearsal') set('#job-live', nowText(events));
  const why = $('#job-why');
  if (why) { const text = whyText(events); why.hidden = !text; set('#job-why span', text); }
  const phases = $('#job-phases');
  const items = phaseItems(events);
  if (phases && phases.innerHTML !== items) phases.innerHTML = items;
  set('#job-elapsed', elapsedText());
  set('#run-summary-live', runSummary(events));
  set('#steps-live-label', stepsLabel(events));
  const section = $('.run-trace.live');
  if (section) section.hidden = !events.length;
  const trace = $('#trace-live');
  if (trace && events.length && trace.dataset.count !== String(events.length)) {
    trace.innerHTML = traceItems(events);
    trace.dataset.count = String(events.length);
  }
}

function changedDeclarations(bundle) {
  const { before, after } = bundle.dependency;
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path => before.files[path] !== after.files[path]);
}

// Aligns two versions of a file into rows: each row holds the old line, the new line, or both, so the two panes line up.
// A removed line next to an added one shares a row, which is how a rename reads. Large files use a greedy match.
function alignRows(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = [];
  if (a.length * b.length > 4_000_000) {
    const inA = new Set(a), inB = new Set(b);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) ops.push(['=', i++, j++]);
      else if (i < a.length && (!inB.has(a[i]) || j >= b.length)) ops.push(['-', i++]);
      else if (j < b.length && (!inA.has(b[j]) || i >= a.length)) ops.push(['+', j++]);
      else { ops.push(['-', i++]); ops.push(['+', j++]); }
    }
  } else {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) ops.push(['=', i++, j++]); else if (table[i + 1][j] >= table[i][j + 1]) ops.push(['-', i++]); else ops.push(['+', j++]);
    }
    while (i < a.length) ops.push(['-', i++]);
    while (j < b.length) ops.push(['+', j++]);
  }
  const rows = [];
  for (let index = 0; index < ops.length;) {
    if (ops[index][0] === '=') { rows.push({ a: ops[index][1] + 1, b: ops[index][2] + 1 }); index++; continue; }
    const removed = [], added = [];
    while (index < ops.length && ops[index][0] !== '=') { (ops[index][0] === '-' ? removed : added).push(ops[index][1] + 1); index++; }
    rows.push(...pairLines(removed, added, a, b));
  }
  return { rows, a, b };
}

// Within one changed stretch, each removed line pairs with the added line, in order, that shares the longest start with it,
// so 'DCGM_FI_DEV_GPU_TEMP' sits beside 'DCGM_FI_DEV_GPU_TEMP_CELSIUS'. Lines with no close partner get a row of their own.
function pairLines(removed, added, a, b) {
  if (removed.length * added.length > 40_000) return Array.from({ length: Math.max(removed.length, added.length) }, (_, k) => ({ a: removed[k] ?? null, b: added[k] ?? null, changed: true }));
  const shared = (x, y) => { let n = 0; while (n < x.length && n < y.length && x[n] === y[n]) n++; return n; };
  const rows = [];
  let next = 0;
  for (const line of removed) {
    const text = a[line - 1];
    let best = -1, score = 0;
    for (let j = next; j < added.length; j++) {
      const candidate = b[added[j] - 1];
      const length = shared(text.trim(), candidate.trim());
      if (length > score && length >= Math.max(4, Math.min(text.trim().length, candidate.trim().length) / 2)) { best = j; score = length; }
    }
    if (best < 0) { rows.push({ a: line, b: null, changed: true }); continue; }
    for (; next < best; next++) rows.push({ a: null, b: added[next], changed: true });
    rows.push({ a: line, b: added[best], changed: true });
    next = best + 1;
  }
  for (; next < added.length; next++) rows.push({ a: null, b: added[next], changed: true });
  // Neighbouring one-sided rows (a removed line, then an added one) share a row, as before.
  const merged = [];
  for (const row of rows) {
    const last = merged.at(-1);
    if (last && last.b === null && row.a === null && last.a !== null) { last.b = row.b; continue; }
    merged.push(row);
  }
  return merged;
}

// Marks the part of a changed line that differs from its partner, so a renamed name stands out inside a long line.
function markChange(text, partner) {
  if (partner === undefined || partner === null || text === partner) return escape(text) || ' ';
  let start = 0;
  while (start < text.length && start < partner.length && text[start] === partner[start]) start++;
  let end = 0;
  while (end < text.length - start && end < partner.length - start && text[text.length - 1 - end] === partner[partner.length - 1 - end]) end++;
  const middle = text.slice(start, text.length - end);
  return middle ? `${escape(text.slice(0, start))}<mark class="diff-word">${escape(middle)}</mark>${escape(text.slice(text.length - end))}` : escape(text) || ' ';
}

// The before and after panes of one declaration file, aligned row for row. Unchanged stretches longer than the context
// fold to one "unchanged lines" row in both panes, so the change and the declaration a finding is about are on screen.
const CONTEXT = 3;
function comparePanes(file, highlight) {
  const { before, after } = state.workspace.bundle.dependency;
  const textA = before.files[file], textB = after.files[file];
  const { rows, a, b } = alignRows(textA ?? '', textB ?? '');
  // The file's leading comment block (generator, source URLs, license) folds too, even where it changed.
  const [headA, headB] = [headerLength(a, highlight.before), headerLength(b, highlight.after)];
  const inHeader = row => (row.a ? row.a <= headA : true) && (row.b ? row.b <= headB : true);
  const keep = new Set();
  rows.forEach((row, index) => {
    if ((row.changed && !inHeader(row)) || (row.a && row.a === highlight.before) || (row.b && row.b === highlight.after)) for (let k = index - CONTEXT; k <= index + CONTEXT; k++) if (rows[k] && !inHeader(rows[k])) keep.add(k);
  });
  const anyChange = keep.size > 0;
  const shown = [];
  for (let index = 0; index < rows.length;) {
    if (inHeader(rows[index])) { index++; continue; }
    if (!anyChange || keep.has(index)) { shown.push(rows[index]); index++; continue; }
    let end = index;
    while (end < rows.length && !keep.has(end)) end++;
    shown.push({ gap: end - index });
    index = end;
  }
  const pane = side => {
    const lines = side === 'before' ? a : b;
    const other = side === 'before' ? b : a;
    const key = side === 'before' ? 'a' : 'b';
    const partnerKey = side === 'before' ? 'b' : 'a';
    const kind = side === 'before' ? 'remove' : 'add';
    const body = shown.map(row => {
      if (row.gap) return `<span class="code-line meta"><span class="line-number" aria-hidden="true"></span><span class="line-sign" aria-hidden="true"></span><span class="line-text">⋯ ${plural(row.gap, 'unchanged line')}</span></span>`;
      const number = row[key];
      if (!number) return '<span class="code-line filler" aria-hidden="true"><span class="line-number"></span><span class="line-sign"></span><span class="line-text"> </span></span>';
      const classes = [row.changed && kind, number === highlight[side] && 'highlight'].filter(Boolean).join(' ');
      const text = lines[number - 1];
      return `<span class="code-line ${classes}"><span class="line-number" aria-hidden="true">${number}</span><span class="line-sign" aria-hidden="true">${row.changed ? (side === 'before' ? '−' : '+') : ''}</span><span class="line-text">${row.changed ? markChange(text, row[partnerKey] ? other[row[partnerKey] - 1] : null) : escape(text) || ' '}</span></span>`;
    }).join('');
    const text = side === 'before' ? textA : textB;
    const version = state.workspace.bundle.dependency[side].version;
    const head = side === 'before' ? headA : headB;
    const note = head ? `<details class="code-note"><summary>File header (${plural(head, 'comment line')})</summary><pre>${escape(lines.slice(0, head).join('\n'))}</pre></details>` : '';
    return `<section><h2>${side === 'before' ? 'Before' : 'After'} <code>${escape(version)}</code></h2><div class="code-panel"><div class="code-header"><span>${escape(file)}</span><span class="code-lang">TypeScript</span></div>${note}<pre class="code-body" tabindex="0" aria-label="${escape(`${file}, ${version}`)}">${text === undefined ? '<span class="code-empty">File absent from this version.</span>' : body}</pre></div></section>`;
  };
  return `<div class="contract-comparison">${pane('before')}${pane('after')}</div>`;
}

// Names a finding is about: metric-style names and quoted identifiers in its title and the compiler's text, plus its API change.
function findingNames(finding) {
  const text = `${finding.title ?? ''} ${finding.detail ?? finding.message ?? ''}`;
  const names = [...(text.match(METRIC) ?? []), ...[...text.matchAll(/['"`]([A-Za-z_$][\w$]*)['"`]/g)].map(match => match[1])];
  const { change } = changeFor(finding);
  if (change) names.unshift(change.symbol.split('.').at(-1));
  return [...new Set(names)];
}

// The declaration a source finding is about, so the API change tab can mark it: the changed line in each version that names it.
function declarationFor(finding) {
  if (!finding || finding.file.startsWith('contracts/')) return null;
  const names = findingNames(finding);
  if (!names.length) return null;
  const { before, after } = state.workspace.bundle.dependency;
  for (const file of changedDeclarations(state.workspace.bundle)) {
    const { rows, a, b } = alignRows(before.files[file] ?? '', after.files[file] ?? '');
    const changed = rows.filter(row => row.changed);
    const find = (lines, key) => {
      for (const name of names) {
        const word = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`);
        const row = changed.find(item => item[key] && word.test(lines[item[key] - 1]));
        if (row) return row[key];
      }
      return null;
    };
    const old = find(a, 'a');
    const fresh = find(b, 'b');
    if (old || fresh) return { file, before: old, after: fresh };
  }
  return null;
}

function renderSource() {
  const { bundle, analysis } = state.workspace;
  const comparing = state.sourceTab !== 'sources';
  const { before, after } = bundle.dependency;
  const files = comparing ? { ...before.files, ...after.files } : bundle.sources;
  const changed = comparing ? changedDeclarations(bundle) : [];
  const paths = comparing ? [...changed, ...Object.keys(files).filter(path => !changed.includes(path))] : Object.keys(files);
  const fileKey = comparing ? 'contractFile' : 'sourceFile';
  if (!paths.includes(state[fileKey])) state[fileKey] = paths[0] ?? null;
  const file = state[fileKey];
  const finding = state.location ?? analysis.findings.find(item => item.id === state.finding);
  const contractFinding = finding?.file.startsWith('contracts/');
  const declaration = comparing ? declarationFor(finding) : null;
  const sourceLine = !comparing && finding?.file === file ? finding.line : null;
  const context = comparing && finding && bundle.sources[finding.file] !== undefined ? `<div class="caller-context"><code>${escape(finding.file)}:${finding.line}</code><code>${escape(finding.snippet ?? bundle.sources[finding.file].split('\n')[finding.line - 1])}</code></div>` : '';
  let content;
  if (comparing) {
    const side = finding?.side ?? 'after';
    const highlight = contractFinding && finding.file === `contracts/${file}` ? { before: side === 'before' ? finding.line : null, after: side === 'after' ? finding.line : null } : declaration?.file === file ? declaration : { before: null, after: null };
    const legend = changed.includes(file) ? `<p class="diff-legend"><span class="legend-remove">− Removed lines</span> are gone in ${escape(after.version)}. <span class="legend-add">+ Added lines</span> are new. The <mark class="diff-word">changed part</mark> of a line is marked; unchanged lines are folded.</p>` : file ? '<p class="code-caption">This file is the same in both versions.</p>' : '';
    content = file ? `${legend}${comparePanes(file, highlight)}` : '<p class="code-caption">No declaration files in this project.</p>';
  } else content = codePanel(file ?? 'No file selected', file ? files[file] : '', sourceLine);
  const fileButton = path => `<button class="file-button ${file === path ? 'selected' : ''}" data-file="${escape(path)}">${escape(path)}${comparing && changed.includes(path) ? ` <span class="file-tag">${before.files[path] === undefined ? 'new' : after.files[path] === undefined ? 'removed' : 'changed'}</span>` : ''}</button>`;
  const unchanged = paths.filter(path => !changed.includes(path));
  const fileList = paths.length < 2 ? '' : comparing && paths.length > 6 && unchanged.length
    ? `<div class="file-list" aria-label="Changed declaration files">${changed.map(fileButton).join('') || '<span class="code-caption">No declaration file changed.</span>'}</div><details class="unchanged-files" ${unchanged.includes(file) ? 'open' : ''}><summary>${plural(unchanged.length, 'unchanged file')}</summary><div class="file-list">${unchanged.map(fileButton).join('')}</div></details>`
    : `<div class="file-list" aria-label="Files">${paths.map(fileButton).join('')}</div>`;
  const tabs = `<div class="segmented" aria-label="Code view"><button data-source-tab="sources" class="${!comparing ? 'active' : ''}" aria-pressed="${!comparing}">Your code</button><button data-source-tab="compare" class="${comparing ? 'active' : ''}" aria-pressed="${comparing}">API change</button></div>`;
  return `<button class="back-link" data-page="overview">← Back to findings</button><div class="task-heading"><div><h1 class="project-name">${escape(bundle.name)}</h1><p class="page-role">Inspect the code</p></div></div><div class="source-tools">${tabs}</div>${fileList}${finding ? `<p class="code-caption">${withCode(finding.title ?? finding.message)}</p>` : ''}${context}${content}`;
}

// A leading comment block of two or more lines (authorship, provenance) folds behind "File header", unless it holds the marked line.
function headerLength(lines, highlightedLine) {
  let count = 0;
  while (count < lines.length && /^\s*(\/\/|\/\*|\*)/.test(lines[count])) count++;
  return count >= 2 && !(highlightedLine && highlightedLine <= count) ? count : 0;
}

function codePanel(path, code, highlightedLine = null, diff = false) {
  const lines = code ? code.split('\n') : [];
  const skip = diff ? 0 : headerLength(lines, highlightedLine);
  const note = skip ? `<details class="code-note"><summary>File header (${plural(skip, 'comment line')})</summary><pre>${escape(lines.slice(0, skip).join('\n'))}</pre></details>` : '';
  // A diff shows each file's name once, in place of git's four header lines.
  let inHeader = false;
  const shown = diff ? lines.flatMap(line => {
    if (line.startsWith('diff --git ')) { inHeader = true; return []; }
    if (line.startsWith('@@')) inHeader = false;
    if (!inHeader) return [line];
    return line.startsWith('+++ ') ? [`+++ ${line.slice(4).replace(/^b\//, '')}`] : [];
  }) : lines;
  // In a diff, each removed line sits beside the added line that replaces it, with the changed part marked, like the API change view.
  const items = [];
  for (let index = 0; index < shown.length;) {
    const isRemoved = text => text?.startsWith('-');
    const isAdded = text => text?.startsWith('+') && !text.startsWith('+++ ');
    if (!diff || !isRemoved(shown[index])) { items.push({ text: shown[index] }); index++; continue; }
    const removed = [], added = [];
    while (isRemoved(shown[index])) removed.push(shown[index++]);
    while (isAdded(shown[index])) added.push(shown[index++]);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      if (removed[k] !== undefined) items.push({ text: removed[k], partner: added[k]?.slice(1) });
      if (added[k] !== undefined) items.push({ text: added[k], partner: removed[k]?.slice(1) });
    }
  }
  const body = items.slice(skip).map(({ text: line, partner }, offset) => {
    const number = skip + offset + 1;
    const header = diff && line.startsWith('+++ ');
    const kind = header || (diff && line.startsWith('@@')) ? 'meta' : diff ? (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : '') : highlightedLine === number ? 'highlight' : '';
    const text = header ? line.slice(4) : line;
    const content = kind === 'add' || kind === 'remove' ? `${escape(text[0])}${markChange(text.slice(1), partner)}` : escape(text) || ' ';
    return `<span class="code-line ${kind}"><span class="line-number" aria-hidden="true">${diff ? '' : number}</span><span class="line-sign" aria-hidden="true"></span><span class="line-text">${content}</span></span>`;
  }).join('');
  return `<div class="code-panel"><div class="code-header"><span>${escape(path)}</span><span class="code-lang">${diff ? 'Unified diff' : 'TypeScript'}</span></div>${note}<pre class="code-body${diff ? ' is-diff' : ''}" tabindex="0" aria-label="${escape(path)}">${lines.length ? body : '<span class="code-empty">No content to display.</span>'}</pre></div>`;
}

function exportUrl(format) {
  return `/api/workspaces/${encodeURIComponent(state.workspace.id)}/export?format=${format}`;
}

function diagnosticList(title, diagnostics) {
  return diagnostics.length ? `<div class="check-group"><h2>${title}</h2><ul>${diagnostics.map(item => `<li><code>${escape(item.file)}:${item.line}</code> ${escape(item.message)}</li>`).join('')}</ul></div>` : '';
}

function renderCompilerResult(bundle, report) {
  const violations = report.violations ?? [];
  const preexisting = report.preexisting ?? [];
  const passed = report.accepted && !violations.length;
  const summary = passed ? `Compiles with ${escape(bundle.dependency.after.version)}: ${preexisting.length ? 'no new errors' : 'no errors'}.`
    : violations.length ? 'Not accepted: the repair breaks Ketchup’s repair rules.' : 'Not accepted: the repair still has compiler errors.';
  return `<div class="compiler-result ${passed ? 'passed' : 'failed'}"><p>${summary}</p>
    ${violations.length ? `<div class="check-group"><h2>Repair rules broken</h2><ul>${violations.map(item => `<li><code>${escape(item.file)}</code> ${escape(item.message)} <span class="rule-name">(${escape(item.rule)})</span></li>`).join('')}</ul></div>` : ''}
    ${diagnosticList('New compiler errors', report.remaining ?? [])}
    ${diagnosticList('Errors that existed before the upgrade', preexisting)}</div>`;
}

// Each cell is a state word and the metric it watches; prose beyond that (the reason a metric is missing) stays in the handoff.
// "Never fires: NAME is not in the 4.9.0 default metric list" reads "Never fires NAME"; any other wording is shown whole.
function signalCell(text, label) {
  const [, state = '', body = text] = /^([^:]{3,24}):\s*(.*)$/s.exec(text) ?? [];
  const metric = body.match(METRIC)?.[0];
  const note = /\(([^)]*)\)\s*$/.exec(body)?.[1];
  const rest = body.replace(METRIC, '').replace(/\([^)]*\)\s*$/, '').replace(/^\s*watches\s*/, '').replace(/\s*is not in the \S+ default metric list\.?\s*$/, '').trim();
  const tone = /^can fire/i.test(state) ? 'passed' : /never|silent|missing|wrong|different/i.test(state) ? 'failed' : 'attention';
  const content = metric && !rest ? `<code class="metric">${escape(metric)}</code>${note ? ` <span class="evidence-detail">${escape(note)}</span>` : ''}` : withCode(body);
  return `<td class="${tone}" data-label="${escape(label)}">${state ? `<span class="signal-state">${escape(state)}</span> ` : ''}${content}</td>`;
}

// One clause about the consequence: sentences of two words or fewer ("Same rules.") add nothing to it.
const operatorHeadline = text => { const all = sentences(text); const long = all.filter(sentence => sentence.split(/\s+/).length > 2); return (long.length ? long : all).join(' '); };

function renderOperator(evidence) {
  const operator = evidence.operator;
  const version = state.workspace.bundle.dependency.after.version;
  const [before, after] = [`On ${version}, unrepaired`, `On ${version}, repaired`];
  return `<section class="operator section" aria-labelledby="operator-title"><h2 id="operator-title">What on-call sees</h2><p class="operator-headline">${withCode(operatorHeadline(operator.headline))}</p>
    <div class="table-wrap"><table class="operator-table"><thead><tr><th scope="col">Alert</th><th scope="col">${escape(before)}</th><th scope="col">${escape(after)}</th></tr></thead><tbody>${operator.rows.map(row => `<tr><th scope="row"><span class="alert-name">${escape(row.rule ?? row.name)}</span>${severity(row) ? ` <span class="badge">${escape(severity(row))}</span>` : ''}${row.rule ? `<span class="evidence-detail">${escape(row.name)}</span>` : ''}</th>${signalCell(row.original, before)}${signalCell(row.repaired, after)}</tr>`).join('')}</tbody></table></div>
    ${evidence.note ? `<p class="evidence-note">${escape(evidence.note)}</p>` : ''}${nextAction(operator.nextAction, watchedMetrics(operator))}${connectorLine(watchedMetrics(operator))}</section>`;
}

// Severity named in the row's meaning ("On-call gets no critical alert when ...").
const severity = row => { const level = /\bno (\w+) alert\b/.exec(row.meaning ?? '')?.[1]; return level ? `${level[0].toUpperCase()}${level.slice(1)}` : ''; };

// Metric names the repaired rules watch, read from the operator rows ("Can fire: watches NAME ...").
function watchedMetrics(operator) {
  return [...new Set(operator.rows.map(row => /\bwatches ([A-Za-z_:][A-Za-z0-9_:]*)/.exec(row.repaired)?.[1]).filter(Boolean))].slice(0, 50);
}

function connectorLine(names) {
  const prometheus = state.connectors?.prometheus;
  if (!prometheus || !names.length) return '';
  if (!prometheus.configured) return '';
  const { result, error, busy } = state.prometheus;
  const rows = result ? `<div class="table-wrap"><table class="connector-table"><thead><tr><th scope="col">Metric</th><th scope="col">On ${escape(result.host)}</th></tr></thead><tbody>${result.metrics.map(metric => `<tr><th scope="row"><code>${escape(metric.name)}</code></th><td class="${metric.present ? 'passed' : 'failed'}">${metric.present ? `Present: ${metric.capped ? 'at least ' : ''}${metric.seriesCount} series` : 'Absent: no series'}</td></tr>`).join('')}</tbody></table></div><p class="evidence-note">Series seen in the ${Math.round(result.windowSeconds / 60)} minutes before ${escape(new Date(result.checkedAt).toLocaleString())}. Read-only; Ketchup changed nothing on ${escape(result.host)}.</p>` : '';
  return `<div class="connector-line connected"><button class="button button-outline" data-action="prometheus-check" ${busy ? 'disabled' : ''}>${busy ? `Checking on ${escape(prometheus.host)}…` : `Check these metric names on ${escape(prometheus.host)}`}</button>${error ? `<p class="field-error" role="alert">${escape(error)}</p>` : ''}${rows}</div>`;
}

function confirmPrometheus() {
  const host = state.connectors?.prometheus?.host;
  const evidence = state.workspace?.draft?.demo;
  if (!host || !evidence?.operator || state.prometheus.busy) return;
  const names = watchedMetrics(evidence.operator);
  dialog(`Contact ${escape(host)}?`, `<p>Ketchup will ask the Prometheus server at <code>${escape(host)}</code> whether each of these ${plural(names.length, 'metric name')} returned series in the last five minutes. It sends only the names, reads no other data and changes nothing.</p><ul class="metric-list">${names.map(name => `<li><code>${escape(name)}</code></li>`).join('')}</ul>`, `<button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="confirm-prometheus">Check on ${escape(host)}</button>`);
}

async function checkPrometheus() {
  const host = state.connectors?.prometheus?.host;
  const evidence = state.workspace?.draft?.demo;
  $('#modal').close();
  if (!host || !evidence?.operator) return;
  state.prometheus = { result: null, error: '', busy: true };
  render();
  try {
    state.prometheus.result = await api('/api/connectors/prometheus/check', { names: watchedMetrics(evidence.operator), confirmHost: host }, 600000);
  } catch (error) {
    state.prometheus.error = error.name === 'TimeoutError' ? `${host} did not answer in time.` : error.message;
  } finally {
    state.prometheus.busy = false;
    render();
    $('[data-action="prometheus-check"]')?.focus({ preventScroll: true });
  }
}

// A step that ends in a list of queries ("...: count(A), count(B)") shows them as a code list.
function actionStep(step) {
  const split = /^(.*?):\s*((?:[\w:]+\([^()]*\)(?:,\s*|\.?$))+)$/s.exec(step);
  if (!split) return withCode(step);
  const queries = split[2].replace(/\.$/, '').split(/,\s*/);
  return `${withCode(split[1])}:<ul class="query-list">${queries.map(query => `<li><code>${escape(query)}</code></li>`).join('')}</ul>`;
}

function nextAction(text, names = []) {
  const steps = /^1\. /.test(text) ? text.split(/\s+(?=\d+\. )/).map(step => step.replace(/^\d+\. /, '')) : [];
  const prometheus = state.connectors?.prometheus;
  const connect = prometheus && !prometheus.configured && names.length ? '<p class="connector-line">Ketchup can run that last check for you: set <code>KETCHUP_PROMETHEUS_URL</code> and restart Ketchup.</p>' : '';
  return steps.length > 1 ? more(`What on-call does next: ${plural(steps.length, 'step')}`, `<ol>${steps.map(step => `<li>${actionStep(step)}</li>`).join('')}</ol>${connect}`, { cls: 'next-action' }) : `<p class="next-action"><strong>What on-call does next:</strong> ${actionStep(text)}</p>${connect}`;
}

// The compiler line above already reports "Repair compiles", and comparing the reference repair with itself establishes nothing,
// so the page leaves those rows to the handoff. Each check's name and result show; how it works, its sources and the example's
// attribution are one click away.
function renderChecks(evidence, origin) {
  const checks = evidence.checks.filter(check => check.name !== 'Repair compiles' && !(origin === 'rehearsal' && check.name === 'Matches the reference repair'));
  const count = status => checks.filter(check => check.status === status).length;
  const [passed, failed, notRun] = [count('passed'), count('failed'), checks.length - count('passed') - count('failed')];
  const word = status => status === 'passed' ? 'Passed' : status === 'failed' ? 'Failed' : 'Not run';
  const table = `<div class="table-wrap"><table class="evidence-table"><thead><tr><th scope="col">Check</th><th scope="col">Result</th></tr></thead><tbody>${checks.map(check => `<tr><th scope="row">${escape(check.name)}${check.status === 'passed' ? '' : `<span class="evidence-detail">${withCode(check.detail)}</span>`}</th><td class="${check.status}">${word(check.status)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<p class="checks-count ${failed ? 'failed' : notRun ? '' : 'passed'}">${passed} of ${plural(checks.length, 'check')} passed${failed ? `, ${failed} failed` : ''}${notRun ? `, ${notRun} not run` : ''}.</p>${table}`;
}

// How each check works, the evidence sources and the example's attribution: one click away. A note that qualifies the on-call
// table sits beside that table instead.
function renderCheckSources(evidence) {
  const checks = evidence.checks.filter(check => check.name !== 'Repair compiles');
  const detail = `<ul class="check-details">${checks.map(check => `<li><strong>${escape(check.name)}:</strong> ${withCode(check.detail)}</li>`).join('')}</ul>${evidence.note && !evidence.operator ? `<p class="evidence-note">${escape(evidence.note)}</p>` : ''}
    ${evidence.sources?.length ? `<div class="sources"><h3>Sources</h3><ul>${evidence.sources.map(source => `<li><a href="${escape(source.url)}" target="_blank" rel="noreferrer">${escape(source.label)} ↗</a></li>`).join('')}</ul></div>` : ''}${caseAttribution()}`;
  return more(`How the checks work${evidence.sources?.length ? ' and sources' : ''}`, detail, { cls: 'checks-more' });
}

function renderReview(review) {
  return `<div class="behavior-review"><h3>Risks Nemotron’s review flagged</h3><p class="evidence-note">A second Nemotron pass read the repaired code. A model’s reading, not a test.</p>${review.summary ? `<p>${escape(review.summary)}</p>` : ''}${review.risks.length ? `<ul>${review.risks.map(risk => `<li><code>${escape(risk.file)}${risk.line ? `:${risk.line}` : ''}</code> ${escape(risk.concern)}</li>`).join('')}</ul>` : '<p>No specific risks were named.</p>'}</div>`;
}

// The payoff leads: what the repair does and who made it, the compiler's verdict, what on-call gets back and the download.
// The changes follow, then how it was made and checked as one section.
function renderPatch() {
  const { bundle, draft } = state.workspace;
  if (!draft) return `<button class="back-link" data-page="overview">← Back to findings</button><h1>No repair yet</h1>${emptyDraft()}`;
  // What Nemotron did, counted from its log, sits beside who made the repair; the log itself is one click away further down.
  const summary = draft.origin !== 'rehearsal' && traceView() === 'patch' ? runSummary(state.workspace.events) : '';
  const origin = draft.origin === 'rehearsal' ? 'Reference repair: the fix that ships with this example.' : `Drafted by Nemotron${summary ? `: ${summary[0].toLowerCase()}${summary.slice(1)}` : '.'}`;
  const evidence = draft.demo;
  const passed = draft.report.accepted && !(draft.report.violations ?? []).length && !(evidence?.checks ?? []).some(check => check.status === 'failed');
  const complete = (state.workspace.analysis.coverage?.status ?? 'complete') === 'complete';
  const runtime = evidence?.checks.length ? 'Checks cover this example only; run your own tests before merging.' : 'Behavior not tested; run your own tests before merging.';
  const reasons = sentences(draft.proposal.rationale);
  return `<button class="back-link" data-page="overview">← Back to findings</button>${caseHeader()}<div class="task-heading"><div><h1 class="project-name">${escape(bundle.name)}</h1><p class="page-role">Review the repair</p>${dependencyLine(bundle.dependency, !passed ? 'behind' : complete ? 'caught-up' : null, state.arrive)}</div></div>
    <div class="patch-summary"><p>${escape(draft.proposal.summary)}</p><p class="repair-origin">${origin}</p></div>
    ${renderCompilerResult(bundle, draft.report)}
    ${evidence?.operator ? renderOperator(evidence) : ''}
    <div class="download-actions">${passed ? `<a class="button button-primary" href="${exportUrl('patch')}" download>Download patch</a>` : ''}<a class="button-link" href="${exportUrl('report')}" download>Download handoff report (.md)</a><p>${runtime}</p></div>
    <section class="section" aria-labelledby="diff-title"><h2 id="diff-title" class="diff-title">Proposed changes</h2>${reasons.length > 1 ? `<ul class="repair-reason">${reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul>` : `<p class="repair-reason">${escape(draft.proposal.rationale)}</p>`}${codePanel(plural((draft.report.diff.match(/^\+\+\+ /gm) ?? []).length, 'changed file'), draft.report.diff, null, true)}</section>
    ${renderHow(draft, evidence)}
    <div class="task-links">${runDetailsLink('patch')}${state.status.keyConfigured && !authRejected(state.workspace.events ?? []) ? '<button class="button-link" data-action="nemotron">Draft again with Nemotron</button>' : '<button class="button-link" data-action="setup">Set up Nemotron to draft your own</button>'}</div>`;
}

// One section answers "how was this made and checked": what Nemotron did, the checks, the review, then how the checks work and
// the full log, each one click away.
function renderHow(draft, evidence) {
  const events = traceView() === 'patch' ? state.workspace.events : [];
  const nemotron = draft.origin !== 'rehearsal';
  const log = events.length ? `<div class="run-trace">${more(stepsLabel(events), `<ol class="trace" tabindex="0" aria-label="Run log">${traceItems(events)}</ol>`, { cls: 'run-steps' })}</div>` : '';
  const checks = evidence ? renderChecks(evidence, draft.origin) : '';
  if (!log && !checks && !draft.review) return '';
  return `<section class="reference-evidence section" aria-labelledby="checks-title"><h2 id="checks-title">${nemotron && events.length ? 'How Nemotron made it and how it was checked' : 'How it was checked'}</h2>
    ${nemotron ? log : ''}${checks}${draft.review ? renderReview(draft.review) : ''}${evidence ? renderCheckSources(evidence) : ''}${nemotron ? '' : log}</section>`;
}

function emptyDraft() {
  return `<p class="task-intro">${state.job ? 'The draft is still running.' : 'Go back to the findings to inspect one or draft a repair.'}</p><button class="button button-outline" data-page="overview">Back to findings</button>`;
}

function render() {
  const focused = document.activeElement;
  const focusedHeading = focused?.matches('#workspace h1');
  const focusedId = focused?.id;
  const focusKey = ['data-source-tab', 'data-file', 'data-action', 'data-demo'].find(key => focused?.hasAttribute(key));
  const focusValue = focusKey ? focused.getAttribute(focusKey) : null;
  renderShell();
  if (!state.status && state.error) {
    $('#workspace').innerHTML = `${banner()}<div class="empty-state"><h1>Reconnect to Ketchup</h1><p>Check that the local server is running, then try again.</p><button class="button button-primary" data-action="retry">Try again</button></div>`;
    return;
  }
  if (!state.status) return;
  const starting = state.page === 'start' || !state.workspace;
  const renderers = { overview: renderOverview, source: renderSource, patch: renderPatch };
  const away = state.job && !starting && state.page !== 'overview' ? `<p class="job-away" role="status"><span class="loading-ring" aria-hidden="true"></span>${state.jobMode === 'rehearsal' ? 'Checking the reference repair.' : 'Nemotron is drafting a repair.'} <button class="button-link" data-page="overview">Show progress</button></p>` : '';
  $('#workspace').innerHTML = `${banner()}${away}<div class="page-transition">${starting ? renderStart() : (renderers[state.page] ?? renderOverview)()}</div>`;
  try { sessionStorage.setItem('ketchup-view', JSON.stringify(starting ? {} : { id: state.workspace.id, page: state.page, sourceTab: state.sourceTab, sourceFile: state.sourceFile, contractFile: state.contractFile, finding: state.finding })); } catch {}
  $('#workspace').setAttribute('aria-busy', String(state.busy));
  document.title = starting ? START_TITLE : `${state.workspace.bundle.dependency.name}: ${state.workspace.bundle.dependency.before.version} → ${state.workspace.bundle.dependency.after.version} · Ketchup`;
  if (state.busy) $('#workspace').querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
  if (focusKey && !focused.isConnected) {
    [...document.querySelectorAll(`[${focusKey}]`)].find(element => element.getAttribute(focusKey) === focusValue && !element.disabled)?.focus({ preventScroll: true });
  }
  if (focused?.matches('.error-banner')) focusError();
  else if (focusedHeading) focusWorkspace();
  else if (focusedId && !focused.isConnected) document.getElementById(focusedId)?.focus({ preventScroll: true });
  syncHistory();
}

// Moving to another page drops notices and errors that belonged to the page left behind.
function goTo(page) {
  state.page = page;
  state.error = '';
  state.errorDetails = [];
  state.notice = '';
  render();
}

function focusWorkspace() {
  const heading = $('#workspace h1') ?? $('#workspace');
  heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

function focusError() {
  const error = $('.error-banner');
  error?.focus({ preventScroll: true });
  error?.scrollIntoView({ block: 'start' });
}

// Scrolls each code pane to its marked line, or in the API change view to the first changed line, so the change is in view.
function revealFinding() {
  let first = null;
  document.querySelectorAll('#workspace .code-body').forEach(pane => {
    const line = pane.querySelector('.code-line.highlight') ?? (pane.closest('.contract-comparison') ? pane.querySelector('.code-line.remove, .code-line.add') : null);
    if (!line) return;
    pane.scrollTop += line.getBoundingClientRect().top - pane.getBoundingClientRect().top - 30;
    first ??= pane.querySelector('.code-line.highlight');
  });
  first?.scrollIntoView({ block: 'nearest' });
}

function dialog(title, content, actions = '') {
  $('#modal-content').innerHTML = `<div class="dialog-body"><div class="dialog-top"><button class="dialog-close" data-action="close-modal" aria-label="Close dialog">×</button></div><h2 id="dialog-title">${title}</h2>${content}<div class="dialog-actions">${actions || '<button class="button button-outline" data-action="close-modal">Got it</button>'}</div></div>`;
  const modal = $('#modal');
  modal.setAttribute('aria-labelledby', 'dialog-title');
  if (!modal.open) modal.showModal();
}

function showSetup() {
  const rejected = state.status?.keyConfigured && authRejected(state.workspace?.events ?? []);
  dialog('Set up Nemotron', `<p>${rejected ? 'NVIDIA rejected the key this server has. Replace it, then restart.' : 'Findings and reference repairs work without a key. To draft repairs with Nemotron, give the server an NVIDIA API key once.'}</p>
    <p><a class="button button-outline" href="https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b" target="_blank" rel="noreferrer">Get API Key ↗</a></p>
    <ol class="setup-steps"><li><p>Create a file named <code>.env</code> in the Ketchup folder using your text editor.</p></li>
    <li><p>Add <code>NVIDIA_API_KEY=</code> followed by your key, then save the file.</p></li>
    <li><p>Stop the server, run <code>npm start</code>, and reload this page.</p></li></ol>
    <p>The key stays in <code>.env</code> on this computer. Keep this file out of version control and shared archives. Ketchup never asks you to paste a key into the browser.</p>
    ${more('Use an environment variable instead', '<p>If you already provide <code>NVIDIA_API_KEY</code> through your environment, <code>npm start</code> uses it without a <code>.env</code> file.</p>')}`, '<button class="button button-primary" data-action="close-modal">Close</button>');
}

function showHelp() {
  dialog('What goes in a bundle', `<p>Import one JSON file containing your TypeScript consumers and the old and new <code>.d.ts</code> snapshots for one dependency.</p><ul><li><code>format: 1</code>, a project name, and a description</li><li><code>dependency.name</code> and two snapshots: <code>before</code> and <code>after</code></li><li>Each snapshot has <code>version</code>, <code>entry</code>, and a <code>files</code> map</li><li>A <code>sources</code> map from relative paths to source text</li></ul><p>Include only files needed for the migration. Leave credentials and private configuration out of the bundle.</p>`, '<a class="button button-outline" href="/api/example" download>Download example bundle (.json)</a><button class="button button-primary" data-action="import">Choose JSON file</button>');
}

function confirmArchive() {
  if (state.job || state.busy || !state.workspace) return;
  dialog('Archive this project?', `<p><strong>${escape(projectLabel(state.workspace))}</strong> leaves the project menu. Its repair, run details and exports stay saved, and you can bring it back from Archived projects.</p>`, '<button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="confirm-archive">Archive project</button>');
}

async function archiveProject() {
  if (state.job || state.busy || !state.workspace) return;
  const workspace = state.workspace;
  $('#modal').close();
  await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/archive`, {});
  state.workspace = null;
  await refreshHistory();
  showStart();
  toast(`Archived ${workspace.bundle.name}. Restore it from Archived projects.`);
}

async function showArchive() {
  if (state.job || state.busy) return;
  const response = await api('/api/archive');
  const workspaces = response.projects ?? response.workspaces ?? [];
  dialog('Archived projects', workspaces.length ? `<ul class="archive-list">${workspaces.map(workspace => `<li><span>${escape(projectLabel(workspace))}</span><button class="button button-outline" data-restore="${escape(workspace.id)}">Restore</button></li>`).join('')}</ul>` : '<p>No archived projects. Archive a project from its page to move it out of the menu without deleting it.</p>');
}

async function restoreProject(id) {
  $('#modal').close();
  await api(`/api/archive/${encodeURIComponent(id)}/restore`, {});
  await refreshHistory();
  await openWorkspace(id);
  toast('Project restored.');
}

function confirmNemotron() {
  if (state.job || state.busy || !state.workspace) return;
  if (!state.status.keyConfigured) { showSetup(); return; }
  const sourceCount = Object.keys(state.workspace.bundle.sources).length;
  const source = state.workspace.bundle.dependency.source;
  dialog('Send this project to NVIDIA?', `<h3>Sent to NVIDIA</h3><ul><li>The project’s name and description</li><li>${plural(sourceCount, 'source file')}</li><li>The old and new API declarations</li><li>Compiler errors and local check results</li></ul>
    <h3>What it can do</h3><ul><li>Read and propose edits within this project only. Your original project stays unchanged.</li><li>${source ? `No npm data: ${escape(source.publisher)}’s published contract is the evidence.` : 'Read public npm metadata for this dependency.'}</li><li>A second, read-only Nemotron pass then reviews the repaired code.</li></ul>
    <h3>How long</h3><p>Up to about eight minutes. Each step shows on the page as it happens.</p><p>Model: <code>${escape(state.status.model)}</code>. Inspect the source files first if they contain sensitive information.</p>`, '<button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="confirm-nemotron">Send and draft</button>');
}

async function startDraft(mode) {
  if (state.job || state.busy || !state.workspace) return;
  $('#modal').close();
  state.busy = true;
  state.error = '';
  render();
  try {
    const job = await api(`/api/workspaces/${encodeURIComponent(state.workspace.id)}/draft`, { mode });
    const startedAt = Date.now();
    state.job = job;
    state.jobMode = mode;
    state.jobStartedAt = startedAt;
    try { sessionStorage.setItem('ketchup-job', JSON.stringify({ id: job.id, workspaceId: job.workspaceId, startedAt, mode })); } catch {}
    state.page = 'overview';
    state.busy = false;
    render();
    focusWorkspace();
    await pollJob(job, startedAt);
  } finally { state.busy = false; render(); }
}

// After a cancel request the server records "Draft stopped" once the run unwinds; wait up to five seconds for that final state.
async function settledJob(job) {
  let latest = job;
  for (let attempt = 0; latest.status === 'running' && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    latest = await api(`/api/jobs/${encodeURIComponent(job.id)}`).catch(() => latest);
  }
  return latest;
}

async function pollJob(initialJob, startedAt) {
  const generation = ++pollingGeneration;
  let job = initialJob;
  state.jobStartedAt = startedAt;
  try {
    while (job.status === 'running' && generation === pollingGeneration) {
      if (Date.now() - startedAt > DRAFT_LIMIT_MS) {
        await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {});
        job = await settledJob(job);
        throw new Error('The draft exceeded twelve minutes and was stopped. Review its recorded steps, then try a smaller bundle.');
      }
      await new Promise(resolve => setTimeout(resolve, 700));
      if (generation !== pollingGeneration) return;
      job = await api(`/api/jobs/${encodeURIComponent(job.id)}`);
      if (generation !== pollingGeneration) return;
      state.job = job;
      updateActivity();
    }
    if (generation !== pollingGeneration) return;
    const workspace = await api(`/api/workspaces/${encodeURIComponent(job.workspaceId)}`);
    if (generation !== pollingGeneration) return;
    setWorkspace(workspace);
    state.workspace.events = job.events;
    if (workspace.draft) state.page = 'patch';
    if (job.status === 'failed') throw new Error(job.error);
    if (job.status === 'complete') { state.page = 'patch'; state.arrive = true; setTimeout(() => { state.arrive = false; }, 300); }
  } catch (error) {
    if (generation !== pollingGeneration) return;
    if (state.workspace?.id === job.workspaceId) state.workspace.events = job.events;
    if (job.status === 'running') {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {}).catch(() => {
        error = new Error(`${error.message} The server could not confirm cancellation. Its own draft time limits remain in effect.`);
      });
    }
    throw error;
  } finally {
    if (generation === pollingGeneration) {
      state.job = null;
      try { sessionStorage.removeItem('ketchup-job'); } catch {}
      render();
      await refreshHistory().catch(error => fail(new Error(`Could not refresh project history: ${error.message}`)));
      if (state.error) focusError();
      else focusWorkspace();
    }
  }
}

async function cancelDraft() {
  if (!state.job) return;
  await api(`/api/jobs/${encodeURIComponent(state.job.id)}/cancel`, {});
  pollingGeneration++;
  const job = await settledJob(state.job);
  state.job = null;
  try { sessionStorage.removeItem('ketchup-job'); } catch {}
  setWorkspace(await api(`/api/workspaces/${encodeURIComponent(job.workspaceId)}`));
  state.workspace.events = job.events;
  state.page = state.workspace.draft ? 'patch' : 'overview';
  render();
  focusWorkspace();
  state.notice = `${state.jobMode === 'rehearsal' ? 'Check stopped.' : 'Draft stopped.'} The original project has not changed.`;
  render();
}

async function initialize() {
  state.error = '';
  state.errorDetails = [];
  state.status = await api('/api/status');
  state.demos = state.status.demos ?? await api('/api/demos').then(response => response.demos).catch(() => []);
  state.connectors = await api('/api/connectors').catch(() => null);
  await refreshHistory();
  let rememberedId;
  let pending;
  let resumeError = '';
  try { rememberedId = localStorage.getItem('ketchup-workspace'); pending = JSON.parse(sessionStorage.getItem('ketchup-job') || 'null'); } catch {}
  // The address wins over the remembered project, so a reload or a shared tab opens the page it names.
  const target = parseHash();
  const chosen = target?.start ? null : state.workspaces.find(workspace => workspace.id === (target?.id ?? rememberedId));
  if (pending && typeof pending.id === 'string' && typeof pending.workspaceId === 'string') {
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(pending.id)}`);
      setWorkspace(await api(`/api/workspaces/${encodeURIComponent(pending.workspaceId)}`));
      state.page = state.workspace.draft ? 'patch' : 'overview';
      state.workspace.events = job.events;
      if (job.status === 'running') {
        state.page = 'overview';
        state.job = job;
        state.jobMode = pending.mode === 'rehearsal' ? 'rehearsal' : 'nemotron';
        render();
        await pollJob(job, Number.isFinite(pending.startedAt) ? pending.startedAt : Date.now());
        return;
      }
      sessionStorage.removeItem('ketchup-job');
      if (job.status === 'failed') state.error = job.error;
      else if (job.status === 'complete') state.page = 'patch';
      render();
      if (state.error) focusError();
      return;
    } catch (error) {
      try { sessionStorage.removeItem('ketchup-job'); } catch {}
      state.job = null;
      resumeError = `Previous draft could not be resumed: ${error.message}`;
    }
  }
  if (chosen) {
    setWorkspace(await api(`/api/workspaces/${encodeURIComponent(chosen.id)}`));
    state.page = state.workspace.draft ? 'patch' : 'overview';
    // A reload returns to the page the reader was on.
    let view = null;
    try { view = JSON.parse(sessionStorage.getItem('ketchup-view') || 'null'); } catch {}
    const page = target?.id === chosen.id ? target.page : view?.id === chosen.id ? view.page : null;
    if (['overview', 'source', 'patch'].includes(page) && (page !== 'patch' || state.workspace.draft)) {
      state.page = page;
      if (page === 'source' && view?.id === chosen.id) {
        const sources = state.workspace.bundle.sources;
        state.sourceTab = view.sourceTab === 'compare' ? 'compare' : 'sources';
        if (sources[view.sourceFile] !== undefined) state.sourceFile = view.sourceFile;
        if (typeof view.contractFile === 'string') state.contractFile = view.contractFile;
        state.finding = state.workspace.analysis.findings.some(item => item.id === view.finding) ? view.finding : null;
      }
    }
  } else state.page = 'start';
  state.error = [resumeError, ...(state.status.warnings ?? [])].filter(Boolean).join(' ');
  render();
  if (state.error) focusError();
}

const actions = {
  import: () => { if (state.job || state.busy) return; $('#modal').close(); $('#import-file').click(); },
  setup: showSetup,
  help: showHelp,
  rehearsal: () => startDraft('rehearsal'),
  nemotron: confirmNemotron,
  'confirm-nemotron': () => startDraft('nemotron'),
  'prometheus-check': confirmPrometheus,
  'confirm-prometheus': checkPrometheus,
  archive: confirmArchive,
  'confirm-archive': archiveProject,
  'show-archive': showArchive,
  cancel: cancelDraft,
  'run-details': () => {
    const view = traceView();
    if (view && view !== state.page) { goTo(view); }
    const trace = $('.run-trace:not(.live)');
    if (!trace) return;
    trace.querySelector('details').open = true;
    trace.scrollIntoView({ block: 'start' });
    trace.querySelector('.trace').focus({ preventScroll: true });
  },
  'export-input': () => { if (state.workspace && state.page !== 'start') location.href = exportUrl('bundle'); },
  'close-modal': () => $('#modal').close(),
  'dismiss-error': () => { state.error = ''; state.errorDetails = []; render(); },
  'dismiss-notice': () => { state.notice = ''; render(); },
  retry: initialize,
};

document.addEventListener('click', event => {
  if (event.target.closest('.brand')) {
    event.preventDefault();
    if (state.job) toast('Stop the draft, or let it finish, before leaving this project.');
    else if (!state.busy && state.status) showStart();
    return;
  }
  const control = event.target.closest('button');
  if (!control || control.disabled || control.form) return;
  if (control.dataset.page) {
    showPage(control.dataset.page);
  } else if (control.dataset.demo !== undefined) {
    createDemo(control.dataset.demo).catch(fail);
  } else if (control.dataset.restore) {
    restoreProject(control.dataset.restore).catch(fail);
  } else if (control.dataset.sourceFinding || control.dataset.baseline !== undefined) {
    const finding = control.dataset.baseline !== undefined ? state.workspace.analysis.baseline[Number(control.dataset.baseline)] : state.workspace.analysis.findings.find(item => item.id === control.dataset.sourceFinding);
    if (!finding) return;
    state.returnTo = state.page === 'overview' ? { scroll: window.scrollY, finding: control.dataset.sourceFinding ?? null } : null;
    state.finding = control.dataset.sourceFinding ?? null;
    state.location = { ...finding, side: control.dataset.baseline !== undefined ? 'before' : 'after' };
    state.sourceTab = finding.file.startsWith('contracts/') ? 'compare' : 'sources';
    if (finding.file.startsWith('contracts/')) state.contractFile = finding.file.slice('contracts/'.length);
    else state.sourceFile = finding.file;
    goTo('source');
    window.scrollTo({ top: 0 });
    const code = $('.code-line.highlight')?.closest('.code-body') ?? $('.code-body');
    code?.focus({ preventScroll: true });
    revealFinding();
  } else if (control.dataset.contract) {
    // Opened from the overview, the code view starts with no finding selected.
    state.sourceTab = control.dataset.contract;
    state.finding = null;
    state.location = null;
    state.returnTo = null;
    goTo('source');
    focusWorkspace();
  } else if (control.dataset.sourceTab) {
    state.sourceTab = control.dataset.sourceTab;
    const declaration = state.sourceTab === 'compare' ? declarationFor(state.location ?? state.workspace.analysis.findings.find(item => item.id === state.finding)) : null;
    if (declaration) state.contractFile = declaration.file;
    render();
    revealFinding();
  } else if (control.dataset.file) {
    const fileKey = state.sourceTab === 'sources' ? 'sourceFile' : 'contractFile';
    if (state[fileKey] === control.dataset.file) return;
    state[fileKey] = control.dataset.file;
    if (state.sourceTab === 'sources') { state.finding = null; state.location = null; }
    render();
    revealFinding();
  } else if (control.dataset.action && actions[control.dataset.action]) {
    Promise.resolve().then(actions[control.dataset.action]).catch(fail);
  }
});

document.addEventListener('submit', event => {
  event.preventDefault();
  (event.target.id === 'inspect-form' ? inspectProject() : event.target.id === 'prepare-form' ? prepareProject() : Promise.resolve()).catch(fail);
});
// The before and after panes hold the same rows, so scrolling one scrolls the other.
document.addEventListener('scroll', event => {
  const pane = event.target;
  if (!pane.matches?.('.contract-comparison .code-body')) return;
  pane.closest('.contract-comparison').querySelectorAll('.code-body').forEach(other => { if (other !== pane && Math.abs(other.scrollTop - pane.scrollTop) > 1) other.scrollTop = pane.scrollTop; });
}, true);
document.addEventListener('toggle', event => { if (event.target.matches?.('.run-trace.live details')) state.stepsOpen = event.target.open; }, true);
document.addEventListener('input', event => {
  if (event.target.id === 'project-path') state.intake.path = event.target.value;
  if (event.target.id === 'target-version') state.intake.version = event.target.value;
});
document.addEventListener('change', event => {
  if (event.target.id === 'intake-dependency') { state.intake.dependency = event.target.value; state.intake.version = state.intake.info?.dependencies.find(item => item.name === event.target.value)?.latest ?? ''; render(); }
});
$('#import-file').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  importBundle(file).catch(fail);
});
window.addEventListener('popstate', () => { followHistory().catch(fail); });
$('#project-select').addEventListener('change', event => {
  if (event.target.value === '__start') showStart();
  else openWorkspace(event.target.value).catch(fail);
});
$('#modal').addEventListener('click', event => {
  const rectangle = $('#modal').getBoundingClientRect();
  if (event.target === $('#modal') && (event.clientX < rectangle.left || event.clientX > rectangle.right || event.clientY < rectangle.top || event.clientY > rectangle.bottom)) $('#modal').close();
});
initialize().catch(fail);
