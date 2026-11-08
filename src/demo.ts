import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { analyzeBundle, validateBundle } from './engine.ts';
import { DCGM_TAGS, UNIT_BRANDS, csvUrl, metricUnits } from '../scripts/generate-dcgm-contract.ts';
import type { DemoEvidence, DraftResult, Finding, MigrationBundle, OperatorSignal, PatchProposal, PatchReport, ScenarioCheck } from './types.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const load = (name: string): MigrationBundle => validateBundle(JSON.parse(fixture(name)));

/** Type-checks candidate sources against the bundle's target declarations without emitting or running anything. */
function typeCheck(bundle: MigrationBundle, files: Record<string, string>) {
  const root = '/ketchup-check';
  const packageRoot = `${root}/node_modules/${bundle.dependency.name}`;
  const texts = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) texts.set(`${root}/${name}`, content);
  for (const [name, content] of Object.entries(bundle.dependency.after.files)) texts.set(`${packageRoot}/${name}`, content);
  texts.set(`${packageRoot}/package.json`, JSON.stringify({ name: bundle.dependency.name, types: bundle.dependency.after.entry }));
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2023.d.ts'], types: [] };
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile: (name, version) => texts.has(name) ? ts.createSourceFile(name, texts.get(name) ?? '', version, true) : base.getSourceFile(name, version),
    fileExists: (name) => texts.has(name) || (!name.startsWith(root) && base.fileExists(name)),
    readFile: (name) => texts.get(name) ?? (name.startsWith(root) ? undefined : base.readFile(name)),
    directoryExists: (name) => name.startsWith(root) ? [...texts.keys()].some((key) => key.startsWith(`${name}/`)) : base.directoryExists?.(name) ?? false,
    realpath: (name) => name,
    getCurrentDirectory: () => root,
    writeFile: () => { throw new Error('This compiler cannot write files'); },
  };
  const program = ts.createProgram(Object.keys(files).map((name) => `${root}/${name}`), options, host);
  return { program, checker: program.getTypeChecker(), sourceFile: (name: string) => program.getSourceFile(`${root}/${name}`), packageRoot };
}

export interface SponsorCase { label: string; title: string; note: string; url: string; logo: string; logoAlt: string }

interface Scenario {
  id: string;
  summary: string;
  bundle: MigrationBundle;
  /** Reference repair, by source path. */
  reference: Record<string, string>;
  proposal: { summary: string; rationale: string };
  /** Optional case attribution shown alongside the example. */
  sponsorCase: SponsorCase | null;
  evidence(bundle: MigrationBundle, report: PatchReport, fromNemotron: boolean): DemoEvidence;
}

function sameFiles(first: Record<string, string>, second: Record<string, string>): boolean {
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every((key) => first[key] === second[key]);
}

function matches(bundle: MigrationBundle, canonical: MigrationBundle): boolean {
  const copyName = bundle.name.startsWith(`${canonical.name} (`) && /^\((?:\d+|\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)\)$/.test(bundle.name.slice(canonical.name.length + 1));
  return bundle.format === canonical.format && (bundle.name === canonical.name || copyName)
    && bundle.description === canonical.description
    && bundle.dependency.name === canonical.dependency.name
    && JSON.stringify(bundle.dependency.source ?? null) === JSON.stringify(canonical.dependency.source ?? null)
    && ['before', 'after'].every((side) => {
      const actual = side === 'before' ? bundle.dependency.before : bundle.dependency.after;
      const expected = side === 'before' ? canonical.dependency.before : canonical.dependency.after;
      return actual.version === expected.version && actual.entry === expected.entry && sameFiles(actual.files, expected.files);
    }) && sameFiles(bundle.sources, canonical.sources);
}

function structure(source: string): string {
  const file = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.Latest, true);
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(file);
}

function referenceCheck(scenario: Scenario, report: PatchReport, fromNemotron: boolean): { check: ScenarioCheck; same: boolean } {
  const same = report.accepted && Object.keys(report.files).length === Object.keys(scenario.reference).length
    && Object.entries(scenario.reference).every(([path, text]) => report.files[path] !== undefined && structure(report.files[path]) === structure(text));
  const name = 'Matches the reference repair';
  if (!fromNemotron) return { same, check: { name, status: 'not-run', detail: same
    ? 'This candidate is the bundled reference repair, so comparing it with itself establishes nothing.'
    : 'This candidate did not come from Nemotron and differs from the bundled reference repair. The other checks apply; equivalence to the reference is not established.' } };
  return { same, check: same
    ? { name, status: 'passed', detail: 'The Nemotron candidate has the same syntax as the bundled reference repair, ignoring comments and formatting.' }
    : { name, status: 'not-run', detail: 'This candidate differs from the bundled reference repair. The other checks apply; equivalence to the reference is not established.' } };
}

