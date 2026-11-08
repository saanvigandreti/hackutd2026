import ts from 'typescript';
import type { ApiChange, Coverage, Diagnostic } from './types.ts';

export const MAX_API_CHANGES = 200;

/** `owner` is set for a member a class or interface inherits: a use counts only when its receiver is that class or interface. */
interface Entry { texts: string[]; deprecated: boolean; nodes: ts.Node[]; owner?: ts.Symbol }
type Inventory = Map<string, Entry>;

export interface SurfaceInput {
  before: ts.Program;
  after: ts.Program;
  beforeEntry: string;
  afterEntry: string;
  /** Virtual paths of the consumer sources, keyed by their bundle path. */
  sources: Record<string, string>;
  /** Prefix of every dependency declaration file in the virtual host. */
  dependencyRoot: string;
  /** Package name of the dependency, used to recognize subpath imports such as `pkg/sub`. */
  dependency: string;
  /** Compiler errors the target version introduces, keyed by bundle path. */
  introduced?: Diagnostic[];
  omitted?: string[];
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const hidden = new Set([ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DeclareKeyword, ts.SyntaxKind.DefaultKeyword]);
const deprecated = (node: ts.Node) => ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'deprecated');
const isPrivate = (node: ts.Node) => (ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === ts.SyntaxKind.PrivateKeyword))
  || ('name' in node && node.name !== undefined && ts.isPrivateIdentifier(node.name as ts.Node));

function print(node: ts.Node, file: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

function memberName(member: ts.Node, file: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member)) return 'constructor';
  if (ts.isCallSignatureDeclaration(member)) return '()';
  if (ts.isIndexSignatureDeclaration(member)) return '[index]';
  const name = (member as ts.NamedDeclaration).name;
  return name === undefined ? '?' : ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText(file);
}

function headerOf(node: ts.Node): ts.Node {
  const modifiers = (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).filter((item) => !hidden.has(item.kind));
  const f = ts.factory;
  if (ts.isClassDeclaration(node)) return f.updateClassDeclaration(node, modifiers, node.name, node.typeParameters, node.heritageClauses, []);
  if (ts.isInterfaceDeclaration(node)) return f.updateInterfaceDeclaration(node, modifiers, node.name, node.typeParameters, node.heritageClauses, []);
  if (ts.isEnumDeclaration(node)) return f.updateEnumDeclaration(node, modifiers, node.name, []);
  if (ts.isModuleDeclaration(node)) return f.updateModuleDeclaration(node, modifiers, node.name, f.createModuleBlock([]));
  if (ts.isFunctionDeclaration(node)) return f.updateFunctionDeclaration(node, modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, undefined);
  if (ts.isTypeAliasDeclaration(node)) return f.updateTypeAliasDeclaration(node, modifiers, node.name, node.typeParameters, node.type);
  return node;
}

