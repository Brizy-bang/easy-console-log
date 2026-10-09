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

test('多行调用：注释 / 取消注释往返', () => {
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

test('多行调用：删除整块', () => {
  assert.equal(runBatch(multi, 'delete').out, 'function f() {\n  done();\n}');
});

test('字符串 / 注释里的括号不影响配对', () => {
  const t = "console.log('(', `a${b}\n)`, /* ) */ x); // )\nnext();";
  const [b] = scanConsole(splitLines(t), 'a.ts');
  assert.equal(b.endLine, 1);
  assert.equal(b.trailing, false);
});

test('同行有其他代码：注释跳过，删除只删调用', () => {
  const t = 'console.log(a); doSomething();\nx();';
  const c = runBatch(t, 'comment');
  assert.equal(c.count, 0);
  assert.equal(c.skipped, 1);
  assert.equal(runBatch(t, 'delete').out, 'doSomething();\nx();');
});

test('行尾注释不算同行代码', () => {
  assert.equal(runBatch('console.log(a); // hi\nx();', 'comment').out, '// console.log(a); // hi\nx();');
});

test('相邻块删除到文件末尾不产生重叠范围', () => {
  assert.equal(runBatch('a();\nconsole.log(1);\nconsole.log(2);', 'delete').out, 'a();');
  assert.equal(runBatch('console.log(1);\nconsole.log(2);', 'delete').out, '');
});

test('未闭合的被注释调用退化为单行', () => {
  const t = '// console.log(foo,\nbar();';
  const [b] = scanConsole(splitLines(t), 'a.ts');
  assert.equal(b.endLine, 0);
  assert.equal(runBatch(t, 'uncomment').out, 'console.log(foo,\nbar();');
});

test('识别 console.trace', () => {
  assert.deepEqual(scanConsole(['console.trace(x);'], 'a.ts').map((b) => b.level), ['trace']);
});

test('Python：# 注释 print', () => {
  const t = 'def f(x):\n    print(\n        x)\n';
  const c = runBatch(t, 'comment', 'a.py');
  assert.equal(c.out, 'def f(x):\n    # print(\n    #     x)\n');
  assert.equal(runBatch(c.out, 'uncomment', 'a.py').out, t);
});

test('生成日志识别：自定义函数与多行，空前缀拒绝', () => {
  const t = [
    "console.log('🪵 ~ a.ts:1 ~ x:', x);",
    "console.log('mine', x);",
    "logger.info('🪵 ~ a.ts:3 ~ y:', y);",
    'console.warn(',
    "  '🪵 ~ a.ts:4 ~ z:',",
    '  z',
    ');',
  ].join('\n');
  const g = scanGenerated(splitLines(t), 'a.ts', { ...cfg, logFunction: 'logger.info' });
  assert.deepEqual(g?.map((b) => b.line), [0, 2, 3]);
  assert.equal(scanGenerated(splitLines(t), 'a.ts', { ...cfg, prefix: '' }), undefined);
});