// OpenTelemetry: a published SDK change with an authored consumer.

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Top-level functions, declared or assigned to a const, that take a parameter whose declared type names MetricReader. */
function readerFunctions(file: ts.SourceFile): Map<string, { node: FunctionLike; reader: ts.ParameterDeclaration }> {
  const found = new Map<string, { node: FunctionLike; reader: ts.ParameterDeclaration }>();
  const add = (name: string, node: FunctionLike) => {
    const reader = node.parameters.find((parameter) => parameter.type !== undefined && /\bI?MetricReader\b/.test(parameter.type.getText(file)));
    if (reader) found.set(name, { node, reader });
  };
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) add(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) add(declaration.name.text, declaration.initializer);
      }
    }
  }
  return found;
}

/** Whether a returned value registers the reader: 'unknown' when the code builds it in a way this reader does not follow. */
type Registration = 'yes' | 'no' | 'unknown';

/** For each function that receives a MetricReader in the original code, reads the candidate (type checker only, nothing runs) and finds
 * whether every value it returns is a MeterProvider from the package constructed with that same reader in its `readers` option.
 * `problems` lists definite losses; `unread` lists functions whose provider construction this reader cannot follow. */
function readerRegistration(bundle: MigrationBundle, files: Record<string, string>): { names: string[]; problems: string[]; unread: string[] } {
  const originals = Object.entries(bundle.sources).flatMap(([name, content]) => [...readerFunctions(ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true)).keys()]);
  const { checker, sourceFile, packageRoot } = typeCheck(bundle, files);
  const candidates = new Map(Object.keys(files).flatMap((name) => {
    const file = sourceFile(name);
    return file ? [...readerFunctions(file)] : [];
  }));
  const symbolOf = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  // Follows parentheses, type assertions and const declarations to the expression that produces the value.
  const resolve = (expression: ts.Expression, depth = 0): ts.Expression => {
    if (depth > 8) return expression;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) return resolve(expression.expression, depth + 1);
    if (ts.isIdentifier(expression)) {
      const declaration = symbolOf(expression)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) return resolve(declaration.initializer, depth + 1);
    }
    return expression;
  };
  const packageProvider = (node: ts.NewExpression) => {
    const symbol = symbolOf(node.expression);
    return symbol?.name === 'MeterProvider' && (symbol.declarations ?? []).some((item) => item.getSourceFile().fileName.startsWith(`${packageRoot}/`));
  };
  const isConst = (declaration: ts.Declaration | undefined): declaration is ts.VariableDeclaration & { initializer: ts.Expression } =>
    declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  // A readers array registers the reader when an element, or an element of a spread array literal, is that reader.
  // A conditional registers it only when both branches do.
  const listsReader = (list: ts.Expression, reader: ts.Symbol | undefined, depth = 0): Registration => {
    const array = resolve(list);
    if (depth > 8) return 'unknown';
    if (ts.isConditionalExpression(array)) {
      const branches = [listsReader(array.whenTrue, reader, depth + 1), listsReader(array.whenFalse, reader, depth + 1)];
      return branches.includes('no') ? 'no' : branches.includes('unknown') ? 'unknown' : 'yes';
    }
    if (!ts.isArrayLiteralExpression(array)) return 'unknown';
    let result: Registration = 'no';
    for (const element of array.elements) {
      if (ts.isSpreadElement(element)) {
        const inner = listsReader(element.expression, reader, depth + 1);
        if (inner === 'yes') return 'yes';
        if (inner === 'unknown') result = 'unknown';
        continue;
      }
      const item = resolve(element);
      if (ts.isIdentifier(item) && reader !== undefined && symbolOf(item) === reader) return 'yes';
    }
    return result;
  };
  const registration = (value: ts.Expression, reader: ts.Symbol | undefined): Registration => {
    const provider = resolve(value);
    if (!ts.isNewExpression(provider) || !packageProvider(provider)) return 'unknown';
    const options = provider.arguments?.[0];
    if (!options) return 'no';
    const object = resolve(options);
    if (!ts.isObjectLiteralExpression(object)) return 'unknown';
    const property = object.properties.find((item) => item.name !== undefined && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === 'readers');
    if (!property) return object.properties.some(ts.isSpreadAssignment) ? 'unknown' : 'no';
    if (ts.isPropertyAssignment(property)) return listsReader(property.initializer, reader);
    if (ts.isShorthandPropertyAssignment(property)) {
      const declaration = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
      return isConst(declaration) ? listsReader(declaration.initializer, reader) : 'unknown';
    }
    return 'unknown';
  };
  // An assignment to the reader parameter means the value registered may not be the reader the caller passed.
  const reassigns = (node: FunctionLike, reader: ts.Symbol | undefined): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ts.isIdentifier(child.left) && reader !== undefined && symbolOf(child.left) === reader) found = true;
      ts.forEachChild(child, visit);
    };
    if (node.body) visit(node.body);
    return found;
  };
  const returned = (node: FunctionLike): ts.Expression[] => {
    if (node.body && !ts.isBlock(node.body)) return [node.body];
    const values: ts.Expression[] = [];
    const visit = (child: ts.Node) => {
      if (ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child) && child.expression) values.push(child.expression);
      ts.forEachChild(child, visit);
    };
    if (node.body) ts.forEachChild(node.body, visit);
    return values;
  };
  const problems: string[] = [];
  const unread: string[] = [];
  for (const name of originals) {
    const candidate = candidates.get(name);
    if (!candidate) { problems.push(`${name} no longer exists or no longer takes a MetricReader parameter, so nothing registers the reader.`); continue; }
    const reader = symbolOf(candidate.reader.name);
    const values = returned(candidate.node);
    if (values.length === 0) { problems.push(`${name} no longer returns a MeterProvider.`); continue; }
    const results = values.map((value) => registration(value, reader));
    if (results.includes('no')) problems.push(`The MeterProvider that ${name} returns does not list the reader it receives in its readers option, so the reader is not attached to it.`);
    else if (results.includes('unknown') || reassigns(candidate.node, reader)) unread.push(name);
  }
  return { names: originals, problems, unread };
}

