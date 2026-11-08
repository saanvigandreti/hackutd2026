import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeBundle, validateBundle } from '../src/engine.ts';
import { inspectProject, prepareProject } from '../src/intake.ts';
import { stubRegistry, writeProject, writeTree } from './fixtures/intake/stub.ts';

function workspace(t: test.TestContext, options: { installed?: boolean } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'ketchup-intake-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'rack-dashboard');
  writeProject(root, options);
  return { base, root, cacheDirectory: path.join(base, 'cache') };
}
const meter = '@ketchup-fixture/meter';

test('inspects an ordinary project folder', async (t) => {
  const { root } = workspace(t);
  assert.deepEqual(await inspectProject(root, { fetchImpl: stubRegistry().fetchImpl }), {
    folder: 'rack-dashboard',
    dependencies: [
      { name: meter, range: '^1.0.0', installed: '1.0.0', imported: true, dev: false, latest: '2.0.0' },
      { name: '@ketchup-fixture/base', range: '1.0.0', installed: '1.0.0', imported: false, dev: true, latest: '4.0.0' },
    ],
    sourceCount: 2,
  });
});

test('inspection lists imported runtime packages first and @types last, with no latest version offline', async (t) => {
  const { root } = workspace(t);
  writeTree(root, { 'package.json': JSON.stringify({ dependencies: { 'a-unused': '1.0.0', [meter]: '^1.0.0' }, devDependencies: { '@types/node': '22.0.0', 'b-tool': '1.0.0' } }) });
  const offline = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const inspected = await inspectProject(root, { fetchImpl: offline });
  assert.deepEqual(inspected.dependencies.map((item) => [item.name, item.imported, item.dev, item.latest]), [
    [meter, true, false, null], ['a-unused', false, false, null], ['b-tool', false, true, null], ['@types/node', false, true, null],
  ]);
});

test('rejects relative paths, files and folders without package.json', async (t) => {
  const { base, root } = workspace(t);
  await assert.rejects(inspectProject('rack-dashboard'), /absolute path/);
  await assert.rejects(inspectProject(path.join(root, 'package.json')), /not a folder/);
  await assert.rejects(inspectProject(path.join(base, 'missing')), /not a folder/);
  await assert.rejects(inspectProject(base), /package\.json was not found/);
  await assert.rejects(prepareProject({ root: base, dependency: meter, targetVersion: '2.0.0', cacheDirectory: path.join(base, 'c') }), /package\.json was not found/);
});

