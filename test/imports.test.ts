import assert from 'node:assert/strict';
import test from 'node:test';
import { packageNameFor, readImportReferences } from '../src/imports.ts';

test('reads literal module references in source order and deduplicates them', () => {
  const source = [
    "import primary from 'first';",
    "import 'side-effect';",
    "import type { Options } from '@scope/types';",
    "export { primary } from 'reexport';",
    "export * as namespace from 'namespace-export';",
    "import legacy = require('legacy');",
    "const load = () => import('dynamic', { with: { type: 'json' } });",
    'const template = import(`template-module`);',
    "const common = require('common');",
    'const commonTemplate = require(`common-template`);',
    "type Result = import('type-expression').Result;",
    "type Module = typeof import('typeof-expression');",
    "import again from 'first';",
    "const repeated = require('common');",
  ].join('\n');

  assert.deepEqual(readImportReferences(source), {
    modules: ['first', 'side-effect', '@scope/types', 'reexport', 'namespace-export', 'legacy',
      'dynamic', 'template-module', 'common', 'common-template', 'type-expression', 'typeof-expression'],
    types: [], paths: [],
  });
});

test('ignores comments, plain strings, property calls and computed specifiers', () => {
  const source = [
    '// import "comment";',
    "/* require('block-comment'); import('also-comment'); */",
    'const text = "import fake from \'string-content\'";',
    'const template = `require("template-content")`;',
    'const pattern = /require("regex-content")/;',
    "object.require('property-call');",
    'require(variable);',
    "import('prefix-' + variable);",
    'import(`interpolated-${variable}`);',
    "import '\\u0065scaped';",
    "const nested = `text ${import('nested-import')}`;",
    'throw new Error("The scanner must never execute source");',
  ].join('\n');

  assert.deepEqual(readImportReferences(source), {
    modules: ['escaped', 'nested-import'], types: [], paths: [],
  });
});

test('separates real leading triple-slash directives from module references', () => {
  const source = [
    '/* header */',
    '/// <reference types="node" />',
    '/// <reference types="@scope/types" resolution-mode="import" />',
    '/// <reference path="./ambient.d.ts" />',
    '/// <reference types="node" />',
    '/// <reference path="./ambient.d.ts" />',
    '/// <reference lib="es2023" />',
    '/* /// <reference types="block-comment" /> */',
    "import 'actual-module';",
    '/// <reference types="too-late" />',
    'const fake = \'/// <reference path="./string.d.ts" />\';',
  ].join('\n');

  assert.deepEqual(readImportReferences(source), {
    modules: ['actual-module'], types: ['node', '@scope/types'], paths: ['./ambient.d.ts'],
  });
});

test('uses the filename to distinguish JSX text from expressions', () => {
  const source = [
    'const element = <div title="require(\'attribute-text\')">',
    '  require("jsx-text")',
    '  {import("jsx-expression")}',
    '</div>;',
    'import("after-jsx");',
  ].join('\n');

  for (const fileName of ['component.jsx', 'component.tsx']) {
    assert.deepEqual(readImportReferences(source, fileName), {
      modules: ['jsx-expression', 'after-jsx'], types: [], paths: [],
    });
  }
  assert.deepEqual(readImportReferences('const value = <number>other; import("after-assertion");'), {
    modules: ['after-assertion'], types: [], paths: [],
  });
});

test('extracts scoped and unscoped package roots without changing their spelling', () => {
  assert.deepEqual([
    packageNameFor('react'),
    packageNameFor('react/jsx-runtime'),
    packageNameFor('@scope/pkg'),
    packageNameFor('@scope/pkg/dist/index.js'),
    packageNameFor('a.b_c-d2/subpath'),
    packageNameFor('fs-extra'),
    packageNameFor('test/reporters'),
  ], ['react', 'react', '@scope/pkg', '@scope/pkg', 'a.b_c-d2', 'fs-extra', 'test']);
});

test('rejects builtins and non-package specifiers', () => {
  const invalid = ['', '.', '..', './local', '../local', '/absolute', 'C:\\absolute',
    'file:./local', 'https://example.com/module.js', 'data:text/javascript,export default 1',
    '#private', 'node:fs', 'fs', 'fs/promises', 'node:test', 'node:test/reporters',
    'assert/strict', 'timers/promises', 'fs/not-a-builtin', 'node:unknown',
    '@scope', '@scope/', '@/pkg', '@scope//pkg', 'UPPERCASE', ' pkg', 'pkg ',
    'pkg/sub path', 'pkg\\subpath', 'pkg//subpath', 'pkg/', 'pkg/../other', 'pkg/./other',
    'pkg?query', 'pkg/subpath#fragment', 'pkg%2fother', 'pkg@1.0.0', 'pkg/\0', 'a'.repeat(215)];
  assert.equal(packageNameFor('@scope/valid/subpath'), '@scope/valid');
  for (const specifier of invalid) assert.equal(packageNameFor(specifier), null, specifier);
});
