import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeBundle, checkPatch, makeDiff, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, MAX_FILES, validateBundle } from '../src/engine.ts';
import { demoBundle, demoEvidence, isDemoBundle, rehearsalProposal } from '../src/demo.ts';
import type { MigrationBundle } from '../src/types.ts';
import { smallBundle } from './support.ts';

const small = (): MigrationBundle => validateBundle(smallBundle());
const otel = (): MigrationBundle => validateBundle(JSON.parse(readFileSync(new URL('../fixtures/otel-metrics.json', import.meta.url), 'utf8')));
const otelReference = readFileSync(new URL('../fixtures/otel-metrics-reference.ts.txt', import.meta.url), 'utf8');

test('finds the removed OpenTelemetry method at its actual caller', () => {
  const result = analyzeBundle(otel());
  assert.deepEqual(result.baseline, []);
  assert.deepEqual(result.introduced.map((item) => [item.file, item.line, item.code]), [
    ['src/metrics.ts', 5, 2339],
  ]);
  assert.equal(result.affectedFileCount, 1);
  assert.match(result.findings[0]?.detail ?? '', /Property 'addMetricReader'/);
  assert.deepEqual(result.apiChanges[0], { kind: 'removed', symbol: 'MeterProvider.addMetricReader', before: 'addMetricReader(metricReader: MetricReader): void', after: null, locations: [{ file: 'src/metrics.ts', line: 5 }] });
  assert.equal(result.coverage.status, 'complete');
});

test('repairs an unrelated package migration using exact snippets', () => {
  const bundle = small();
  const analysis = analyzeBundle(bundle);
  assert.equal(analysis.introduced[0]?.code, 2345);
  const result = checkPatch(bundle, [{ path: 'src/label.ts', before: "label('Cooling', 'Rack: ')", after: "label('Cooling', { prefix: 'Rack: ' })" }]);
  assert.equal(result.accepted, true);
  assert.equal(result.resolvedCount, 1);
  assert.equal(result.files['src/label.ts'], "import { label } from 'label-kit';\nexport const title = label('Cooling', { prefix: 'Rack: ' });\n");
  assert.equal(bundle.sources['src/label.ts'], "import { label } from 'label-kit';\nexport const title = label('Cooling', 'Rack: ');\n");
});

test('distinguishes changed diagnostics even when before and after counts are equal', () => {
  const bundle = small();
  bundle.dependency.before.files['index.d.ts'] = 'export declare function label(value: string): string;';
  bundle.dependency.after.files['index.d.ts'] = 'export declare function label(value: number): string;';
  bundle.sources['src/label.ts'] = "import { label } from 'label-kit';\nexport const a = label(3);\nexport const b = label('three');\n";
  const report = analyzeBundle(bundle);
  assert.equal(report.baseline.length, 1);
  assert.equal(report.target.length, 1);
  assert.equal(report.introduced.length, 1);
  assert.equal(report.baseline[0]?.line, 2);
  assert.equal(report.introduced[0]?.line, 3);
});

test('does not hide a new caller error behind an identical baseline message elsewhere', () => {
  const bundle = small();
  bundle.dependency.before.files['index.d.ts'] = 'export declare function first(value: string): string; export declare function second(value: number): string;';
  bundle.dependency.after.files['index.d.ts'] = 'export declare function first(value: number): string; export declare function second(value: string): string;';
  bundle.sources['src/label.ts'] = "import { first, second } from 'label-kit';\nexport const a = first(3);\nexport const b = second(3);\n";
  const report = analyzeBundle(bundle);
  assert.equal(report.baseline[0]?.line, 2);
  assert.equal(report.target[0]?.line, 3);
  assert.equal(report.introduced[0]?.line, 3);
});

test('accepts a correct migration and reports an unrelated baseline error as pre-existing', () => {
  const bundle = small();
  bundle.sources['src/existing.ts'] = 'export const alreadyBroken: number = "wrong";';
  const analysis = analyzeBundle(bundle);
  assert.equal(analysis.baseline[0]?.code, 2322);
  assert.equal(analysis.introduced.length, 1);
  const result = checkPatch(bundle, [{ path: 'src/label.ts', before: "label('Cooling', 'Rack: ')", after: "label('Cooling', { prefix: 'Rack: ' })" }]);
  assert.equal(result.accepted, true);
  assert.equal(result.resolvedCount, 1);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.diagnostics.map((item) => [item.file, item.code]), [['src/existing.ts', 2322]]);
  assert.deepEqual(result.preexisting.map((item) => [item.file, item.code]), [['src/existing.ts', 2322]]);
});