test('builds a bundle from installed declarations and the published target tarball', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  const registry = stubRegistry();
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: registry.fetchImpl });
  assert.equal(bundle.format, 1);
  assert.equal(bundle.name, 'rack-dashboard');
  assert.equal(bundle.description, 'Rack meter dashboard used by the intake tests.');
  assert.equal(bundle.intent, 'Every rack reading must still reach the dashboard.');
  assert.deepEqual(Object.keys(bundle.sources).sort(), ['src/app.ts', 'src/format.ts']);
  const { before, after } = bundle.dependency;
  assert.equal(bundle.dependency.name, meter);
  assert.equal(before.version, '1.0.0');
  assert.equal(before.entry, 'lib/index.d.ts');
  assert.deepEqual(Object.keys(before.files).sort(), ['lib/index.d.ts', 'lib/meter.d.ts', 'lib/units.d.ts']);
  assert.deepEqual(before.typeDependencies, { '@ketchup-fixture/base': { version: '1.0.0', entry: 'index.d.ts', files: { 'index.d.ts': 'export interface Reading { value: number }\n' } } });
  assert.equal(after.version, '2.0.0');
  assert.equal(after.entry, 'build/index.d.ts');
  assert.deepEqual(Object.keys(after.files).sort(), ['build/index.d.ts', 'build/meter.d.ts']);
  const base = after.typeDependencies?.['@ketchup-fixture/base'];
  assert.equal(base?.version, '2.3.0', 'highest published match for ^2.1.0 || ^3.0.0, prereleases excluded');
  assert.deepEqual(Object.keys(base?.files ?? {}).sort(), ['index.d.ts', 'labels.d.ts']);
  assert.deepEqual(bundle.origin?.declarationSources, {
    before: '@ketchup-fixture/meter 1.0.0 from node_modules; type dependencies: 1 from node_modules',
    after: '@ketchup-fixture/meter 2.0.0, downloaded from npm; type dependencies: 1 downloaded from npm',
  });
  assert.equal(bundle.origin?.folder, 'rack-dashboard');
  const omitted = bundle.origin?.omitted ?? [];
  for (const expected of [/^\.cache\/: hidden folder$/, /^\.env: environment file, never read$/, /^dist\/: build output$/,
    /^node_modules\/: installed packages/, /^src\/bad name\.ts: the path has characters/, /^src\/globals\.d\.ts: project declaration file/,
    /^src\/view\.tsx: only \.ts sources/]) {
    assert.ok(omitted.some((item) => expected.test(item)), `${expected} in ${JSON.stringify(omitted)}`);
  }
  assert.ok(!JSON.stringify(bundle).includes(root), 'absolute paths stay on this machine');
  assert.ok(!JSON.stringify(bundle).includes('never executed'), 'only declaration files are extracted');
  assert.equal(readdirSync(path.join(cacheDirectory, 'npm')).length, 2, 'verified tarballs of meter 2.0.0 and base 2.3.0 are cached');

  const offline = stubRegistry();
  const again = await prepareProject({ root, dependency: meter, targetVersion: 'latest', cacheDirectory, fetchImpl: offline.fetchImpl });
  assert.deepEqual(again.dependency.after.files, after.files);
  assert.ok(!offline.requests.includes('https://registry.npmjs.org/@ketchup-fixture/meter/-/meter-2.0.0.tgz'), 'a verified cached tarball is reused');
});

test('rejects a tarball whose sha512 integrity does not match', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  const registry = stubRegistry();
  registry.tamper(meter, '2.0.0');
  await assert.rejects(prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: registry.fetchImpl }), /failed its sha512 integrity check/);
  assert.equal(existsSync(path.join(cacheDirectory, 'npm')), false, 'nothing unverified is cached');
});

test('skips symbolic links that leave the project and oversized sources', async (t) => {
  const { base, root, cacheDirectory } = workspace(t);
  writeFileSync(path.join(base, 'outside.ts'), 'export const secret = 1;\n');
  symlinkSync(path.join(base, 'outside.ts'), path.join(root, 'src', 'outside.ts'));
  symlinkSync(path.join(root, 'src', 'format.ts'), path.join(root, 'src', 'alias.ts'));
  writeFileSync(path.join(root, 'src', 'huge.ts'), `export const blob = '${'x'.repeat(1_048_577)}';\n`);
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.deepEqual(Object.keys(bundle.sources).sort(), ['src/alias.ts', 'src/app.ts', 'src/format.ts']);
  assert.ok(bundle.origin?.omitted.includes('src/outside.ts: symbolic link points outside the project'));
  assert.ok(bundle.origin?.omitted.includes('src/huge.ts: larger than 1 MiB'));
  assert.ok(!JSON.stringify(bundle).includes('secret'));
});