function inventory(program: ts.Program, entry: string): Inventory | null {
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry);
  const module = file && checker.getSymbolAtLocation(file);
  if (!module) return null;
  const assigned = module.exports?.get(ts.InternalSymbolName.ExportEquals);
  const target = assigned && assigned.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(assigned) : assigned;
  const exports = target ? [target] : checker.getExportsOfModule(module);
  if (exports.length === 0) return null;
  const result: Inventory = new Map();
  const add = (key: string, node: ts.Node, text: string, owner?: ts.Symbol) => {
    const entry = result.get(key) ?? { texts: [], deprecated: false, nodes: [], ...(owner ? { owner } : {}) };
    entry.texts.push(text);
    entry.deprecated ||= deprecated(node);
    entry.nodes.push(node);
    result.set(key, entry);
  };
  const seen = new Set<ts.Symbol>();
  const visit = (exported: ts.Symbol, name: string): void => {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const own = new Set<ts.Node>(symbol.declarations ?? []);
    for (const declaration of symbol.declarations ?? []) {
      const source = declaration.getSourceFile();
      if (ts.isVariableDeclaration(declaration)) {
        const keyword = declaration.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
        add(name, declaration, `${keyword} ${print(declaration, source)}`);
        continue;
      }
      if (ts.isSourceFile(declaration) || ts.isExportAssignment(declaration)) { add(name, declaration, `namespace ${name}`); continue; }
      const header = headerOf(declaration);
      add(name, declaration, header === declaration ? print(header, source) : print(header, source).replace(/ ?\{ ?\}$/, ''));
      const members: readonly ts.Node[] = ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isEnumDeclaration(declaration) ? declaration.members : [];
      for (const member of members) {
        if (isPrivate(member) || ts.isClassStaticBlockDeclaration(member) || ts.isSemicolonClassElement(member)) continue;
        add(`${name}.${memberName(member, source)}`, member, print(member, source));
      }
    }
    if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
      const sides = [checker.getDeclaredTypeOfSymbol(symbol), ...(symbol.flags & ts.SymbolFlags.Class ? [checker.getTypeOfSymbol(symbol)] : [])];
      for (const property of sides.flatMap((type) => checker.getPropertiesOfType(type))) {
        if (property.name === 'prototype') continue;
        for (const member of property.declarations ?? []) {
          if (own.has(member.parent) || isPrivate(member)) continue;
          add(`${name}.${property.name}`, member, print(member, member.getSourceFile()), symbol);
        }
      }
    }
    if (symbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule) && !seen.has(symbol)) {
      seen.add(symbol);
      for (const inner of checker.getExportsOfModule(symbol)) visit(inner, `${name}.${inner.name}`);
    }
  };
  for (const exported of exports) visit(exported, exported.name);
  return result;
}

function compare(before: Inventory, after: Inventory): ApiChange[] {
  const changes: ApiChange[] = [];
  const removed = new Set<string>();
  for (const [symbol, old] of before) {
    const parts = symbol.split('.');
    if (parts.some((_, index) => index > 0 && removed.has(parts.slice(0, index).join('.')))) continue;
    const next = after.get(symbol);
    const text = old.texts.join('\n');
    if (!next) { removed.add(symbol); changes.push({ kind: 'removed', symbol, before: text, after: null, locations: [] }); continue; }
    const nextText = next.texts.join('\n');
    if (nextText !== text) changes.push({ kind: 'changed', symbol, before: text, after: nextText, locations: [] });
    else if (next.deprecated && !old.deprecated) changes.push({ kind: 'deprecated', symbol, before: text, after: nextText, locations: [] });
  }
  return changes;
}

interface Extent { file: string; start: number; end: number; source: ts.SourceFile }

/** The smallest statement, declaration or expression around a use that a compiler error for that use is reported in. */
function extentOf(at: ts.Node): ts.Node {
  let node = at;
  for (let parent = node.parent; parent && !ts.isSourceFile(parent) && !ts.isBlock(parent) && !ts.isModuleBlock(parent)
    && !ts.isCaseOrDefaultClause(parent) && !ts.isFunctionLike(parent) && !ts.isClassLike(parent) && !ts.isIfStatement(parent)
    && !ts.isIterationStatement(parent, false) && !ts.isSwitchStatement(parent) && !ts.isTryStatement(parent) && !ts.isLabeledStatement(parent)
    && !ts.isObjectLiteralExpression(parent) && !ts.isArrayLiteralExpression(parent) && !ts.isNamedImports(parent) && !ts.isNamedExports(parent)
    && !((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node as ts.Expression)); parent = node.parent) node = parent;
  return node;
}

