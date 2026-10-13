import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanConsole, scanGenerated, splitLines } from '../src/consoleScan';
import { cfg, runBatch } from './helpers';

const multi = `function f() {
  console.log(
    'x',
    a
  );
  done();
}`;

test('multi-line call: comment / uncomment round-trip', () => {
  const c = runBatch(multi, 'comment');
  assert.equal(
    c.out,
    `function f() {
  // console.log(
  //   'x',
  //   a
  // );
  done();
}`
  );
  const blocks = scanConsole(splitLines(c.out), 'a.ts');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].commented, true);
  assert.equal(blocks[0].endLine, 4);
  assert.equal(runBatch(c.out, 'uncomment').out, multi);
});

test('multi-line call: delete the whole block', () => {
  assert.equal(runBatch(multi, 'delete').out, 'function f() {\n  done();\n}');
});

test('parens inside strings / comments do not break matching', () => {
  const t = "console.log('(', `a${b}\n)`, /* ) */ x); // )\nnext();";
  const [b] = scanConsole(splitLines(t), 'a.ts');
  assert.equal(b.endLine, 1);
  assert.equal(b.trailing, false);
});

test('call sharing a line with other code: comment skips, delete removes only the call', () => {
  const t = 'console.log(a); doSomething();\nx();';
  const c = runBatch(t, 'comment');
  assert.equal(c.count, 0);
  assert.equal(c.skipped, 1);
  assert.equal(runBatch(t, 'delete').out, 'doSomething();\nx();');
});

test('a trailing line comment does not count as other code', () => {
  assert.equal(runBatch('console.log(a); // hi\nx();', 'comment').out, '// console.log(a); // hi\nx();');
});

test('adjacent blocks deleted to end of file produce no overlapping ranges', () => {
  assert.equal(runBatch('a();\nconsole.log(1);\nconsole.log(2);', 'delete').out, 'a();');
  assert.equal(runBatch('console.log(1);\nconsole.log(2);', 'delete').out, '');
});

test('an unclosed commented call degrades to a single line', () => {
  const t = '// console.log(foo,\nbar();';
  const [b] = scanConsole(splitLines(t), 'a.ts');
  assert.equal(b.endLine, 0);
  assert.equal(runBatch(t, 'uncomment').out, 'console.log(foo,\nbar();');
});

test('console.trace is recognized', () => {
  assert.deepEqual(scanConsole(['console.trace(x);'], 'a.ts').map((b) => b.level), ['trace']);
});

test('more console methods are recognized', () => {
  const t = 'console.table(t);\nconsole.timeEnd("k");\nconsole.assert(ok, "no");\nconsole.count("hit");';
  assert.deepEqual(
    scanConsole(splitLines(t), 'a.ts').map((b) => b.level),
    ['table', 'timeEnd', 'assert', 'count']
  );
});

test('inline calls: detected, skipped when commenting, deleted alone at statement boundaries', () => {
  const t = 'if (ok) console.log(a);\nfoo(); console.warn(b); bar();\n{ console.info(c) }';
  const blocks = scanConsole(splitLines(t), 'a.ts');
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((b) => b.inline));
  const c = runBatch(t, 'comment');
  assert.equal(c.count, 0);
  assert.equal(c.skipped, 3);
  const d = runBatch(t, 'delete');
  assert.equal(d.out, 'if (ok) console.log(a);\nfoo(); bar();\n{ }');
  assert.equal(d.count, 2);
  assert.equal(d.skipped, 1);
});

test('inline calls in expression position are never deleted', () => {
  for (const t of [
    'arr.forEach(x => console.log(x));',
    'ok && console.log(a);',
    'foo(console.log(a), b);',
    'const v = cond ? 1 : console.log(a);',
    'else console.log(a);',
  ]) {
    const r = runBatch(t, 'delete');
    assert.equal(r.out, t, t);
    assert.equal(r.skipped, 1, t);
  }
});

test('line-start call followed by an operator is not deleted', () => {
  const t = 'console.log(a) || fallback();';
  assert.equal(runBatch(t, 'delete').out, t);
  assert.equal(runBatch('console.log(a); next();', 'delete').out, 'next();');
});

test('multiple calls on one line are all found', () => {
  const blocks = scanConsole(['console.log(a); console.log(b);'], 'a.ts');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].inline, false);
  assert.equal(blocks[1].inline, true);
});

test('regex literals do not break paren matching', () => {
  const t = 'console.log(/\\(x\\)/.test(s), /[/]/);\nif (ok) console.warn(/a,b/);\nconst d = a / b;\n';
  const blocks = scanConsole(splitLines(t), 'a.ts');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].endLine, 0);
  assert.equal(runBatch(t, 'delete').out, 'if (ok) console.warn(/a,b/);\nconst d = a / b;\n');
  // a call right after a regex on the same line is still inline
  assert.equal(runBatch('const ok = /x/.test(s); console.log(ok);', 'delete').out, 'const ok = /x/.test(s); ');
});

test('calls inside comments and strings are not matched', () => {
  const t = [
    'x = 1; // console.log(faked)',
    'const s = "console.log(faked)";',
    'call("a;b"); console.log(real)',
  ].join('\n');
  const blocks = scanConsole(splitLines(t), 'a.ts');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].line, 2);
  assert.equal(blocks[0].inline, true);
});

test('Python: comment print with #', () => {
  const t = 'def f(x):\n    print(\n        x)\n';
  const c = runBatch(t, 'comment', 'a.py');
  assert.equal(c.out, 'def f(x):\n    # print(\n    #     x)\n');
  assert.equal(runBatch(c.out, 'uncomment', 'a.py').out, t);
});

test('generated-log detection: custom function and multi-line, empty prefix refused', () => {
  const t = [
    "console.log('🔥 ~ a.ts:1 ~ x:', x);",
    "console.log('mine', x);",
    "logger.info('🔥 ~ a.ts:3 ~ y:', y);",
    'console.warn(',
    "  '🔥 ~ a.ts:4 ~ z:',",
    '  z',
    ');',
  ].join('\n');
  const g = scanGenerated(splitLines(t), 'a.ts', { ...cfg, logFunction: 'logger.info' });
  assert.deepEqual(g?.map((b) => b.line), [0, 2, 3]);
  assert.equal(scanGenerated(splitLines(t), 'a.ts', { ...cfg, prefix: '' }), undefined);
});
