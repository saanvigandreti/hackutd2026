// `run` comes from assets/run.js: a real Nemotron run on the GPU alerts example, exported from its log.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(resolve => setTimeout(resolve, reduced ? 0 : ms));
const clamp = value => Math.min(1, Math.max(0, value));
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const escape = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A draggable tomato on a rail. onChange gets a value from 0 to 1.
function slider(element, { onChange = () => {}, onRelease = () => {} } = {}) {
  const rail = $('.rail', element);
  const state = { value: 0 };
  state.set = next => {
    state.value = clamp(next);
    element.style.setProperty('--v', state.value.toFixed(4));
    element.setAttribute('aria-valuenow', Math.round(state.value * 100));
    onChange(state.value);
  };
  const fromPointer = event => { const box = rail.getBoundingClientRect(); return (event.clientX - box.left) / box.width; };
  element.addEventListener('pointerdown', event => {
    element.classList.add('held');
    element.setPointerCapture(event.pointerId);
    state.set(fromPointer(event));
  });
  element.addEventListener('pointermove', event => { if (element.classList.contains('held')) state.set(fromPointer(event)); });
  element.addEventListener('pointerup', () => { element.classList.remove('held'); onRelease(state.value); });
  element.addEventListener('keydown', event => {
    const step = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05, End: 1, Home: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    state.set(state.value + step);
    onRelease(state.value);
  });
  return state;
}

// Intro: catch the code up from 4.8.4 to 4.9.0. Let go early and it rolls back.
const hero = $('.hero-slider');
const hint = $('.hint');
const heroSlider = slider(hero, {
  onChange: value => { if (value < 1) hero.classList.remove('done'); },
  onRelease: value => {
    if (value > 0.94) {
      heroSlider.set(1);
      hero.classList.add('done');
      hint.textContent = 'Caught up to 4.9.0. Here is what that takes.';
      return;
    }
    hint.textContent = 'Your code still targets 4.8.4. Drag the tomato to catch it up.';
    const roll = () => { if (!hero.classList.contains('held') && heroSlider.value > 0) { heroSlider.set(heroSlider.value - Math.max(0.01, heroSlider.value * 0.08)); requestAnimationFrame(roll); } };
    requestAnimationFrame(roll);
  },
});

// The problem: eight GPU alert rules and the metric each one watches.
const ALERTS = [
  ['GpuTemperatureHigh', 'DCGM_FI_DEV_GPU_TEMP', 'DCGM_FI_DEV_GPU_TEMP<mark>_CELSIUS</mark>'],
  ['GpuMemoryTemperatureHigh', 'DCGM_FI_DEV_MEMORY_TEMP', 'DCGM_FI_DEV_MEMORY_TEMP<mark>_CELSIUS</mark>'],
  ['GpuXidError', 'DCGM_FI_DEV_XID_ERRORS', 'DCGM_FI_DEV_XID_<mark>ERROR</mark>'],
  ['GpuRowRemapFailed', 'DCGM_FI_DEV_ROW_REMAP_FAILURE', 'DCGM_FI_DEV_ROW_REMAP_<mark>FAILED</mark>'],
  ['GpuBoardPowerHigh', 'DCGM_FI_DEV_POWER_USAGE', 'DCGM_FI_DEV_<mark>BOARD_POWER_WATTS</mark>'],
  ['GpuIdle', 'DCGM_FI_DEV_GPU_UTIL', 'DCGM_FI_DEV_GPU_UTIL<mark>_RATIO</mark>'],
  ['GpuFramebufferHigh', 'DCGM_FI_DEV_FB_USED', 'DCGM_FI_DEV_FB_USED<mark>_BYTES</mark>'],
  ['GpuSmClockLow', 'DCGM_FI_DEV_SM_CLOCK', 'DCGM_FI_DEV_SM_CLOCK<mark>_HERTZ</mark>'],
];
const SUMMARY = {
  before: 'On 4.8.4, all eight rules match a metric the exporter reports.',
  broken: 'On 4.9.0, none of them match. No error, no page.',
  fixed: 'After Ketchup, every rule watches its 4.9.0 metric, with limits converted to the new units.',
};
const alertRows = $('[data-alerts]');
alertRows.innerHTML = ALERTS.map(([name, metric]) => `<tr><td>${name}</td><td><code>${metric}</code></td><td><span class="state">can fire</span></td></tr>`).join('');
const rows = $$('tr', alertRows);
const alertsHopper = $('[data-alerts-wrap] .hopper');
let alertsRun = 0;
async function showAlerts(state) {
  const id = ++alertsRun;
  $$('.tabs button').forEach(button => button.setAttribute('aria-checked', String(button.dataset.state === state)));
  $('[data-sum]').textContent = SUMMARY[state];
  for (const [index, row] of rows.entries()) {
    if (id !== alertsRun) return;
    const [, old, renamed] = ALERTS[index];
    if (state === 'fixed') {
      const cell = row.lastElementChild.getBoundingClientRect();
      const wrap = alertsHopper.parentElement.getBoundingClientRect();
      alertsHopper.style.transform = `translate(${cell.left - wrap.left - 28}px, ${cell.top - wrap.top + cell.height / 2 - 11}px)`;
      alertsHopper.classList.add('show');
      await wait(140);
    }
    const off = state === 'broken';
    row.classList.toggle('off', off);
    row.classList.toggle('lit', state === 'fixed');
    $('code', row).innerHTML = state === 'fixed' ? renamed : old;
    $('.state', row).textContent = off ? 'silent' : 'can fire';
    if (state === 'broken') await wait(70);
  }
  await wait(200);
  if (id === alertsRun) alertsHopper.classList.remove('show');
}
$$('.tabs button').forEach(button => button.addEventListener('click', () => showAlerts(button.dataset.state)));
showAlerts('before');
new IntersectionObserver((entries, observer) => {
  if (!entries.some(entry => entry.isIntersecting)) return;
  observer.disconnect();
  setTimeout(() => { if ($('.tabs [data-state="before"]').getAttribute('aria-checked') === 'true') showAlerts('broken'); }, 1200);
}, { threshold: 0.6 }).observe($('.alerts'));