const otelBundle = load('otel-metrics.json');
const otel: Scenario = {
  id: 'opentelemetry-metrics',
  sponsorCase: null,
  summary: 'OpenTelemetry SDK 2 removes addMetricReader(); register the reader in the MeterProvider constructor.',
  bundle: otelBundle,
  reference: { 'src/metrics.ts': fixture('otel-metrics-reference.ts.txt') },
  proposal: {
    summary: 'Register the metric reader when creating the provider.',
    rationale: 'OpenTelemetry SDK 2 removes addMetricReader(). Pass the existing reader through the MeterProvider constructor’s readers option. The caller still receives the configured provider.',
  },
  evidence(bundle, report, fromNemotron) {
    const analysis = analyzeBundle(bundle);
    const reference = referenceCheck(otel, report, fromNemotron);
    const registration = readerRegistration(bundle, report.files);
    const registered = registration.names.length > 0 && registration.problems.length === 0 && registration.unread.length === 0;
    return {
      kind: 'opentelemetry', candidateVerified: reference.same && registered,
      checks: [
        {
          name: 'Breaking change reproduced',
          status: analysis.baseline.length === 0 && analysis.introduced.some((item) => item.code === 2339) ? 'passed' : 'failed',
          detail: `Original code: ${analysis.baseline.length} compiler errors with ${bundle.dependency.before.version}; ${analysis.target.length} with ${bundle.dependency.after.version}. SDK 2 removes addMetricReader().`,
        },
        {
          name: 'Repair compiles', status: report.diagnostics.length === 0 ? 'passed' : 'failed',
          detail: `${report.diagnostics.length} compiler errors against the supplied ${bundle.dependency.after.version} declaration excerpts.`,
        },
        {
          name: 'The reader is still registered', status: registered ? 'passed' : registration.problems.length > 0 || registration.names.length === 0 ? 'failed' : 'not-run',
          detail: registered
            ? `${registration.names.join(', ')} returns a MeterProvider whose readers option includes the reader it receives, read with the TypeScript type checker.`
            : registration.problems.length > 0 ? registration.problems.join(' ')
            : registration.names.length === 0 ? 'The original code has no function that receives a MetricReader, so there is no registration to check.'
            : `Ketchup could not follow how ${registration.unread.join(', ')} builds the MeterProvider it returns or which reader it passes, so whether the reader is still registered was not checked. Review that function by hand.`,
        },
        reference.check,
      ],
      operator: null,
      note: 'Published OpenTelemetry API change; consumer written for Ketchup. Compiler checks use declaration excerpts. No SDK or telemetry exporter was executed.',
      sources: [
        { label: 'OpenTelemetry JS SDK 2.x upgrade guide', url: 'https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md#-opentelemetrysdk-metrics-api-changes' },
        { label: '@opentelemetry/sdk-metrics 1.30.1 on npm', url: 'https://registry.npmjs.org/@opentelemetry%2fsdk-metrics/1.30.1' },
        { label: '@opentelemetry/sdk-metrics 2.0.0 on npm', url: 'https://registry.npmjs.org/@opentelemetry%2fsdk-metrics/2.0.0' },
      ],
    };
  },
};