test('fetches the before version from the registry when the dependency is not installed', async (t) => {
  const { root, cacheDirectory } = workspace(t, { installed: false });
  const fromRange = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.equal(fromRange.dependency.before.version, '1.1.0');
  assert.equal(fromRange.origin?.declarationSources.before, '@ketchup-fixture/meter 1.1.0 (the highest published match for "^1.0.0"), downloaded from npm (not installed)');
  assert.equal(fromRange.dependency.before.typeDependencies, undefined, '1.1.0 declarations import no other package');

  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${meter}`]: { version: '1.0.0' } } }));
  const locked = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.equal(locked.dependency.before.version, '1.0.0');
  assert.equal(locked.origin?.declarationSources.before, '@ketchup-fixture/meter 1.0.0 (from package-lock.json), downloaded from npm (not installed); type dependencies: 1 downloaded from npm');
  assert.equal(locked.dependency.before.typeDependencies?.['@ketchup-fixture/base']?.version, '1.0.0');

  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  delete manifest.description;
  manifest.dependencies[meter] = '1.0.0';
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  rmSync(path.join(root, 'package-lock.json'));
  const pinned = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.equal(pinned.origin?.declarationSources.before, '@ketchup-fixture/meter 1.0.0, downloaded from npm (not installed); type dependencies: 1 downloaded from npm');
  assert.equal(pinned.description, '', 'a package.json without a description gets none, so the summary does not repeat the heading');
});

test('explains dependency and version problems', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  const fetchImpl = stubRegistry().fetchImpl;
  await assert.rejects(prepareProject({ root, dependency: 'left-pad', targetVersion: '2.0.0', cacheDirectory, fetchImpl }), /not a dependency in this project/);
  await assert.rejects(prepareProject({ root, dependency: meter, targetVersion: '9.9.9', cacheDirectory, fetchImpl }), /Version 9\.9\.9 of @ketchup-fixture\/meter was not found/);
  await assert.rejects(prepareProject({ root, dependency: meter, targetVersion: '1.0.0', cacheDirectory, fetchImpl }), /already at 1\.0\.0/);
  await assert.rejects(prepareProject({ root, dependency: meter, targetVersion: '^7', cacheDirectory, fetchImpl }), /No published version of @ketchup-fixture\/meter matches "\^7"/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl, signal: controller.signal }));
});

test('follows subpath imports of the dependency and skips type dependencies with invalid names', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  const installed = path.join(root, 'node_modules', '@ketchup-fixture', 'meter');
  writeFileSync(path.join(installed, 'lib', 'extra.d.ts'), 'export declare const extra: 1;\n');
  writeFileSync(path.join(installed, 'lib', 'units.d.ts'), `import 'LegacyCaps';\nimport 'Long${'N'.repeat(1000)}';\nexport type Unit = 'W' | 'kW';\n`);
  writeTree(path.join(root, 'node_modules', 'LegacyCaps'), { 'package.json': '{ "name": "LegacyCaps", "version": "1.0.0", "types": "index.d.ts" }', 'index.d.ts': 'export {};\n' });
  writeFileSync(path.join(root, 'src', 'extra.ts'), "import { extra } from '@ketchup-fixture/meter/lib/extra';\nexport const value = extra;\n");
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.ok(Object.hasOwn(bundle.dependency.before.files, 'lib/extra.d.ts'));
  assert.deepEqual(Object.keys(bundle.dependency.before.typeDependencies ?? {}), ['@ketchup-fixture/base']);
  const omitted = bundle.origin?.omitted ?? [];
  assert.ok(omitted.some((item) => item.startsWith('LegacyCaps (imported by @ketchup-fixture/meter@1.0.0') && item.endsWith('not a valid npm package name, so it is not analyzed')), JSON.stringify(omitted));
  assert.ok(omitted.includes('@ketchup-fixture/meter/lib/extra: imported by the project, but no declaration file was found in @ketchup-fixture/meter@2.0.0'));
  assert.ok(omitted.some((item) => item.startsWith('LongNNN') && item.length === 1000 && item.endsWith('…')));
  assert.ok(omitted.every((item) => item.length <= 1000));
  await assert.rejects(prepareProject({ root, dependency: '../..', targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl }), /npm package name/);
});

test('ignores import-shaped comments and strings when inspecting and collecting dependencies', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  writeTree(root, {
    'src/app.ts': [
      `// import '${meter}/comment-only';`,
      "/* import '@ketchup-fixture/base'; */",
      'const text = "require(\'node:fs\')";',
      `export const load = () => import('${meter}/lib/extra');`,
    ].join('\n'),
    [`node_modules/${meter}/lib/extra.d.ts`]: 'export declare const extra: 1;\n',
    [`node_modules/${meter}/lib/index.d.ts`]: [
      "export * from './meter.js';",
      "export type { Unit } from './units';",
      "// import 'comment-only-package';",
      'export type Example = "import(\'node:http\')";',
    ].join('\n'),
  });
  const registry = stubRegistry();
  const inspected = await inspectProject(root, { fetchImpl: registry.fetchImpl });
  assert.deepEqual(inspected.dependencies.map(item => [item.name, item.imported]), [
    [meter, true], ['@ketchup-fixture/base', false],
  ]);

  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: registry.fetchImpl });
  assert.deepEqual(Object.keys(bundle.dependency.before.files).sort(), [
    'lib/extra.d.ts', 'lib/index.d.ts', 'lib/meter.d.ts', 'lib/units.d.ts',
  ]);
  assert.deepEqual(Object.keys(bundle.dependency.before.typeDependencies ?? {}), ['@ketchup-fixture/base']);
  assert.deepEqual(bundle.origin?.omitted.filter(item => item.startsWith(`${meter}/`)
    || item.startsWith('@types/node:') || item.includes('comment-only-package')), [
    `${meter}/lib/extra: imported by the project, but no declaration file was found in ${meter}@2.0.0`,
  ]);
});