test('a pre-existing error still counts once its line moves, and a new copy of it does not', () => {
  const bundle = small();
  bundle.sources['src/label.ts'] = `const broken: number = "wrong";\n${bundle.sources['src/label.ts']}`;
  const moved = checkPatch(bundle, [{ path: 'src/label.ts', before: "export const title = label('Cooling', 'Rack: ');", after: "\n\nexport const title = label('Cooling', { prefix: 'Rack: ' });\nvoid broken;" }]);
  assert.equal(moved.accepted, true);
  assert.equal(moved.preexisting.length, 1);
  const copied = checkPatch(bundle, [{ path: 'src/label.ts', before: "export const title = label('Cooling', 'Rack: ');", after: "export const title = label('Cooling', { prefix: 'Rack: ' });\nconst broken2: number = \"wrong\";\nvoid broken; void broken2;" }]);
  assert.equal(copied.accepted, false);
  assert.equal(copied.remaining.length, 1);
});

test('rejects incomplete repairs instead of using a reduced error count as success', () => {
  const bundle = small();
  bundle.sources['src/label.ts'] += "export const other = label('Power', 'Rack: ');\n";
  const result = checkPatch(bundle, [{ path: 'src/label.ts', before: "label('Cooling', 'Rack: ')", after: "label('Cooling', { prefix: 'Rack: ' })" }]);
  assert.equal(result.accepted, false);
  assert.equal(result.resolvedCount, 1);
  assert.equal(result.remaining.length, 1);
});

test('resolves local source imports and multi-file declaration snapshots', () => {
  const bundle = small();
  bundle.dependency.before.files = { 'index.d.ts': "export { label } from './format';", 'format.d.ts': 'export declare function label(value: string, prefix: string): string;' };
  bundle.dependency.after.files = { 'index.d.ts': "export { label } from './format';", 'format.d.ts': 'export declare function label(value: string, options: { prefix: string }): string;' };
  bundle.sources['src/main.ts'] = "import { title } from './label';\nexport const result: string = title;";
  const result = analyzeBundle(validateBundle(bundle));
  assert.deepEqual(result.baseline, []);
  assert.deepEqual(result.introduced.map((item) => item.code), [2345]);
  assert.equal(result.sourceCount, 2);
});

test('blocks host files and undeclared packages without executing source', () => {
  const bundle = small();
  bundle.sources['src/blocked.ts'] = `/// <reference path="${new URL('../src/types.ts', import.meta.url).pathname}" />\nimport { readFileSync } from 'node:fs';\nthrow new Error('Uploaded code was executed');\n`;
  const result = analyzeBundle(validateBundle(bundle));
  assert.equal(result.baseline.some((item) => item.code === 6053), true);
  assert.equal(result.baseline.some((item) => item.code === 2307 && item.message.includes('node:fs')), true);
  assert.equal(result.introduced[0]?.code, 2345);
});

test('blocks file URLs and relative traversal out of the virtual workspace', () => {
  const bundle = small();
  const hostFile = new URL('../src/types.ts', import.meta.url).href;
  bundle.sources['src/uri.ts'] = `import '${hostFile}';\nimport '${'../'.repeat(8)}${fileURLToPath(new URL('../src/types', import.meta.url)).slice(1)}';\nexport {};`;
  const report = analyzeBundle(validateBundle(bundle));
  assert.equal(report.baseline.filter((item) => item.file === 'src/uri.ts' && item.code === 2307).length, 2);
  assert.equal(report.introduced[0]?.code, 2345);
});