// GPU health alerts: NVIDIA DCGM Exporter 4.8.4 -> 4.9.0, with metric lists read from the published CSVs.

interface Rule { name: string; metric: string; summary: string; severity: string; direction: string; metricNode: ts.Expression | undefined; threshold: ts.Expression | undefined }

const text = (node: ts.Expression | undefined) => node && ts.isStringLiteralLike(node) ? node.text : '';

/** Reads every defineRule({...}) call without running the code. */
function readRules(file: ts.SourceFile): Rule[] {
  const rules: Rule[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineRule') {
      const [argument] = node.arguments;
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const value = (key: string) => argument.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === key)?.initializer;
        const direction = value('above') ? 'above' : value('below') ? 'below' : '';
        rules.push({ name: text(value('name')), metric: text(value('metric')), summary: text(value('summary')), severity: text(value('severity')), direction, metricNode: value('metric'), threshold: value('above') ?? value('below') });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return rules;
}

/** Type-checks the candidate against the 4.9.0 contract (no emit, no execution) and returns each rule by name with its metric (a literal or a
 * constant's literal type) and threshold unit; a null unit means a plain number. */
function thresholdUnits(bundle: MigrationBundle, files: Record<string, string>): Map<string, Rule & { unit: string | null }> {
  const { checker, sourceFile } = typeCheck(bundle, files);
  const result = new Map<string, Rule & { unit: string | null }>();
  for (const name of Object.keys(files)) {
    const file = sourceFile(name);
    if (!file) continue;
    for (const rule of readRules(file)) {
      let unit: string | null = null;
      if (rule.threshold) {
        const brand = checker.getPropertyOfType(checker.getTypeAtLocation(rule.threshold), '__unit');
        const type = brand && checker.getTypeOfSymbolAtLocation(brand, rule.threshold);
        unit = type?.isStringLiteral() ? type.value : null;
      }
      const metricType = rule.metricNode && checker.getTypeAtLocation(rule.metricNode);
      result.set(rule.name, { ...rule, metric: rule.metric || (metricType?.isStringLiteral() ? metricType.value : ''), unit });
    }
  }
  return result;
}

const rulesOf = (files: Record<string, string>) => Object.entries(files).flatMap(([name, content]) => readRules(ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true)));

const unitWords: Record<string, string> = { Celsius: 'celsius', Watts: 'watts', MHz: 'megahertz', Hertz: 'hertz', Percent: 'percent', Ratio: 'a 0-1 ratio', MiB: 'MiB', Bytes: 'bytes', Millijoules: 'millijoules', Joules: 'joules', MBPerSecond: 'MB/s', BytesPerSecond: 'bytes per second' };
const words = (brand: string | null) => brand === null ? 'a plain number' : unitWords[brand] ?? brand;
const lowerFirst = (value: string) => /^[A-Z][a-z]/.test(value) ? value.charAt(0).toLowerCase() + value.slice(1) : value;

/** Multiplier that converts a value from one stated unit to another: SI prefixes, percent to ratio, and MiB = 2^20 bytes (NIST).
 * Undefined for unit pairs this table does not cover. */
const conversions: Record<string, number> = { 'Percent>Ratio': 0.01, 'MiB>Bytes': 1_048_576, 'MHz>Hertz': 1_000_000, 'Millijoules>Joules': 0.001 };
const conversion = (from: string | null, to: string | null): number | undefined => from === to ? 1 : conversions[`${from}>${to}`];

/** Value of a threshold expression with each property read (`limits.field`) replaced by a fixed number derived from the field name,
 * or undefined when the expression is more than numbers, those reads, + - * /, and calls to the package's unit helpers. Reads syntax only. */
