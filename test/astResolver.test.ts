import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver, declarationNames, REASON, scriptKindForFile } from '../src/astResolver';

/** Return a lookup that finds the nth occurrence of a text */
function resolverFor(code: string) {
  const kind = scriptKindForFile('a.ts');
  assert.ok(kind !== undefined);
  const r = createResolver(code, 'a.ts', kind);
  return (needle: string, nth = 0) => {
    let idx = -1;
    for (let i = 0; i <= nth; i++) {
      idx = code.indexOf(needle, idx + 1);
    }
    assert.ok(idx >= 0, `needle not found: ${needle}`);
    return { res: r.resolve(idx), expr: r.expressionAt(idx) };
  };
}

const skip = (reason: string) => ({ ok: false, reason, skip: true });

test('scope: arrow expression body / same-line block are skipped', () => {
  const at = resolverFor(
    [
      'const f = (a) => { return a; };',
      'const ids = arr.map((x) => x.id);',
      'if (ok) { foo(b); }',
      'function g(p) {',
      '  return p;',
      '}',
    ].join('\n')
  );
  assert.deepEqual(at('a)').res, skip(REASON.sameLineBlock));
  assert.deepEqual(at('a;').res, skip(REASON.sameLineBlock));
  assert.deepEqual(at('x.id').res, skip(REASON.insideArrowBody));
  assert.deepEqual(at('b)').res, skip(REASON.sameLineBlock));
  assert.deepEqual(at('p)').res, { ok: true, target: { mode: 'inside-start', anchorLine: 3, indentLine: 3 } });
  assert.deepEqual(at('p;').res, { ok: true, target: { mode: 'before', anchorLine: 4, indentLine: 4 } });
  assert.equal(at('ids').res.ok, true);
});

test('type positions are skipped', () => {
  const at = resolverFor('interface A { x: number }');
  assert.deepEqual(at('x').res, skip(REASON.typePosition));
});

test('statements in a case clause can still be inserted after', () => {
  const at = resolverFor('switch (k) {\n  case 1:\n    foo(a);\n  case 2:\n    break;\n}');
  assert.deepEqual(at('a)').res, { ok: true, target: { mode: 'after', anchorLine: 2, indentLine: 2 } });
});

test('expressionAt: chains, optional chains, keywords, object keys, numbers', () => {
  const at = resolverFor('const v = this.state?.list[0].name;\nobj.method(arg);\nconst o = { key: val };\nreturn 42;');
  assert.equal(at('state').expr?.text, 'this.state?.list[0].name');
  assert.equal(at('obj').expr?.text, 'obj');
  assert.equal(at('const').expr, undefined);
  assert.equal(at('key').expr, undefined);
  assert.equal(at('val').expr?.text, 'val');
  assert.equal(at('42').expr, undefined);
  // cursor right at the end of an identifier
  assert.equal(at(' = this').expr?.text, 'v');
});

test('namesAt: function / class / anonymous arrow / top level', () => {
  const code = [
    'class Foo {',
    '  bar() {',
    '    const v = this.x;',
    '  }',
    '}',
    'const load = async (id) => {',
    '  return id;',
    '};',
    'top();',
    'const Bar = class {',
    '  run() {',
    '    list.forEach((item) => {',
    '      use(item);',
    '    });',
    '  }',
    '};',
  ].join('\n');
  const kind = scriptKindForFile('a.ts');
  const r = createResolver(code, 'a.ts', kind!);
  const names = (needle: string) => r.namesAt(code.indexOf(needle));
  assert.deepEqual(names('this.x'), { func: 'bar', cls: 'Foo' });
  assert.deepEqual(names('return id'), { func: 'load', cls: '' });
  assert.deepEqual(names('top'), { func: '', cls: '' });
  // class expression uses its binding name; an anonymous callback falls through to the outer method
  assert.deepEqual(names('use(item)'), { func: 'run', cls: 'Bar' });
});

test('paramsAt: function / method / arrow binding / destructured params / plain variable', () => {
  const code = [
    'function foo(a, b = 1, ...rest) {',
    '  use(a);',
    '}',
    'const bar = ({ x, y: [z] }, w) => { use(z); };',
    'class C {',
    '  method(m1, m2) { use(m1); }',
    '}',
    'const plain = 1;',
    'call(foo);',
  ].join('\n');
  const kind = scriptKindForFile('a.ts');
  const r = createResolver(code, 'a.ts', kind!);
  const names = (needle: string) => r.paramsAt(code.indexOf(needle));
  assert.deepEqual(names('foo(a'), ['a', 'b', 'rest']);
  assert.deepEqual(names('bar ='), ['x', 'z', 'w']);
  assert.deepEqual(names('method('), ['m1', 'm2']);
  assert.equal(names('plain'), undefined);
  assert.equal(names('call('), undefined);
  // a zero-param function falls back to logging the name itself
  const r2 = createResolver('function empty() {}', 'a.ts', kind!);
  assert.equal(r2.paramsAt(9), undefined);
});

test('declarationNames: destructuring and multiple declarations', () => {
  assert.deepEqual(declarationNames('const { a, b: c, ...rest } = obj'), ['a', 'c', 'rest']);
  assert.deepEqual(declarationNames('let [x, , y = 1] = arr'), ['x', 'y']);
  assert.deepEqual(declarationNames('var m = 1, n = 2'), ['m', 'n']);
  assert.equal(declarationNames('foo()'), undefined);
});