function locate(input: SurfaceInput, before: Inventory, changes: ApiChange[]): { dynamic: string[]; subpaths: string[]; extents: Map<ApiChange, Extent[]> } {
  const checker = input.before.getTypeChecker();
  const byNode = new Map<ts.Node, { change: ApiChange; owner: ts.Symbol | undefined }[]>();
  const bySymbol = new Map(changes.map((change) => [change.symbol, change]));
  for (const [symbol, entry] of before) {
    const change = bySymbol.get(symbol);
    if (change) for (const node of entry.nodes) byNode.set(node, [...byNode.get(node) ?? [], { change, owner: entry.owner }]);
  }
  const ownerOf = (type: ts.Type | undefined) => {
    const symbol = type?.getSymbol() ?? type?.aliasSymbol;
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  /** The type of the object a member is read from, when `at` is that member access, call or element access. */
  const receiverOf = (at: ts.Node): ts.Type | undefined => {
    const access = ts.isCallExpression(at) || ts.isNewExpression(at) || ts.isDecorator(at) ? at.expression
      : ts.isPropertyAccessExpression(at.parent) && at.parent.name === at ? at.parent : at;
    return ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access) ? checker.getTypeAtLocation(access.expression) : undefined;
  };
  const fromDependency = (node: ts.Node) => node.getSourceFile().fileName.startsWith(input.dependencyRoot);
  const dependencyType = (type: ts.Type) => [type.getSymbol(), type.aliasSymbol].some((symbol) => symbol?.declarations?.some(fromDependency));
  const dynamic: string[] = [];
  const subpaths = new Set<string>();
  const extents = new Map<ApiChange, Extent[]>();
  const importsModule = (parent: ts.Node) => ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)
    || (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent));
  for (const [name, filename] of Object.entries(input.sources)) {
    const file = input.before.getSourceFile(filename);
    if (!file) continue;
    const mark = (declarations: readonly ts.Node[] | undefined, at: ts.Node, receiver = receiverOf(at)) => {
      const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line + 1;
      const around = extentOf(at);
      const extent = { file: name, start: around.getStart(file), end: around.getEnd(), source: file };
      for (const declaration of declarations ?? []) {
        for (const { change, owner } of byNode.get(declaration) ?? []) {
          if (owner && ownerOf(receiver) !== owner) continue;
          if (!change.locations.some((item) => item.file === name && item.line === line)) change.locations.push({ file: name, line });
          extents.set(change, [...extents.get(change) ?? [], extent]);
        }
      }
    };
    const resolve = (symbol: ts.Symbol | undefined) => {
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        try { return checker.getAliasedSymbol(symbol); } catch { return symbol; }
      }
      return symbol;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && importsModule(node.parent) && node.text.startsWith(`${input.dependency}/`)) subpaths.add(node.text);
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) mark(resolve(checker.getSymbolAtLocation(node))?.declarations, node);
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isDecorator(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration) mark([declaration], node);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const contextual = checker.getContextualType(node);
        for (const property of node.properties) {
          const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
          if (contextual && key) mark(contextual.getProperty(key)?.declarations, property, contextual);
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const located = !ts.isElementAccessExpression(node) ? checker.getSymbolAtLocation(node.name)
          : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) ? checker.getSymbolAtLocation(node.argumentExpression) : undefined;
        if (ts.isElementAccessExpression(node) && located) mark(located.declarations, node);
        const object = node.expression;
        let inner: ts.Expression = object;
        while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isNonNullExpression(inner) || ts.isSatisfiesExpression(inner)) inner = inner.expression;
        const anyObject = (checker.getTypeAtLocation(object).flags & ts.TypeFlags.Any) !== 0;
        if ((!located || anyObject) && (anyObject || ts.isElementAccessExpression(node)) && dependencyType(checker.getTypeAtLocation(inner))) {
          dynamic.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { dynamic: [...new Set(dynamic)], subpaths: [...subpaths].sort(), extents };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Exported API inventory of both declaration snapshots, diffed and placed at the consumer code that references each change. */
export function inventoryApi(input: SurfaceInput): { apiChanges: ApiChange[]; coverage: Coverage } {
  const before = inventory(input.before, input.beforeEntry);
  const after = inventory(input.after, input.afterEntry);
  const omitted = input.omitted ?? [];
  if (!before || !after) {
    const sides = [!before && 'old', !after && 'new'].filter(Boolean).join(' and ');
    return { apiChanges: [], coverage: { status: 'unavailable', notes: [
      `Ketchup found no exported API in the ${sides} declarations, so it could not compare the two versions.`,
      'Compiler results alone do not show which API changes affect this code.',
      ...omitted.map((item) => `Left out of the analysis: ${item}`),
    ] } };
  }
  const all = compare(before, after);
  const { dynamic, subpaths, extents } = locate(input, before, all);
  const rank = { removed: 0, changed: 1, deprecated: 2 };
  all.sort((a, b) => Number(b.locations.length > 0) - Number(a.locations.length > 0) || rank[a.kind] - rank[b.kind] || a.symbol.localeCompare(b.symbol));
  const apiChanges = all.slice(0, MAX_API_CHANGES);
  const located = all.filter((change) => change.locations.length > 0).length;
  const unused = all.length - located;
  const reachable = all.some((change) => change.locations.length === 0 && change.kind !== 'deprecated') && dynamic.length > 0;
  const introduced = input.introduced ?? [];
  // A class, interface, enum or namespace header change (heritage, type parameters) is excluded: its members are compared on their own.
  const headerOnly = (change: ApiChange) => change.kind === 'changed' && (before.get(change.symbol)?.nodes ?? [])
    .every((node) => ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node));
  const silent = all.filter((change) => change.kind !== 'deprecated' && change.locations.length > 0 && !headerOnly(change)
    && !(extents.get(change) ?? []).some((at) => introduced.some((item) => {
      if (item.file !== at.file) return false;
      const position = at.source.getPositionOfLineAndCharacter(item.line - 1, item.column - 1);
      return position >= at.start && position < at.end;
    })));
  // The first note is the one sentence a reader acts on; the notes after it are the detail behind it.
  const used = located === all.length ? (all.length === 1 ? 'The one API change is used in this code' : `All ${all.length} API changes are used in this code`)
    : `${located} of ${plural(all.length, 'API change')} ${located === 1 ? 'is' : 'are'} used in this code`;
  const notes = [all.length === 0 ? 'The exported API is the same in both versions.'
    : located === 0 ? (reachable ? `No API change is used directly in this code, but dynamic access may reach ${unused === 1 ? 'the one change' : `the ${unused} changes`}, so check those lines by hand.`
      : all.length === 1 ? 'The one API change is not used in this code.' : `None of the ${all.length} API changes is used in this code.`)
    : silent.length > 0 ? `${used}; the compiler does not flag ${silent.length === located ? (located === 1 ? 'that use' : 'any of those uses') : `${silent.length} of those uses`}, so check ${silent.length === 1 ? 'it' : 'them'} by hand.`
    : reachable ? `${used}; dynamic access may still reach the other ${unused}, so check those lines by hand.`
    : unused > 0 ? `${used}; Ketchup found no use of the other ${unused}.`
    : `${used}.`];
  if (silent.length > 0) {
    const listed = silent.slice(0, 5).map((change) => `${change.symbol} at ${change.locations.slice(0, 3).map((at) => `${at.file}:${at.line}`).join(', ')}`);
    notes.push(`Not flagged by the compiler: ${listed.join('; ')}${silent.length > 5 ? `; and ${silent.length - 5} more` : ''}. Compiling cleanly does not show that these lines still behave the same.`);
  }
  if (reachable) notes.push(`Dynamic access to dependency values at ${dynamic.slice(0, 5).join(', ')}${dynamic.length > 5 ? ` and ${dynamic.length - 5} more` : ''} may reach the ${plural(unused, 'API change')} this code does not name.`);
  if (subpaths.length > 0) notes.push(`This code imports ${subpaths.join(', ')}. Ketchup lists API changes for the main ${input.dependency} entry only; compiler errors from those imports are still reported.`);
  const capped = all.length > apiChanges.length;
  if (capped) notes.push(`Only the first ${MAX_API_CHANGES} of ${all.length} API changes are listed, referenced ones first.`);
  for (const item of omitted) notes.push(`Left out of the analysis: ${item}`);
  const partial = reachable || capped || omitted.length > 0 || silent.length > 0 || subpaths.length > 0;
  return { apiChanges, coverage: { status: partial ? 'partial' : 'complete', notes } };
}
