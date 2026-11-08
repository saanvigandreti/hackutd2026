import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBundle, checkPatch, validateBundle } from '../src/engine.ts';
import { gateRepair } from '../src/gate.ts';
import { smallBundle } from './support.ts';

const original = "import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics';\n\nexport function createMetricsProvider(reader: MetricReader): MeterProvider {\n  const provider = new MeterProvider();\n  provider.addMetricReader(reader);\n  return provider;\n}\n";
const file = 'src/metrics.ts';
const rules = (after: string, before = original) => gateRepair({ [file]: before }, { [file]: after }).map((item) => item.rule);

test('accepts a real migration and ignores unchanged files', () => {
  assert.deepEqual(rules(original.replace('const provider = new MeterProvider();\n  provider.addMetricReader(reader);\n  return provider;', 'return new MeterProvider({ readers: [reader] });')), []);
  assert.deepEqual(gateRepair({ [file]: 'export const a: any = 1;' }, { [file]: 'export const a: any = 1;' }), []);
});

test('rejects erasing the module behind an empty export', () => {
  const found = gateRepair({ [file]: original }, { [file]: 'export {};\n' });
  assert.deepEqual(found.map((item) => item.rule).sort(), ['erased-file', 'removed-export']);
  assert.match(found.find((item) => item.rule === 'removed-export')?.message ?? '', /createMetricsProvider/);
  assert.deepEqual(rules("import { MeterProvider } from '@opentelemetry/sdk-metrics';\n"), ['erased-file', 'removed-export']);
});

test('rejects newly introduced any, as any, <any> and as unknown as bypasses', () => {
  for (const after of [
    original.replace('provider.addMetricReader(reader);', '(provider as any).addMetricReader(reader);'),
    original.replace('provider.addMetricReader(reader);', '(<any>provider).addMetricReader(reader);'),
    original.replace('provider.addMetricReader(reader);', '(provider as unknown as { addMetricReader(r: MetricReader): void }).addMetricReader(reader);'),
    original.replace('const provider = new MeterProvider();', 'const provider: any = new MeterProvider();'),
    original.replace('provider.addMetricReader(reader);', '(provider.addMetricReader as never)(reader);'),
  ]) assert.deepEqual(rules(after), ['type-bypass']);
  const message = gateRepair({ [file]: original }, { [file]: original.replace('provider.addMetricReader(reader);', '(provider as any).addMetricReader(reader);') })[0]?.message;
  assert.match(message ?? '', /1 `as any` cast in src\/metrics\.ts/);
  const angle = gateRepair({ [file]: original }, { [file]: original.replace('provider.addMetricReader(reader);', '(<never>provider).addMetricReader(reader);') });
  assert.deepEqual(angle.map((item) => item.message), ['The repair adds 1 `<never>` cast in src/metrics.ts, which hides type errors instead of fixing them.']);
});

test('allows any that the original already had', () => {
  const before = original.replace('provider.addMetricReader(reader);', '(provider as any).addMetricReader(reader);');
  assert.deepEqual(rules(before.replace('(provider as any).addMetricReader(reader);', '(provider as any).register(reader);'), before), []);
});

test('rejects emptied exported functions and new suppression directives', () => {
  assert.deepEqual(rules('export function createMetricsProvider(reader: unknown): unknown {}\n'), ['emptied-function']);
  const arrow = 'export const start = (x: number) => { console.log(x); };\n';
  assert.deepEqual(rules('export const start = (x: number) => {};\n', arrow), ['emptied-function']);
  assert.deepEqual(rules(original.replace('  provider.addMetricReader', '  // @ts-expect-error removed in 2.x\n  provider.addMetricReader')), ['suppression']);
});

test('tracks removed named, default and re-exports', () => {
  const before = "export { a, b } from './x';\nexport * from './y';\nexport default 1;\nexport class Keep {}\n";
  const found = gateRepair({ [file]: before }, { [file]: "export { a } from './x';\nexport class Keep {}\n" });
  assert.deepEqual(found.map((item) => item.rule), ['removed-export']);
  assert.match(found[0]?.message ?? '', /b, \* from '\.\/y', default/);
});

test('rejects bodies emptied to a bare return or undefined, including functions exported by name', () => {
  assert.deepEqual(rules('export function createMetricsProvider(reader: unknown): unknown {\n  return;\n}\n'), ['emptied-function']);
  assert.deepEqual(rules('export const start = (x: number) => undefined;\n', 'export const start = (x: number) => { console.log(x); };\n'), ['emptied-function']);
  const named = 'function start(x: number) { console.log(x); }\nexport { start as begin };\n';
  assert.deepEqual(rules(named.replace('{ console.log(x); }', '{}'), named), ['emptied-function']);
  assert.deepEqual(rules('function helper() {}\nexport const n = 1;\n', 'function helper() { go(); }\nexport const n = 1;\n'), []);
});

test('a repair that leaves a parameter or import unused is a violation; unused bindings already there are not', () => {
  const bundle = smallBundle();
  bundle.sources = { 'src/label.ts': "import { label } from 'label-kit';\nimport { label as spare } from 'label-kit';\nexport function title(prefix: string): string {\n  const draft = 1;\n  return label('Cooling', prefix);\n}\n" };
  const checked = validateBundle(bundle);
  assert.deepEqual(analyzeBundle(checked).baseline, [], 'unused bindings never count as compiler errors');
  const edit = (after: string) => checkPatch(checked, [{ path: 'src/label.ts', before: "label('Cooling', prefix)", after }]);
  const dropped = edit("label('Cooling', { prefix: 'Rack: ' })");
  assert.deepEqual(dropped.remaining, [], 'the compiler alone accepts the dropped parameter');
  assert.equal(dropped.accepted, false);
  assert.deepEqual(dropped.violations.map((item) => [item.rule, item.file]), [['unused-binding', 'src/label.ts']]);
  assert.match(dropped.violations[0]?.message ?? '', /unused at src\/label\.ts:3 \('prefix' is declared but its value is never read\.\)/);
  const kept = edit("label('Cooling', { prefix })");
  assert.equal(kept.accepted, true, 'spare and draft were unused before the repair, so they are not the repair\'s doing');
  assert.deepEqual(kept.violations, []);
});