function thresholdValue(node: ts.Expression | undefined, packageName: string): number | undefined {
  if (!node) return undefined;
  const helpers = new Set<string>();
  for (const statement of node.getSourceFile().statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== packageName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) helpers.add(element.name.text);
    if (bindings && ts.isNamespaceImport(bindings)) helpers.add(`${bindings.name.text}.*`);
  }
  const field = (name: string) => 3 + [...name].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) % 9973, 0);
  const evaluate = (expression: ts.Expression): number | undefined => {
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) return evaluate(expression.expression);
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken) {
      const value = evaluate(expression.operand);
      return value === undefined ? undefined : -value;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return field(expression.name.text);
    if (ts.isCallExpression(expression) && expression.arguments.length === 1) {
      const callee = expression.expression;
      const helper = ts.isIdentifier(callee) ? helpers.has(callee.text)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && helpers.has(`${callee.expression.text}.*`);
      return helper ? evaluate(expression.arguments[0] as ts.Expression) : undefined;
    }
    if (ts.isBinaryExpression(expression)) {
      const left = evaluate(expression.left);
      const right = evaluate(expression.right);
      if (left === undefined || right === undefined) return undefined;
      switch (expression.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.SlashToken: return right === 0 ? undefined : left / right;
        default: return undefined;
      }
    }
    return undefined;
  };
  return evaluate(node);
}

