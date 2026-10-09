import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver, declarationNames, REASON, scriptKindForFile } from '../src/astResolver';

/** 返回按"第 n 次出现的文本"定位的查询函数 */
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

test('作用域：箭头表达式体 / 同行代码块跳过', () => {
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

test('类型位置跳过', () => {
  const at = resolverFor('interface A { x: number }');
  assert.deepEqual(at('x').res, skip(REASON.typePosition));
});

test('case 子句中的语句仍可在其后插入', () => {
  const at = resolverFor('switch (k) {\n  case 1:\n    foo(a);\n  case 2:\n    break;\n}');
  assert.deepEqual(at('a)').res, { ok: true, target: { mode: 'after', anchorLine: 2, indentLine: 2 } });
});

test('expressionAt：链式、可选链、关键字、对象键、数字', () => {
  const at = resolverFor('const v = this.state?.list[0].name;\nobj.method(arg);\nconst o = { key: val };\nreturn 42;');
  assert.equal(at('state').expr?.text, 'this.state?.list[0].name');
  assert.equal(at('obj').expr?.text, 'obj');
  assert.equal(at('const').expr, undefined);
  assert.equal(at('key').expr, undefined);
  assert.equal(at('val').expr?.text, 'val');
  assert.equal(at('42').expr, undefined);
  // 光标紧贴在标识符末尾
  assert.equal(at(' = this').expr?.text, 'v');
});

test('declarationNames：解构与多声明', () => {
  assert.deepEqual(declarationNames('const { a, b: c, ...rest } = obj'), ['a', 'c', 'rest']);
  assert.deepEqual(declarationNames('let [x, , y = 1] = arr'), ['x', 'y']);
  assert.deepEqual(declarationNames('var m = 1, n = 2'), ['m', 'n']);
  assert.equal(declarationNames('foo()'), undefined);
});
