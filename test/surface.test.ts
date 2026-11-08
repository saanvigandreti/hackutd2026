import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeBundle, validateBundle } from '../src/engine.ts';
import { MAX_API_CHANGES } from '../src/surface.ts';
import type { MigrationBundle } from '../src/types.ts';
import { smallBundle } from './support.ts';

const demoBundle = (): MigrationBundle => validateBundle(JSON.parse(readFileSync(new URL('../fixtures/otel-metrics.json', import.meta.url), 'utf8')));
const contract = (before: string, after: string, source: string): MigrationBundle => {
  const bundle = smallBundle();
  bundle.dependency.before.files['index.d.ts'] = before;
  bundle.dependency.after.files['index.d.ts'] = after;
  bundle.sources = { 'src/use.ts': source };
  return validateBundle(bundle);
};

test('inventories the OpenTelemetry change and places it at the caller', () => {
  const report = analyzeBundle(demoBundle());
  const removed = report.apiChanges.find((change) => change.symbol === 'MeterProvider.addMetricReader');
  assert.deepEqual(removed?.locations, [{ file: 'src/metrics.ts', line: 5 }]);
  assert.equal(removed?.kind, 'removed');
  assert.equal(report.coverage.status, 'complete');
  assert.deepEqual(report.coverage.notes, ['2 of 3 API changes are used in this code; Ketchup found no use of the other 1.'],
    'one consequence sentence; its counts add up to the inventory');
});

test('empty declarations make coverage unavailable instead of clean', () => {
  const bundle = demoBundle();
  for (const side of [bundle.dependency.before, bundle.dependency.after]) for (const name of Object.keys(side.files)) side.files[name] = '';
  const report = analyzeBundle(bundle);
  assert.deepEqual(report.apiChanges, []);
  assert.equal(report.coverage.status, 'unavailable');
  assert.match(report.coverage.notes[0] ?? '', /no exported API in the old and new declarations/);
  const oneSide = demoBundle();
  oneSide.dependency.after.files[oneSide.dependency.after.entry] = 'export {};\n';
  assert.equal(analyzeBundle(oneSide).coverage.status, 'unavailable');
});

test('a removed method reached through dynamic access stays visible and makes coverage partial', () => {
  const bundle = demoBundle();
  bundle.sources['src/metrics.ts'] = (bundle.sources['src/metrics.ts'] ?? '').replace('provider.addMetricReader(reader);', "(provider as any)['addMetricReader'](reader);");
  const report = analyzeBundle(bundle);
  assert.deepEqual(report.introduced, []);
  const removed = report.apiChanges.find((change) => change.symbol === 'MeterProvider.addMetricReader');
  assert.deepEqual(removed?.locations, []);
  assert.equal(report.coverage.status, 'partial');
  assert.match(report.coverage.notes.join(' '), /src\/metrics\.ts:5/);
  const keyed = demoBundle();
  keyed.sources['src/metrics.ts'] = (keyed.sources['src/metrics.ts'] ?? '').replace('provider.addMetricReader(reader);', "const key = 'addMetricReader' as keyof typeof provider;\n  (provider[key] as (r: MetricReader) => void)(reader);");
  assert.equal(analyzeBundle(keyed).coverage.status, 'partial');
});

test('reports newly deprecated declarations that still compile', () => {
  const bundle = demoBundle();
  bundle.dependency.after.files['MeterProvider.d.ts'] = (bundle.dependency.after.files['MeterProvider.d.ts'] ?? '').replace(/export declare class MeterProvider/, '/** @deprecated use another provider */\nexport declare class MeterProvider');
  const report = analyzeBundle(bundle);
  const deprecated = report.apiChanges.find((change) => change.kind === 'deprecated');
  assert.equal(deprecated?.symbol, 'MeterProvider');
  assert.ok((deprecated?.locations.length ?? 0) > 0);
});