test('follows triple-slash declaration paths and reports Node type references', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  writeTree(root, {
    'src/node-reference.ts': '/// <reference types="node" />\nexport const runtime = true;\n',
    [`node_modules/${meter}/lib/index.d.ts`]: [
      '/// <reference types="node" />',
      '/// <reference path="ambient.d.ts" />',
      "export * from './meter.js';",
      "export type { Unit } from './units';",
    ].join('\n'),
    [`node_modules/${meter}/lib/ambient.d.ts`]: 'declare const ambientMarker: unique symbol;\n',
  });
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.deepEqual(Object.keys(bundle.dependency.before.files).sort(), [
    'lib/ambient.d.ts', 'lib/index.d.ts', 'lib/meter.d.ts', 'lib/units.d.ts',
  ]);
  assert.equal(bundle.dependency.before.files['lib/ambient.d.ts'], 'declare const ambientMarker: unique symbol;\n');
  assert.deepEqual(bundle.origin?.omitted.filter(item => item.includes('@types/node')), [
    '@types/node: src/node-reference.ts imports Node.js built-in modules; @types/node is not included, so those imports stay unresolved on both versions',
    `${meter}@1.0.0: its declarations use Node.js built-in modules; @types/node is not included, so those types stay unresolved`,
  ]);
});

test('keeps the whole bundle inside the engine size limit', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  for (let index = 0; index < 16; index++) writeFileSync(path.join(root, 'src', `part${index}.ts`), `export const v = '${'x'.repeat(1_046_000)}';\n`);
  writeFileSync(path.join(root, 'src', 'tail.ts'), `export const t = '${'y'.repeat(30_000)}';\n`);
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '2.0.0', cacheDirectory, fetchImpl: stubRegistry().fetchImpl });
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= 16 * 1_048_576);
  assert.ok(bundle.origin?.omitted.some((item) => / over the 16 MiB total limit$/.test(item)), JSON.stringify(bundle.origin?.omitted));
});