const dcgmBundle = load('dcgm-alerts.json');
const published = {
  before: metricUnits(fixture(`dcgm/default-counters-${DCGM_TAGS.before.tag}.csv`)),
  after: metricUnits(fixture(`dcgm/default-counters-${DCGM_TAGS.after.tag}.csv`)),
};
const dcgm: Scenario = {
  id: 'northmark-gpu-alerts',
  sponsorCase: { label: 'NorthMark case', title: 'GPU health alert migration example.', note: 'No affiliation with NorthMark; no NorthMark system, data or API was accessed.', url: 'https://nmc2.com/', logo: '/assets/nmc2-logo.svg', logoAlt: 'NMC²' },
  summary: 'DCGM Exporter 4.9.0 renames default GPU metrics, so alert rules written for 4.8.4 never fire and on-call hears nothing. Ketchup finds them and repairs names and units.',
  bundle: dcgmBundle,
  reference: { 'src/gpu-alerts.ts': fixture('dcgm/gpu-alerts-reference.ts.txt') },
  proposal: {
    summary: 'Move the GPU alert rules to the DCGM Exporter 4.9.0 metric names and units.',
    rationale: 'DCGM Exporter 4.9.0 renames 23 default fields, and eleven also change unit. Each rule now watches its 4.9.0 metric. The utilization, framebuffer and SM clock thresholds convert the team\'s configured limits to the new units (ratio, bytes, hertz), as NVIDIA\'s bundled Grafana dashboard does between the same tags. Rule names, severities and limits stay the same.',
  },
  evidence(bundle, report, fromNemotron) {
    const analysis = analyzeBundle(bundle);
    const original = rulesOf(bundle.sources);
    const candidate = thresholdUnits(bundle, report.files);
    const exported = (metric: string) => published.after.has(metric);
    const silent = original.filter((rule) => !exported(rule.metric));
    const renamed = new Map(rulesOf(dcgm.reference).map((rule) => [rule.name, rule.metric]));
    const changed = (rule: Rule) => {
      const repaired = candidate.get(rule.name);
      return repaired ? [repaired.severity !== rule.severity && `severity ${rule.severity} to ${repaired.severity || 'none'}`,
        repaired.direction !== rule.direction && `threshold ${rule.direction || 'none'} to ${repaired.direction || 'none'}`].filter(Boolean).join(', ') : '';
    };
    // Whether the repaired threshold equals the original threshold converted to the repaired metric's unit.
    const scaleOf = (rule: Rule, repaired: Rule): 'same' | 'wrong' | 'unread' => {
      if (!rule.threshold && !repaired.threshold) return 'same';
      const factor = conversion(published.before.get(rule.metric) ?? null, published.after.get(repaired.metric) ?? null);
      const from = thresholdValue(rule.threshold, bundle.dependency.name);
      const to = thresholdValue(repaired.threshold, bundle.dependency.name);
      if (factor === undefined || from === undefined || to === undefined) return 'unread';
      const expected = from * factor;
      return Math.abs(to - expected) <= 1e-9 * Math.max(1, Math.abs(expected)) ? 'same' : 'wrong';
    };
    const unreadScale: string[] = [];
    const rows: OperatorSignal[] = original.map((rule) => {
      const repaired = candidate.get(rule.name);
      const target = renamed.get(rule.name);
      const expected = repaired ? published.after.get(repaired.metric) ?? null : null;
      const actual = repaired?.unit ? UNIT_BRANDS[repaired.unit] ?? repaired.unit : null;
      const before = published.before.get(rule.metric) ?? null;
      const scale = repaired ? scaleOf(rule, repaired) : 'unread';
      if (repaired && exported(repaired.metric) && (target === undefined || repaired.metric === target) && !changed(rule) && actual === expected && scale === 'unread') unreadScale.push(rule.name);
      const alert = (item: Rule) => `${item.metric || '(no literal metric)'} ${item.direction || 'with no threshold'}${item.threshold ? ` ${item.threshold.getText()}` : ''}`;
      return {
        name: rule.summary,
        rule: rule.name,
        alert: { original: alert(rule), repaired: repaired ? alert(repaired) : 'removed' },
        meaning: `On-call gets no ${rule.severity} alert when ${lowerFirst(rule.summary)}.`,
        original: exported(rule.metric) ? `Can fire: watches ${rule.metric}` : `Never fires: ${rule.metric} is not in the ${DCGM_TAGS.after.tag} default metric list`,
        repaired: !repaired ? 'Missing: this repair removes the rule'
          : !exported(repaired.metric) ? `Still silent: ${repaired.metric || 'its metric'} is not in the ${DCGM_TAGS.after.tag} default metric list`
          : target !== undefined && repaired.metric !== target ? `Different signal: watches ${repaired.metric}; the ${DCGM_TAGS.after.tag} name of ${rule.metric} is ${target}`
          : changed(rule) ? `Rule changed: ${changed(rule)}`
          : actual !== expected ? `Wrong unit: threshold is ${words(actual)}, ${repaired.metric} reports ${words(expected)}`
          : scale === 'wrong' ? `Wrong scale: threshold is not the configured limit${before !== expected ? ` converted from ${words(before)} to ${words(expected)}` : ''}`
          : `Can fire: watches ${repaired.metric}${before !== expected ? ` (threshold now in ${words(expected)})` : ''}`,
      };
    });
    const wrongScale = original.filter((_, index) => rows[index]?.repaired.startsWith('Wrong scale'));
    const restored = rows.filter((row, index) => row.repaired.startsWith('Can fire') && silent.includes(original[index] as Rule)).length;
    const missing = original.filter((rule) => !candidate.has(rule.name));
    const unexported = [...candidate.values()].filter((rule) => !exported(rule.metric));
    const wrongUnits = rows.filter((row) => row.repaired.startsWith('Wrong unit'));
    const altered = original.filter((rule) => changed(rule) !== '');
    const wrongSignal = rows.filter((row) => row.repaired.startsWith('Different signal'));
    const reference = referenceCheck(dcgm, report, fromNemotron);
    const checks: ScenarioCheck[] = [
      {
        name: 'Breaking change reproduced',
        status: analysis.baseline.length === 0 && analysis.introduced.length > 0 && silent.length > 0 ? 'passed' : 'failed',
        detail: `Original rules: ${analysis.baseline.length} compiler errors on ${DCGM_TAGS.before.tag}; ${analysis.target.length} on ${DCGM_TAGS.after.tag}. ${silent.length} of ${original.length} rules name a metric that is not in NVIDIA's ${DCGM_TAGS.after.tag} default list.`,
      },
      {
        name: 'Repair compiles', status: report.diagnostics.length === 0 ? 'passed' : 'failed',
        detail: `${report.diagnostics.length} compiler errors against the ${DCGM_TAGS.after.tag} contract generated from NVIDIA's default-counters.csv.`,
      },
      {
        name: 'Every original rule is still present', status: missing.length === 0 && altered.length === 0 ? 'passed' : 'failed',
        detail: missing.length === 0 && altered.length === 0 ? `All ${original.length} rules are present by name with the same severity and threshold direction.`
          : [missing.length ? `Missing: ${missing.map((rule) => rule.name).join(', ')}.` : '', ...altered.map((rule) => `${rule.name} changed: ${changed(rule)}.`)].filter(Boolean).join(' '),
      },
      {
        name: `Every rule watches a ${DCGM_TAGS.after.tag} default metric`, status: candidate.size > 0 && unexported.length === 0 && wrongSignal.length === 0 ? 'passed' : 'failed',
        detail: unexported.length === 0 && wrongSignal.length === 0 ? `Each of the ${candidate.size} rules names a metric in NVIDIA's ${DCGM_TAGS.after.tag} default-counters.csv, and each original rule watches the ${DCGM_TAGS.after.tag} name of its original metric.`
          : [unexported.length ? `Not in the ${DCGM_TAGS.after.tag} list: ${unexported.map((rule) => rule.metric || '(no literal metric)').join(', ')}.` : '', ...wrongSignal.map((row) => `${row.name}: ${row.repaired}.`)].filter(Boolean).join(' '),
      },
      {
        name: 'Threshold units match',
        status: candidate.size === 0 || wrongUnits.length > 0 || wrongScale.length > 0 || unexported.length > 0 ? 'failed' : unreadScale.length > 0 ? 'not-run' : 'passed',
        detail: wrongUnits.length > 0 || wrongScale.length > 0 ? rows.filter((row) => /^Wrong (unit|scale)/.test(row.repaired)).map((row) => `${row.name}: ${row.repaired}`).join('; ')
          : unreadScale.length > 0 ? `Each threshold has the unit that ${DCGM_TAGS.after.tag} states for its metric, read with the TypeScript type checker. Ketchup could not read the threshold arithmetic of ${unreadScale.join(', ')}, so whether it converts the configured limit was not checked.`
          : `Each threshold has the unit that ${DCGM_TAGS.after.tag} states for its metric, read with the TypeScript type checker, and equals the configured limit converted to that unit.`,
      },
      reference.check,
    ];
    const changedUnits = original.flatMap((rule) => {
      const repaired = candidate.get(rule.name);
      const before = published.before.get(rule.metric) ?? null;
      const after = repaired ? published.after.get(repaired.metric) ?? null : null;
      return repaired && exported(repaired.metric) && before !== after ? [`${rule.name}: ${words(before)} to ${words(after)}`] : [];
    });
    const watched = [...new Set([...candidate.values()].filter((rule) => exported(rule.metric)).map((rule) => rule.metric))];
    const unitLine = changedUnits.length ? `Units changed for ${changedUnits.join('; ')}.` : 'No threshold units changed.';
    const unitStep = wrongScale.length ? `2. ${unitLine} This repair does not convert the configured limit for ${wrongScale.map((rule) => rule.name).join(', ')}; fix those thresholds before deploying.`
      : unreadScale.length ? `2. ${unitLine} Check by hand that the thresholds of ${unreadScale.join(', ')} convert the configured limits.`
      : changedUnits.length ? `2. ${unitLine} Keep the configured limits; the repaired thresholds convert them.` : '2. No threshold units changed.';
    return {
      kind: 'dcgm-alerts',
      candidateVerified: report.accepted && checks.slice(1, 5).every((check) => check.status === 'passed'),
      checks,
      operator: {
        headline: restored === silent.length && checks.slice(2, 5).every((check) => check.status === 'passed')
          ? `Same rules. ${silent.length} of ${original.length} alerts would never fire on ${DCGM_TAGS.after.tag}: the rules stay quiet, which looks healthy but is not. The repair brings them back.`
          : `${silent.length} of ${original.length} alerts would never fire on ${DCGM_TAGS.after.tag}: the rules stay quiet, which looks healthy but is not. This repair brings back ${restored}.`,
        rows,
        nextAction: [
          `1. Deploy the repaired rules in the same change that upgrades DCGM Exporter to ${DCGM_TAGS.after.tag}; each version's default metric list lacks the other's names, so rules written for one match nothing on the other.`,
          unitStep,
          `3. Add an absent() guard so a future rename pages instead of going quiet, for example: absent(${watched[0] ?? 'DCGM_FI_DEV_GPU_TEMP_CELSIUS'}).`,
          `4. After the upgrade, confirm in Prometheus that each watched metric returns series: ${watched.map((metric) => `count(${metric})`).join(', ')}.`,
        ].join('\n'),
      },
      note: 'Shows which alerts can match a metric NVIDIA exports by default; it does not read any live GPU or Prometheus data.',
      sources: [
        { label: 'DCGM Exporter 4.9.0 release notes', url: 'https://github.com/NVIDIA/dcgm-exporter/releases/tag/4.9.0' },
        { label: `default-counters.csv at ${DCGM_TAGS.before.tag} (commit ${DCGM_TAGS.before.commit.slice(0, 8)})`, url: csvUrl(DCGM_TAGS.before.tag) },
        { label: `default-counters.csv at ${DCGM_TAGS.after.tag} (commit ${DCGM_TAGS.after.commit.slice(0, 8)})`, url: csvUrl(DCGM_TAGS.after.tag) },
        { label: `NVIDIA Grafana dashboard at ${DCGM_TAGS.before.tag}`, url: 'https://raw.githubusercontent.com/NVIDIA/dcgm-exporter/4.8.4/grafana/dcgm-exporter-dashboard.json' },
        { label: `NVIDIA Grafana dashboard at ${DCGM_TAGS.after.tag}`, url: 'https://raw.githubusercontent.com/NVIDIA/dcgm-exporter/4.9.0/grafana/dcgm-exporter-dashboard.json' },
        { label: 'Prometheus alerting rules: an alert is active only when its expression returns vector elements', url: 'https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/' },
        { label: 'Prometheus absent()', url: 'https://prometheus.io/docs/prometheus/latest/querying/functions/#absent' },
        { label: 'NMC² Kubernetes Engineer posting naming DCGM Exporter, Prometheus and Grafana', url: 'https://nmc2.com/jobs/senior-kubernetes-engineer-r12967/' },
      ],
    };
  },
};

