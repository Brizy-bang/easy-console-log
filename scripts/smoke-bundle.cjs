/**
 * Smoke test for the bundled output (run after esbuild-base).
 * Verifies that the lazily loaded out/astResolver.js can be required and its core
 * API works, catching dynamic-import downgrade / missing-artifact issues that
 * would otherwise only surface after publishing.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const out = (...p) => path.join(__dirname, '..', 'out', ...p);
assert.ok(fs.existsSync(out('extension.js')), 'out/extension.js missing');
assert.ok(fs.existsSync(out('astResolver.js')), 'out/astResolver.js missing');

const ast = require(out('astResolver.js'));
assert.equal(typeof ast.createResolver, 'function');
assert.equal(typeof ast.scriptKindForFile, 'function');
assert.equal(typeof ast.declarationNames, 'function');

const kind = ast.scriptKindForFile('a.ts');
assert.notEqual(kind, undefined);
const resolver = ast.createResolver('const x = 1;\nconsole.log(x);\n', 'a.ts', kind);
assert.equal(resolver.expressionAt(6)?.text, 'x');
assert.ok(resolver.resolve(6).ok);

console.log('smoke-bundle: ok');
