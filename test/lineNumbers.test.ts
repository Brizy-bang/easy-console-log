import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLines } from '../src/consoleScan';
import { lineNumberEdits } from '../src/lineNumbers';
import { applyEdits, cfg } from './helpers';

const update = (text: string, fileName = 'app.ts', c = cfg) => {
  const r = lineNumberEdits(splitLines(text), fileName, c);
  assert.ok(r);
  return { out: applyEdits(text, r.edits), count: r.count };
};

test('刷新过时的行号，保留表达式文本', () => {
  const t = [
    'const a = 1;',
    '',
    "console.log('🪵 ~ app.ts:2 ~ a:', a);",
    "  // console.warn('🪵 ~ app.ts:9 ~ obj[\\'k\\']:', obj['k']);",
  ].join('\n');
  const r = update(t);
  assert.equal(r.count, 2);
  assert.equal(
    r.out,
    [
      'const a = 1;',
      '',
      "console.log('🪵 ~ app.ts:3 ~ a:', a);",
      "  // console.warn('🪵 ~ app.ts:4 ~ obj[\\'k\\']:', obj['k']);",
    ].join('\n')
  );
});

test('行号正确时不产生编辑；不碰手写日志', () => {
  const r = update("console.log('🪵 ~ app.ts:1 ~ a:', a);\nconsole.log('app.ts:1', b);");
  assert.equal(r.count, 0);
});

test('文件重命名后同时更新文件名；多行调用', () => {
  const t = "x();\nconsole.log(\n  \"🪵 ~ old.ts:1 ~ value:\",\n  value\n);";
  assert.equal(update(t, 'new.ts').out, "x();\nconsole.log(\n  \"🪵 ~ new.ts:2 ~ value:\",\n  value\n);");
});

test('自定义模板与关闭文件名', () => {
  const c = { ...cfg, includeFilename: false, messageTemplate: '${prefix} [${line}] ${expr} =' };
  const t = "\n\nconsole.log('🪵 [1] user.name =', user.name);";
  assert.equal(update(t, 'a.ts', c).out, "\n\nconsole.log('🪵 [3] user.name =', user.name);");
});

test('空前缀时返回 undefined', () => {
  assert.equal(lineNumberEdits(['x'], 'a.ts', { ...cfg, prefix: '' }), undefined);
});