const scenarios = [dcgm, otel];
const scenarioFor = (bundle: MigrationBundle) => scenarios.find((scenario) => matches(bundle, scenario.bundle));

export function listDemos(): { id: string; name: string; summary: string; sponsorCase: SponsorCase | null }[] {
  return scenarios.map((scenario) => ({ id: scenario.id, name: scenario.bundle.name, summary: scenario.summary, sponsorCase: scenario.sponsorCase }));
}

export function demoBundle(id: string = dcgm.id): MigrationBundle {
  const scenario = scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown example: ${id}`);
  return structuredClone(scenario.bundle);
}

/** The id of the bundled example this bundle is, or null for any other bundle. */
export function demoIdOf(bundle: MigrationBundle): string | null {
  return scenarioFor(bundle)?.id ?? null;
}

/** How Ketchup's handoff and agent describe a published-contract dependency: Ketchup generates the TypeScript contract; the publisher releases its source. */
export function contractOrigin(bundle: MigrationBundle): string {
  const source = bundle.dependency.source;
  if (!source) return `the npm package ${bundle.dependency.name}`;
  return scenarioFor(bundle) === dcgm
    ? `a TypeScript contract Ketchup generates from ${source.publisher}'s published default-counters.csv`
    : `a TypeScript contract Ketchup generates from ${source.publisher}'s published files at ${source.url}`;
}