// The fix: scrub through the real run. The log shows every event up to that moment.
const log = $('[data-log]');
const clockText = $('[data-clock]');
const who = event => {
  if (event.kind === 'check') return event.title.includes('passed') ? ['Check', 'good'] : ['Check', 'bad'];
  if (event.kind === 'complete') return ['Done', 'good'];
  if (event.kind === 'review' || event.title.startsWith('Reviewer')) return ['Reviewer', ''];
  return event.kind === 'plan' ? ['Nemotron', ''] : ['Tool', ''];
};
let shown = -1;
function showRun(value) {
  const seconds = value * run.seconds;
  clockText.textContent = `${clock(seconds)} / ${clock(run.seconds)}`;
  const events = run.events.filter(event => event.t <= seconds);
  if (events.length === shown) return;
  shown = events.length;
  log.innerHTML = events.length ? events.map(event => {
    const [name, tone] = who(event);
    return `<li><time>${clock(event.t)}</time><span class="who ${tone}">${name}</span><span>${escape(event.title)}<span class="d">${escape(event.detail)}</span></span></li>`;
  }).join('') : '<li class="empty">The run starts when Ketchup sends Nemotron the compiler errors.</li>';
  log.scrollTop = log.scrollHeight;
}
let playing = 0;
const runSlider = slider($('.run-slider'), { onChange: showRun });
$('.run-slider').addEventListener('pointerdown', () => { playing = 0; $('[data-play]').textContent = '▶'; });
$('[data-play]').addEventListener('click', event => {
  if (playing) { playing = 0; event.currentTarget.textContent = '▶'; return; }
  if (runSlider.value >= 1) runSlider.set(0);
  const id = playing = performance.now();
  const from = runSlider.value;
  event.currentTarget.textContent = '❚❚';
  const step = now => {
    if (playing !== id) return;
    const value = from + (now - id) / 30000;
    runSlider.set(value);
    if (value < 1) requestAnimationFrame(step); else { playing = 0; $('[data-play]').textContent = '▶'; }
  };
  requestAnimationFrame(step);
});
showRun(0);

// Three real upgrades: compiler errors before, and how long Nemotron's accepted repair took.
const PROJECTS = [
  ['GPU health alerts', 'dcgm-exporter', '4.8.4', '4.9.0', 11, '2 min 38 s'],
  ['OpenTelemetry metrics', '@opentelemetry/sdk-metrics', '1.30.1', '2.0.0', 1, '39 s'],
  ['sensor-routing', 'zod', '3.25.76', '4.6.7', 4, '2 min 6 s'],
];
const plural = count => `${count} error${count === 1 ? '' : 's'}`;
$('[data-projects]').innerHTML = PROJECTS.map(([name, pkg, from, to, errors, time]) => `<tr tabindex="0" data-errors="${errors}">
  <td>${name}</td>
  <td><span class="mini"><code>${pkg}</code></span><span class="mini">${from}<span class="rail"><span class="fill"></span><svg class="ball" aria-hidden="true"><use href="#ball"/></svg></span>${to}</span></td>
  <td class="errs">${plural(errors)}</td><td>${time}</td></tr>`).join('');
$$('[data-projects] tr').forEach(row => {
  const roll = async () => {
    const errs = $('.errs', row);
    const total = Number(row.dataset.errors);
    if (!row.classList.toggle('done')) { row.style.setProperty('--v', 0); errs.textContent = plural(total); return; }
    row.style.setProperty('--v', 1);
    for (let left = total - 1; left >= 0; left--) { await wait(900 / total); errs.textContent = left ? plural(left) : 'none'; }
  };
  row.addEventListener('click', roll);
  row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); roll(); } });
});

$('[data-copy]').addEventListener('click', async event => {
  await navigator.clipboard.writeText($('.code code').textContent);
  event.target.textContent = 'Copied';
  setTimeout(() => { event.target.textContent = 'Copy'; }, 1500);
});

// GitHub link: set data-repo on <html>, or it is worked out from a github.io address.
const repoLink = $('[data-repo-link]');
const [user] = location.hostname.endsWith('.github.io') ? location.hostname.split('.') : [];
const repo = document.documentElement.dataset.repo
  || (user ? `https://github.com/${user}/${location.pathname.split('/').filter(Boolean)[0] ?? `${user}.github.io`}` : '');
if (repo) { repoLink.href = repo; repoLink.hidden = false; }
