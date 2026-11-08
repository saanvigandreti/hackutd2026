import ts from 'typescript';
import type { Diagnostic, GateViolation } from './types.ts';

interface Shape {
  bypasses: Map<string, number>;
  exports: Set<string>;
  substantive: boolean;
  functions: Map<string, boolean>;
  exportedLocals: Set<string>;
  suppressions: number;
}

const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((item) => item.kind === ts.SyntaxKind.DefaultKeyword);
const nothing = (node: ts.Node | undefined): boolean => node === undefined || (ts.isIdentifier(node) && node.text === 'undefined')
  || (ts.isVoidExpression(node) && ts.isLiteralExpression(node.expression)) || (ts.isParenthesizedExpression(node) && nothing(node.expression));
const emptyBody = (body: ts.Node | undefined) => body !== undefined && (ts.isBlock(body)
  ? body.statements.every((item) => ts.isEmptyStatement(item) || (ts.isReturnStatement(item) && nothing(item.expression)))
  : nothing(body));

function shape(text: string): Shape {
  const file = ts.createSourceFile('candidate.ts', text, ts.ScriptTarget.Latest, true);
  const bypasses = new Map<string, number>();
  const count = (kind: string) => bypasses.set(kind, (bypasses.get(kind) ?? 0) + 1);
  const exports = new Set<string>();
  const functions = new Map<string, boolean>();
  const exportedLocals = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      count(ts.isAsExpression(parent) ? '`as any` cast' : ts.isTypeAssertionExpression(parent) ? '`<any>` cast' : '`any` type');
    } else if (node.kind === ts.SyntaxKind.NeverKeyword && (ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent))) {
      count(ts.isAsExpression(node.parent) ? '`as never` cast' : '`<never>` cast');
    } else if (ts.isAsExpression(node) && node.type.kind !== ts.SyntaxKind.AnyKeyword
      && ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
      count('`as unknown as` cast');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  let substantive = false;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isEmptyStatement(statement)
      && !(ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length === 0)) substantive = true;
    if (ts.isFunctionDeclaration(statement) && statement.body) functions.set(statement.name?.text ?? 'default', emptyBody(statement.body));
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          functions.set(declaration.name.text, emptyBody(initializer.body));
        }
      }
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exportedLocals.add((element.propertyName ?? element.name).text);
      }
      if (!statement.exportClause) exports.add(`* from ${statement.moduleSpecifier?.getText(file) ?? ''}`);
      else if (ts.isNamespaceExport(statement.exportClause)) exports.add(statement.exportClause.name.text);
      else for (const element of statement.exportClause.elements) exports.add(element.name.text);
    } else if (ts.isExportAssignment(statement)) {
      exports.add(statement.isExportEquals ? 'export =' : 'default');
      if (ts.isIdentifier(statement.expression)) exportedLocals.add(statement.expression.text);
    } else if (exported(statement)) {
      if (isDefault(statement)) exports.add('default');
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) { exports.add(declaration.name.getText(file)); continue; }
          exports.add(declaration.name.text);
          exportedLocals.add(declaration.name.text);
        }
      } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) exports.add((statement.name as ts.Identifier).text);
      if (ts.isFunctionDeclaration(statement)) exportedLocals.add(statement.name?.text ?? 'default');
    }
  }
  const suppressions = text.match(/@ts-(?:ignore|nocheck|expect-error)\b/gi)?.length ?? 0;
  return { bypasses, exports, substantive, functions, exportedLocals, suppressions };
}

/**
 * Deterministic checks that a repair keeps the code's public shape and type safety; no model is consulted.
 * `unused` lists unused-binding diagnostics (TS6133 and its siblings) that the edited code has and the original code on the
 * same version does not: a parameter, import or local the repair stopped using usually carried a value the code still needs.
 */
export function gateRepair(original: Record<string, string>, edited: Record<string, string>, unused: Diagnostic[] = []): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const item of unused) {
    if (Object.hasOwn(original, item.file)) violations.push({ rule: 'unused-binding', file: item.file, message: `The repair leaves a binding unused at ${item.file}:${item.line} (${item.message.split('\n')[0]}), so a value the original code used is now dropped.` });
  }
  for (const file of Object.keys(original).sort()) {
    const before = original[file];
    const after = edited[file];
    if (before === undefined || after === undefined || before === after) continue;
    const old = shape(before);
    const next = shape(after);
    const add = (rule: string, message: string) => violations.push({ rule, file, message });
    if (old.substantive && !next.substantive) add('erased-file', `The repair erases the code in ${file}, leaving only imports or an empty export.`);
    for (const [kind, total] of next.bypasses) {
      const added = total - (old.bypasses.get(kind) ?? 0);
      if (added > 0) add('type-bypass', `The repair adds ${added} ${kind}${added === 1 ? '' : 's'} in ${file}, which hides type errors instead of fixing them.`);
    }
    const removed = [...old.exports].filter((name) => !next.exports.has(name));
    if (removed.length > 0) add('removed-export', `The repair removes the export${removed.length === 1 ? '' : 's'} ${removed.join(', ')} from ${file}.`);
    for (const [name, wasEmpty] of old.functions) {
      if (old.exportedLocals.has(name) && !wasEmpty && next.functions.get(name) === true) add('emptied-function', `The repair empties the body of the exported function ${name} in ${file}.`);
    }
    if (next.suppressions > old.suppressions) add('suppression', `The repair adds a TypeScript suppression directive in ${file}.`);
  }
  return violations;
}