test('validates paths, entries, case collisions, file count and byte limits', () => {
  for (const filename of ['../escape.ts', '/absolute.ts', 'src/.env.ts', '.git/config.ts', 'node_modules/pkg.ts', 'src/a\\b.ts', 'src/./a.ts', 'src/view.tsx']) {
    const bundle = small();
    bundle.sources = { [filename]: 'export const x = 1;' };
    assert.throws(() => validateBundle(bundle), /Invalid migration bundle/);
  }
  const missing = small();
  missing.dependency.after.entry = 'missing.d.ts';
  assert.throws(() => validateBundle(missing), /entry must exist/);
  const collision = small();
  collision.sources['src/LABEL.ts'] = 'export const x = 1;';
  assert.throws(() => validateBundle(collision), /unique ignoring case: src\/label\.ts and src\/LABEL\.ts/);
  assert.deepEqual([MAX_FILES, MAX_FILE_BYTES, MAX_BUNDLE_BYTES], [4000, 1024 * 1024, 16 * 1024 * 1024]);
  const oversized = small();
  oversized.sources['src/huge.ts'] = 'a'.repeat(1024 * 1024 + 1);
  assert.throws(() => validateBundle(oversized), /1 MiB/);
  const largeFile = small();
  largeFile.sources['src/large.ts'] = 'a'.repeat(1024 * 1024);
  assert.doesNotThrow(() => validateBundle(largeFile));
  const manyFiles = small();
  manyFiles.dependency.after.files = { ...manyFiles.dependency.after.files, ...Object.fromEntries(Array.from({ length: 3997 }, (_, i) => [`build/src/f${i}.d.ts`, 'export {};'])) };
  assert.doesNotThrow(() => validateBundle(manyFiles));
  const tooMany = small();
  tooMany.dependency.after.files = { ...tooMany.dependency.after.files, ...Object.fromEntries(Array.from({ length: 3998 }, (_, i) => [`build/src/f${i}.d.ts`, 'export {};'])) };
  assert.throws(() => validateBundle(tooMany), /at most 4000 files/);
  const dependencyFiles = small();
  dependencyFiles.dependency.before.typeDependencies = { 'dep-kit': { version: '1.0.0', entry: 'index.d.ts', files: Object.fromEntries(Array.from({ length: 3998 }, (_, i) => [i === 0 ? 'index.d.ts' : `f${i}.d.ts`, 'export {};'])) } };
  assert.throws(() => validateBundle(dependencyFiles), /at most 4000 files/);
  const tooLarge = small();
  tooLarge.sources = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`src/f${i}.ts`, 'a'.repeat(1000000)]));
  assert.throws(() => validateBundle(tooLarge), /16 MiB/);
});

test('accepts .d.mts, .d.cts and package-relative declaration paths, and rejects other contract files', () => {
  const bundle = small();
  bundle.dependency.after = { version: '2.0.0', entry: 'build/src/index.d.mts', files: {
    'build/src/index.d.mts': "export { label } from './format.mjs';\n",
    'build/src/format.d.mts': 'export declare function label(value: string, options: { prefix: string }): string;\n',
    'build/cjs/index.d.cts': 'export {};\n',
  } };
  const report = analyzeBundle(validateBundle(bundle));
  assert.deepEqual(report.introduced.map((item) => item.code), [2345]);
  for (const name of ['index.js', 'index.ts', 'types/../index.d.ts', 'node_modules/x/index.d.ts']) {
    const invalid = small();
    invalid.dependency.after.files[name] = 'export {};';
    assert.throws(() => validateBundle(invalid), /Invalid migration bundle/, name);
  }
});

test('validates intent and project origin', () => {
  const bundle = small();
  bundle.intent = 'Keep registering the reader so rack warnings still export.';
  bundle.origin = { kind: 'project', folder: 'rack-monitor', declarationSources: { before: 'npm label-kit@1.0.0', after: 'npm label-kit@2.0.0' }, omitted: [] };
  assert.deepEqual(validateBundle(bundle).origin, bundle.origin);
  for (const change of [
    (item: MigrationBundle) => { item.intent = 'x'.repeat(4001); },
    (item: MigrationBundle) => { if (item.origin) item.origin.folder = '/projects/rack-monitor'; },
    (item: MigrationBundle) => { (item.origin as unknown as { kind: string }).kind = 'upload'; },
    (item: MigrationBundle) => { Object.assign(item.origin ?? {}, { absolutePath: '/tmp' }); },
  ]) {
    const invalid = structuredClone(bundle);
    change(invalid);
    assert.throws(() => validateBundle(invalid), /Invalid migration bundle/);
  }
});