test('diffs functions, interfaces, type aliases, variables, enums and constructors with locations', () => {
  const before = [
    'export declare function label(value: string, prefix: string): string;',
    'export interface Options { prefix: string; width?: number }',
    'export type Mode = "short" | "long";',
    'export declare const VERSION: string;',
    'export declare enum Level { Low = 0, High = 1 }',
    'export declare class Printer { constructor(mode: Mode); print(text: string): void; private secret; }',
    'export declare function gone(): void;',
  ].join('\n');
  const after = [
    'export declare function label(value: string, options: Options): string;',
    'export interface Options { prefix: string; width?: string }',
    'export type Mode = "short";',
    'export declare const VERSION: number;',
    'export declare enum Level { Low = 0 }',
    'export declare class Printer { constructor(mode: Mode, width: number); print(text: string): void; private secret: string; }',
  ].join('\n');
  const source = "import { label, Level, Printer, VERSION, type Options } from 'label-kit';\nexport const a = label('x', 'y');\nexport const o: Options = { prefix: '', width: 1 };\nexport const l = Level.High;\nexport const p = new Printer('long');\nexport const v = VERSION;\n";
  const report = analyzeBundle(contract(before, after, source));
  const byName = Object.fromEntries(report.apiChanges.map((change) => [change.symbol, change]));
  assert.deepEqual(byName.label?.before, 'function label(value: string, prefix: string): string');
  assert.deepEqual(byName.label?.after, 'function label(value: string, options: Options): string');
  assert.deepEqual(byName.label?.locations, [{ file: 'src/use.ts', line: 1 }, { file: 'src/use.ts', line: 2 }]);
  assert.deepEqual(byName['Options.width']?.locations, [{ file: 'src/use.ts', line: 3 }]);
  assert.deepEqual(byName['Level.High']?.kind, 'removed');
  assert.deepEqual(byName['Level.High']?.locations, [{ file: 'src/use.ts', line: 4 }]);
  assert.deepEqual(byName['Printer.constructor']?.locations, [{ file: 'src/use.ts', line: 5 }]);
  assert.deepEqual(byName.VERSION?.locations, [{ file: 'src/use.ts', line: 1 }, { file: 'src/use.ts', line: 6 }]);
  assert.equal(byName.Mode?.kind, 'changed');
  assert.deepEqual(byName.gone, { kind: 'removed', symbol: 'gone', before: 'function gone(): void', after: null, locations: [] });
  assert.equal(byName['Printer.secret'], undefined);
  assert.equal(report.coverage.status, 'partial', 'VERSION changed from string to number, and `const v = VERSION` still compiles');
  assert.match(report.coverage.notes.join(' '), /Not flagged by the compiler: VERSION at src\/use\.ts:1, src\/use\.ts:6\./);
  assert.deepEqual(report.apiChanges.map((change) => change.locations.length > 0), [...report.apiChanges.map((change) => change.locations.length > 0)].sort((a, b) => Number(b) - Number(a)));
});

test('omitted inputs and a capped inventory make coverage partial', () => {
  const omitted = smallBundle();
  omitted.origin = { kind: 'project', folder: 'rack', declarationSources: { before: 'npm', after: 'npm' }, omitted: ['src/legacy.js: JavaScript is not analyzed'] };
  const partial = analyzeBundle(validateBundle(omitted));
  assert.equal(partial.coverage.status, 'partial');
  assert.match(partial.coverage.notes.join(' '), /src\/legacy\.js/);
  const many = Array.from({ length: MAX_API_CHANGES + 50 }, (_, i) => `export declare function f${i}(): void;`).join('\n');
  const report = analyzeBundle(contract(many, 'export declare function f0(): string;', "import { f1 } from 'label-kit';\nf1();\n"));
  assert.equal(report.apiChanges.length, MAX_API_CHANGES);
  assert.equal(report.apiChanges[0]?.symbol, 'f1');
  assert.equal(report.coverage.status, 'partial');
  assert.match(report.coverage.notes.join(' '), new RegExp(`first ${MAX_API_CHANGES} of ${MAX_API_CHANGES + 50}`));
});