export function isDemoBundle(bundle: MigrationBundle): boolean {
  return scenarioFor(bundle) !== undefined;
}

export function rehearsalProposal(bundle: MigrationBundle): PatchProposal {
  const scenario = scenarioFor(bundle);
  if (!scenario) throw new Error('The reference repair is available only for an unchanged bundled example. Imported projects require a Nemotron draft or manual edits.');
  return {
    ...scenario.proposal,
    edits: Object.entries(scenario.reference).map(([path, after]) => {
      const before = scenario.bundle.sources[path];
      if (before === undefined) throw new Error(`The ${scenario.id} source fixture ${path} is missing`);
      return { path, before, after };
    }),
  };
}

/** For the GPU alert example, titles each finding on a renamed metric with what the operator loses; the compiler text stays in `detail`.
 * Other findings, and findings for any other bundle, are returned unchanged. */
export function findingHeadlines(bundle: MigrationBundle, findings: Finding[]): Finding[] {
  if (scenarioFor(bundle) !== dcgm) return findings;
  const renamed = new Map(rulesOf(dcgm.reference).map((rule) => [rule.name, rule.metric]));
  const at = new Map(Object.entries(bundle.sources).flatMap(([name, content]) => {
    const file = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
    return readRules(file).flatMap((rule) => rule.metricNode ? [[`${name}:${file.getLineAndCharacterOfPosition(rule.metricNode.getStart(file)).line + 1}`, rule] as const] : []);
  }));
  return findings.map((finding) => {
    const rule = at.get(`${finding.file}:${finding.line}`);
    const target = rule && renamed.get(rule.name);
    return rule && target && finding.detail.includes(`"${rule.metric}"`)
      ? { ...finding, title: `${rule.name} never fires: ${rule.metric} is renamed to ${target} in ${DCGM_TAGS.after.tag}` } : finding;
  });
}

/** Evidence for a bundled example; `origin` 'nemotron' is required before the reference comparison can pass. */
export function demoEvidence(bundle: MigrationBundle, report: PatchReport, origin?: DraftResult['origin']): DemoEvidence | null {
  const scenario = scenarioFor(bundle);
  return scenario ? scenario.evidence(bundle, report, origin === 'nemotron') : null;
}