test('accepts a published-contract dependency source and rejects other source shapes', () => {
  const bundle = small();
  bundle.dependency.source = { kind: 'published-contract', publisher: 'NVIDIA', url: 'https://github.com/NVIDIA/dcgm-exporter' };
  assert.deepEqual(validateBundle(bundle).dependency.source, bundle.dependency.source);
  for (const source of [
    { kind: 'published-contract', publisher: 'NVIDIA', url: 'http://github.com/NVIDIA/dcgm-exporter' },
    { kind: 'npm', publisher: 'NVIDIA', url: 'https://github.com/NVIDIA/dcgm-exporter' },
    { kind: 'published-contract', publisher: '', url: 'https://github.com/NVIDIA/dcgm-exporter' },
    { kind: 'published-contract', publisher: 'NVIDIA', url: 'https://github.com/NVIDIA/dcgm-exporter', token: 'x' },
  ]) assert.throws(() => validateBundle({ ...small(), dependency: { ...small().dependency, source } }), /Invalid migration bundle/, JSON.stringify(source));
});

test('mounts subpath exports so pkg/sub resolves to the published declaration file', () => {
  const bundle = small();
  for (const side of [bundle.dependency.before, bundle.dependency.after]) side.files['dist/sub/extra.d.ts'] = 'export declare function extra(): string;\n';
  bundle.sources['src/extra.ts'] = "import { extra } from 'label-kit/extra';\nexport const e: string = extra();\n";
  assert.equal(analyzeBundle(validateBundle(bundle)).baseline.some((item) => item.code === 2307 && item.file === 'src/extra.ts'), true);
  for (const side of [bundle.dependency.before, bundle.dependency.after]) side.exports = { './extra': 'dist/sub/extra.d.ts' };
  const report = analyzeBundle(validateBundle(bundle));
  assert.deepEqual(report.baseline, []);
  assert.deepEqual(report.introduced.map((item) => [item.file, item.code]), [['src/label.ts', 2345]]);
  for (const exports of [{ './extra': 'dist/missing.d.ts' }, { '../extra': 'dist/sub/extra.d.ts' }, { './a/../b': 'dist/sub/extra.d.ts' }, { './extra': 'dist/sub/extra.js' }] as Record<string, string>[]) {
    const invalid = structuredClone(bundle);
    invalid.dependency.after.exports = exports;
    assert.throws(() => validateBundle(invalid), /Invalid migration bundle/, JSON.stringify(exports));
  }
});

test('loads @types packages listed in typeDependencies as global types', () => {
  const bundle = small();
  bundle.sources['src/rack.ts'] = 'export const rack: string = RACK_NAME;\n';
  assert.equal(analyzeBundle(validateBundle(bundle)).baseline.some((item) => item.code === 2304 && item.file === 'src/rack.ts'), true);
  for (const side of [bundle.dependency.before, bundle.dependency.after]) {
    side.typeDependencies = { '@types/rack-env': { version: '1.0.0', entry: 'index.d.ts', files: { 'index.d.ts': 'declare const RACK_NAME: string;\n' } } };
  }
  const report = analyzeBundle(validateBundle(bundle));
  assert.deepEqual(report.baseline, []);
  assert.deepEqual(report.introduced.map((item) => [item.file, item.code]), [['src/label.ts', 2345]]);
});

test('rejects stale, ambiguous, overlapping, no-op and suppression edits', () => {
  const bundle = small();
  const filename = 'src/label.ts';
  assert.throws(() => checkPatch(bundle, [{ path: filename, before: 'missing', after: 'replacement' }]), /Original text not found/);
  assert.throws(() => checkPatch(bundle, [{ path: filename, before: 'label', after: 'format' }]), /ambiguous/);
  assert.throws(() => checkPatch(bundle, [{ path: filename, before: 'Cooling', after: 'Cooling' }]), /no change/);
  assert.throws(() => checkPatch(bundle, [{ path: 'index.d.ts', before: 'x', after: 'y' }]), /Sources must be .ts/);
  assert.throws(() => checkPatch(bundle, [{ path: 'missing.ts', before: 'x', after: 'y' }]), /existing source/);
  assert.throws(() => checkPatch(bundle, [
    { path: filename, before: "label('Cooling', 'Rack: ')", after: '"anything"' },
    { path: filename, before: 'Cooling', after: 'Heating' },
  ]), /Overlapping/);
  for (const directive of ['@ts-ignore', '@ts-nocheck', '@ts-expect-error']) {
    assert.throws(() => checkPatch(bundle, [{ path: filename, before: 'export const', after: `// ${directive}\nexport const` }]), /suppression/);
  }
});

