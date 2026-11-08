import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { isPackageName } from './registry.ts';

export function readImportReferences(sourceText: string, fileName = 'input.ts'): { modules: string[]; types: string[]; paths: string[] } {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  const modules = new Set<string>();

  function addLiteral(node: ts.Node | undefined) {
    if (node && ts.isStringLiteralLike(node)) modules.add(node.text);
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return {
    modules: [...modules],
    types: [...new Set(source.typeReferenceDirectives.map(reference => reference.fileName))],
    paths: [...new Set(source.referencedFiles.map(reference => reference.fileName))],
  };
}

export function packageNameFor(specifier: string): string | null {
  if (!specifier || /[\s\x00-\x1f\x7f\\?#:%]/.test(specifier) || isBuiltin(specifier)) return null;
  const segments = specifier.split('/');
  const packageSegments = specifier.startsWith('@') ? 2 : 1;
  const name = segments.slice(0, packageSegments).join('/');
  if (!isPackageName(name) || isBuiltin(name)) return null;
  if (segments.slice(packageSegments).some(segment => !segment || segment === '.' || segment === '..')) return null;
  return name;
}