test('inventories namespace members and members inherited from unexported base classes', () => {
  const index = "export { Provider } from './provider';\nexport * as util from './util';\n";
  const files = (base: string, util: string) => ({ 'index.d.ts': index, 'provider.d.ts': "import { Base } from './base';\nexport declare class Provider extends Base {}\n", 'base.d.ts': base, 'util.d.ts': util });
  const bundle = contract('', '', "import { Provider, util } from 'label-kit';\nconst p = new Provider();\n(p as any).addReader('x');\nutil.a();\n");
  bundle.dependency.before.files = files('export declare class Base { addReader(r: string): void; keep(): void }\n', 'export declare function a(): void;\nexport declare function b(): void;\n');
  bundle.dependency.after.files = files('export declare class Base { keep(): void }\n', 'export declare function a(): void;\n');
  const report = analyzeBundle(validateBundle(bundle));
  assert.deepEqual(report.apiChanges.map((change) => [change.kind, change.symbol]).sort(), [['removed', 'Provider.addReader'], ['removed', 'util.b']]);
  assert.equal(report.coverage.status, 'partial');
  assert.match(report.coverage.notes.join(' '), /src\/use\.ts:3/);
});

test('inventories a CommonJS export = function instead of calling it unavailable', () => {
  const report = analyzeBundle(contract('declare function debug(ns: string): void;\nexport = debug;\n', 'declare function debug(ns: string, level: number): void;\nexport = debug;\n', "import debug = require('label-kit');\ndebug('x');\n"));
  assert.equal(report.coverage.status, 'complete');
  assert.deepEqual(report.apiChanges.map((change) => [change.kind, change.symbol, change.locations]), [['changed', 'debug', [{ file: 'src/use.ts', line: 1 }, { file: 'src/use.ts', line: 2 }]]]);
});

// Excerpts of the published prom-client declarations (index.d.ts, Apache-2.0): Registry and register from 12.0.0 lines 4-11 and
// 76-79, and from 13.0.0 lines 4-11 and 77-80. The 13.0.0 CHANGELOG lists `registry.metrics()` as now returning a promise and
// names `res.send(register.metrics())` as the line to change.
const promClient = (metrics: string) => `/**\n * Container for all registered metrics\n */\nexport class Registry {\n\t/**\n\t * Get string representation for all metrics\n\t */\n\t${metrics}\n}\n/**\n * The register that contains all metrics\n */\nexport const register: Registry;\n`;
const promBundle = (source: string): MigrationBundle => validateBundle({
  format: 1, name: 'Metrics endpoint', description: 'prom-client 12 to 13.',
  dependency: {
    name: 'prom-client',
    before: { version: '12.0.0', entry: 'index.d.ts', files: { 'index.d.ts': promClient('metrics(): string;') } },
    after: { version: '13.0.0', entry: 'index.d.ts', files: { 'index.d.ts': promClient('metrics(): Promise<string>;') } },
  },
  sources: { 'src/server.ts': source },
});

test('prom-client 12 to 13: a changed call the compiler accepts is reported as not detected by the compiler', () => {
  const report = analyzeBundle(promBundle("import { register } from 'prom-client';\n\nexport function serveMetrics(res: { send(body?: unknown): void }): void {\n  res.send(register.metrics());\n}\n"));
  assert.deepEqual(report.introduced, []);
  assert.deepEqual(report.apiChanges, [{ kind: 'changed', symbol: 'Registry.metrics', before: 'metrics(): string', after: 'metrics(): Promise<string>', locations: [{ file: 'src/server.ts', line: 4 }] }]);
  assert.equal(report.coverage.status, 'partial');
  assert.deepEqual(report.coverage.notes, [
    'The one API change is used in this code; the compiler does not flag that use, so check it by hand.',
    'Not flagged by the compiler: Registry.metrics at src/server.ts:4. Compiling cleanly does not show that these lines still behave the same.',
  ]);
  const typed = analyzeBundle(promBundle("import { register } from 'prom-client';\n\nexport function body(): string {\n  return register.metrics();\n}\n"));
  assert.deepEqual(typed.introduced.map((item) => [item.file, item.line, item.code]), [['src/server.ts', 4, 2322]]);
  assert.equal(typed.coverage.status, 'complete');
  assert.deepEqual(typed.coverage.notes, ['The one API change is used in this code.']);
});