test('repair gate: erasing the module and an as-any bypass compile but are rejected; the reference repair is accepted', () => {
  const bundle = otel();
  const source = bundle.sources['src/metrics.ts'] ?? '';
  const reference = checkPatch(bundle, [{ path: 'src/metrics.ts', before: source, after: otelReference }]);
  assert.deepEqual([reference.accepted, reference.violations, reference.preexisting], [true, [], []]);
  const erased = checkPatch(bundle, [{ path: 'src/metrics.ts', before: source, after: 'export {};\n' }]);
  assert.deepEqual([erased.accepted, erased.diagnostics.length], [false, 0]);
  assert.deepEqual(erased.violations.map((item) => item.rule).sort(), ['erased-file', 'removed-export']);
  const cast = checkPatch(bundle, [{ path: 'src/metrics.ts', before: '  provider.addMetricReader(reader);', after: '  (provider as any).addMetricReader(reader);' }]);
  assert.deepEqual([cast.accepted, cast.diagnostics.length], [false, 0]);
  assert.deepEqual(cast.violations.map((item) => [item.rule, item.file]), [['type-bypass', 'src/metrics.ts']]);
});

test('mounts typeDependencies so declarations that import other packages compile with skipLibCheck off', () => {
  const sdk = (method: string) => ({ version: '1.0.0', entry: 'build/src/index.d.ts', files: {
    'build/src/index.d.ts': "import type { Meter } from '@otel-test/api';\nimport { Resource } from '@otel-test/resources';\nexport declare class MeterProvider { constructor(options?: { resource?: Resource }); getMeter(name: string): Meter; " + method + ' }\n',
  }, typeDependencies: {
    '@otel-test/api': { version: '1.9.0', entry: 'build/src/index.d.ts', files: { 'build/src/index.d.ts': 'export interface Meter { createCounter(name: string): { add(value: number): void } }\n' } },
    '@otel-test/resources': { version: '1.0.0', entry: 'build/src/index.d.ts', files: { 'build/src/index.d.ts': "import type { Meter } from '@otel-test/api';\nexport declare class Resource { constructor(attributes: Record<string, string>); meter?: Meter }\n" } },
  } });
  const bundle = validateBundle({ ...small(), dependency: { name: '@otel-test/sdk-metrics', before: sdk('shutdown(): Promise<void>;'), after: sdk('') },
    sources: { 'src/metrics.ts': "import { MeterProvider } from '@otel-test/sdk-metrics';\nimport { Resource } from '@otel-test/resources';\nconst provider = new MeterProvider({ resource: new Resource({ rack: 'r1' }) });\nprovider.getMeter('m').createCounter('c').add(1);\nexport const stop = () => provider.shutdown();\n" } });
  const report = analyzeBundle(bundle);
  assert.deepEqual(report.baseline, []);
  assert.deepEqual(report.introduced.map((item) => [item.file, item.line, item.code]), [['src/metrics.ts', 5, 2339]]);
  const missing = structuredClone(bundle);
  delete missing.dependency.before.typeDependencies;
  assert.equal(analyzeBundle(missing).baseline.some((item) => item.code === 2307 && item.file === 'contracts/build/src/index.d.ts'), true);
  const self = structuredClone(bundle);
  self.dependency.after.typeDependencies = { '@otel-test/sdk-metrics': sdk('') };
  assert.throws(() => validateBundle(self), /dependency itself/);
  const noEntry = structuredClone(bundle);
  if (noEntry.dependency.after.typeDependencies?.['@otel-test/api']) noEntry.dependency.after.typeDependencies['@otel-test/api'].entry = 'missing.d.ts';
  assert.throws(() => validateBundle(noEntry), /entry must exist/);
});

test('compiles a real published declaration tree that imports another package (undici-types with @types/node)', () => {
  const tree = (name: string) => {
    const root = fileURLToPath(new URL(`../node_modules/${name}/`, import.meta.url));
    const files: Record<string, string> = {};
    const walk = (directory: string) => {
      for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(relative);
        else if (/\.d\.ts$/.test(entry.name)) files[relative] = readFileSync(path.join(root, relative), 'utf8');
      }
    };
    walk('');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string; types: string };
    return { version: manifest.version, entry: manifest.types.replace(/^\.\//, ''), files };
  };
  const undici = tree('undici-types');
  const node = tree('@types/node');
  assert.ok(Object.keys(node.files).length > 50);
  const bundle = validateBundle({ ...small(), dependency: { name: 'undici-types', before: { ...undici, typeDependencies: { '@types/node': node } }, after: { ...undici, typeDependencies: { '@types/node': node } } },
    sources: {
      'src/fetch.ts': "import { Headers } from 'undici-types';\nexport const kind: string | null = new Headers({ accept: 'text/plain' }).get('accept');\n",
      'src/read.ts': "import { readFileSync } from 'node:fs';\nexport const size: number = readFileSync('rack.json', 'utf8').length + process.argv.length;\n",
    } });
  const report = analyzeBundle(bundle);
  assert.deepEqual(report.baseline, []);
  assert.deepEqual(report.target, []);
  assert.equal(report.coverage.status, 'complete');
  const without = structuredClone(bundle);
  delete without.dependency.before.typeDependencies;
  assert.equal(analyzeBundle(without).baseline.some((item) => item.code === 2688 || item.code === 2307), true);
});