test('reads .d.cts declarations, drops a path that differs only in letter case and notes Node built-in imports', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  writeFileSync(path.join(root, 'src', 'server.ts'), "import { createServer } from 'node:http';\nexport const server = createServer();\n");
  writeFileSync(path.join(root, 'src', 'io.ts'), "import { readFileSync } from 'fs';\nexport const read = readFileSync;\n");
  const registry = stubRegistry(undefined, { [meter]: { '3.0.0': {
    'package.json': JSON.stringify({ name: meter, version: '3.0.0', main: './index.cjs', exports: { '.': { types: './index.d.cts', require: './index.cjs' } } }),
    'index.d.cts': "export * from './meter.cjs';\nexport * from './Meter.cjs';\n",
    'meter.d.cts': 'export declare class Meter {}\n',
    'Meter.d.cts': 'export declare const version: 3;\n',
    'index.d.ts': 'export declare const unreached: true;\n',
  } } });
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '3.0.0', cacheDirectory, fetchImpl: registry.fetchImpl });
  const { after } = bundle.dependency;
  assert.equal(after.entry, 'index.d.cts', 'the exports types condition is followed to a .d.cts entry');
  assert.deepEqual(Object.keys(after.files).sort(), ['Meter.d.cts', 'index.d.cts']);
  const omitted = bundle.origin?.omitted ?? [];
  assert.ok(omitted.includes(`${meter}@3.0.0 meter.d.cts: differs from Meter.d.cts only in letter case`), JSON.stringify(omitted));
  assert.ok(omitted.includes('@types/node: src/io.ts, src/server.ts import Node.js built-in modules; @types/node is not included, so those imports stay unresolved on both versions'), JSON.stringify(omitted));
  assert.doesNotThrow(() => validateBundle(bundle));
});

test('resolves exports like the engine compiler and says which subpath imports stay unresolved', async (t) => {
  const { root, cacheDirectory } = workspace(t);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.dependencies.events = '^3.3.0';
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(path.join(root, 'src', 'v4.ts'), "import { v4 } from '@ketchup-fixture/meter/v4';\nexport const value = v4;\n");
  writeFileSync(path.join(root, 'src', 'bus.ts'), "import { EventEmitter } from 'events';\nimport run from 'test';\nexport const bus = [EventEmitter, run];\n");
  const registry = stubRegistry(undefined, { [meter]: { '3.0.0': {
    'package.json': JSON.stringify({ name: meter, version: '3.0.0', exports: {
      '.': { require: { types: './index.d.cts' }, import: { types: './index.d.mts' } },
      './v4': { types: './v4/index.d.cts' },
    } }),
    'index.d.cts': 'export declare const cjs: true;\n',
    'index.d.mts': "export { Meter } from './meter.mjs';\n",
    'meter.d.mts': "import type { Unit } from '.';\nexport declare class Meter { unit: Unit; addReader(read: (reading: { value: number }) => void): void }\n",
    'index.d.ts': "export type Unit = 'W';\n",
    'v4/index.d.cts': 'export declare const v4: 4;\n',
  } } });
  const bundle = await prepareProject({ root, dependency: meter, targetVersion: '3.0.0', cacheDirectory, fetchImpl: registry.fetchImpl });
  const { after } = bundle.dependency;
  assert.equal(after.entry, 'index.d.mts', 'the import condition wins over require, as TypeScript bundler resolution picks it');
  assert.deepEqual(Object.keys(after.files).sort(), ['index.d.mts', 'index.d.ts', 'meter.d.mts', 'v4/index.d.cts'], "import from '.' in a top-level file reads index.d.ts");
  const omitted = bundle.origin?.omitted ?? [];
  const note = `${meter}/v4: ${meter}@3.0.0 publishes these declarations as v4/index.d.cts, which the analysis cannot resolve from the import path, so imports of ${meter}/v4 stay unresolved`;
  assert.ok(omitted.includes(note), JSON.stringify(omitted));
  assert.ok(!omitted.some((item) => item.startsWith('@types/node')), 'a declared npm package named like a Node module and bare "test" are not Node built-ins');
  const report = analyzeBundle(validateBundle(bundle));
  assert.ok(report.target.some((item) => item.file === 'src/v4.ts' && item.code === 2307), 'the note matches what the engine compiler does');
});