test('imports of a dependency subpath make coverage partial because only the main entry is inventoried', () => {
  const bundle = smallBundle();
  for (const side of [bundle.dependency.before, bundle.dependency.after]) {
    side.files['dist/extra.d.ts'] = 'export declare function extra(): string;\n';
    side.exports = { './extra': 'dist/extra.d.ts' };
  }
  bundle.sources['src/extra.ts'] = "import { extra } from 'label-kit/extra';\nexport const e: string = extra();\n";
  const report = analyzeBundle(validateBundle(bundle));
  assert.equal(report.coverage.status, 'partial');
  assert.match(report.coverage.notes.join(' '), /This code imports label-kit\/extra\. Ketchup lists API changes for the main label-kit entry only/);
});

test('an error anywhere in the statement or argument that uses a changed API counts as detected, and only there', () => {
  const before = 'export declare function f(a: string): string;\nexport declare function g(a: string): string;\n';
  const after = 'export declare function f(a: string): Promise<string>;\nexport declare function g(a: number): string;\n';
  const silent = (source: string) => {
    const report = analyzeBundle(contract(before, after, source));
    assert.notDeepEqual(report.introduced, []);
    return report.coverage.notes.find((note) => /Not flagged by the compiler/.test(note)) ?? '';
  };
  assert.equal(silent("import { g } from 'label-kit';\ng(\n  'x',\n);\n"), '');
  assert.equal(silent("import { g } from 'label-kit';\nconst n: number =\n  g('x').length;\n"), '');
  assert.match(silent("import { f, g } from 'label-kit';\nexport const o = {\n  a: f('x'),\n  b: g('y'),\n};\n"), /: f at src\/use\.ts:1, src\/use\.ts:3\./);
  assert.match(silent("import { f, g } from 'label-kit';\nconsole.log(f()); g('x');\n"), /: f at src\/use\.ts:1, src\/use\.ts:2\./);
  const removed = analyzeBundle(contract(`${before}export declare function h(): void;\n`, after, "import { f, h } from 'label-kit';\nconsole.log(f('x'));\nh();\n"));
  assert.match(removed.coverage.notes.join(' '), /Not flagged by the compiler: f at /);
});

test('a type-only import() of a dependency subpath also makes coverage partial', () => {
  const report = analyzeBundle(contract('export declare const v: 1;\n', 'export declare const v: 1;\n', "export type T = import('label-kit/types').X;\n"));
  assert.equal(report.coverage.status, 'partial');
  assert.match(report.coverage.notes.join(' '), /This code imports label-kit\/types\./);
});

test('an inherited member is placed only where the receiver is that class, and the first note counts what is used', () => {
  const declarations = (send: string) => `declare class Base { send(v: string): ${send} }\nexport declare class Alpha extends Base { a(): void }\nexport declare class Beta extends Base { b(): void }\n`;
  const report = analyzeBundle(contract(declarations('void'), declarations('Promise<void>'), "import { Alpha } from 'label-kit';\nexport function run(alpha: Alpha): void {\n  alpha.send('x');\n}\n"));
  const at = Object.fromEntries(report.apiChanges.map((change) => [change.symbol, change.locations]));
  assert.deepEqual(at['Alpha.send'], [{ file: 'src/use.ts', line: 3 }]);
  assert.deepEqual(at['Base.send'], [{ file: 'src/use.ts', line: 3 }], 'the declaring class owns the member, so any receiver counts');
  assert.deepEqual(at['Beta.send'], [], 'Beta inherits send, but this code never calls it on a Beta');
  assert.equal(report.coverage.notes[0], '2 of 3 API changes are used in this code; the compiler does not flag any of those uses, so check them by hand.');
  const unused = analyzeBundle(contract('export declare function a(): void;\nexport declare function b(): void;\n', 'export declare function a(): string;\n', 'export const x = 1;\n'));
  assert.deepEqual(unused.coverage.notes, ['None of the 2 API changes is used in this code.'], 'no hand check is asked for an API the code never names');
});