test('exports a patch that git applies to the original files, including missing final newlines', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ketchup-diff-'));
  try {
    mkdirSync(path.join(directory, 'src'));
    const before = { 'src/first.ts': 'export const first = 1;\n', 'src/second.ts': 'export const second = 2;' };
    const after = { 'src/first.ts': 'export const first = 3;', 'src/second.ts': 'export const second = 4;\n' };
    for (const [name, text] of Object.entries(before)) writeFileSync(path.join(directory, name), text);
    const diff = makeDiff(before, after);
    execFileSync('git', ['apply', '--check', '-'], { cwd: directory, input: diff });
    execFileSync('git', ['apply', '-'], { cwd: directory, input: diff });
    assert.equal(readFileSync(path.join(directory, 'src/first.ts'), 'utf8'), 'export const first = 3;');
    assert.equal(readFileSync(path.join(directory, 'src/second.ts'), 'utf8'), 'export const second = 4;\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rehearsal checks the published API transition without claiming runtime execution', () => {
  const bundle = demoBundle('opentelemetry-metrics');
  const report = checkPatch(bundle, rehearsalProposal(bundle).edits);
  const evidence = demoEvidence(bundle, report, 'nemotron');
  assert.equal(report.accepted, true);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.resolvedCount, 1);
  assert.equal(evidence?.kind, 'opentelemetry');
  assert.equal(evidence?.candidateVerified, true);
  assert.equal(demoEvidence(bundle, report, 'rehearsal')?.checks.find(check => /reference/i.test(check.name))?.status, 'not-run', 'The bundled reference must not verify itself.');
  assert.match(report.files['src/metrics.ts'] ?? '', /new MeterProvider\(\{ readers: \[reader\] \}\)/);
  assert.doesNotMatch(report.files['src/metrics.ts'] ?? '', /addMetricReader/);
  assert.match(evidence?.note ?? '', /No SDK or telemetry exporter was executed/);
  assert.match(evidence?.note ?? '', /declaration excerpts/);
  assert.equal(evidence?.checks.every(check => check.status === 'passed'), true);
  assert.equal(Object.hasOwn(evidence ?? {}, 'replay'), false, 'Static evidence must not include invented runtime readings.');
});

test('reference matching rejects modified candidates and forged sample bundles', () => {
  const bundle = demoBundle('opentelemetry-metrics');
  const proposal = rehearsalProposal(bundle);
  const source = proposal.edits[0];
  assert.ok(source);
  const modifiedReport = checkPatch(bundle, [{ ...source, after: `${source.after}\nthrow new Error('never execute imported code');\n` }]);
  assert.equal(modifiedReport.accepted, true, 'Static acceptance does not establish safe or equivalent runtime behavior.');
  const evidence = demoEvidence(bundle, modifiedReport);
  assert.equal(evidence?.candidateVerified, false);
  assert.equal(evidence?.checks.some(check => check.status === 'not-run' && /reference/i.test(check.name)), true);
  assert.match(evidence?.note ?? '', /No SDK or telemetry exporter was executed/);
  const forged = demoBundle('opentelemetry-metrics');
  forged.sources['src/metrics.ts'] += '\nthrow new Error("not the demo");';
  assert.equal(isDemoBundle(forged), false);
  assert.throws(() => rehearsalProposal(forged), /unchanged|canonical/i);
  assert.equal(demoEvidence(forged, modifiedReport), null);
  const changedContract = demoBundle('opentelemetry-metrics');
  changedContract.dependency.after.files[changedContract.dependency.after.entry] += '\nexport declare const extra: string;\n';
  assert.equal(isDemoBundle(changedContract), false, 'A familiar project name must not authorize a different API snapshot.');
  assert.throws(() => rehearsalProposal(changedContract), /unchanged|canonical/i);
});
