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

test('refresh stale line numbers, keep the expression text', () => {
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

test('correct line numbers produce no edits; hand-written logs untouched', () => {
  const r = update("console.log('🪵 ~ app.ts:1 ~ a:', a);\nconsole.log('app.ts:1', b);");
  assert.equal(r.count, 0);
});

test('renamed files get the new name; multi-line call', () => {
  const t = "x();\nconsole.log(\n  \"🪵 ~ old.ts:1 ~ value:\",\n  value\n);";
  assert.equal(update(t, 'new.ts').out, "x();\nconsole.log(\n  \"🪵 ~ new.ts:2 ~ value:\",\n  value\n);");
});

test('custom template with file name disabled', () => {
  const c = { ...cfg, includeFilename: false, messageTemplate: '${prefix} [${line}] ${expr} =' };
  const t = "\n\nconsole.log('🪵 [1] user.name =', user.name);";
  assert.equal(update(t, 'a.ts', c).out, "\n\nconsole.log('🪵 [3] user.name =', user.name);");
});

test('${func}/${cls} placeholders keep their original text on refresh', () => {
  const c = { ...cfg, messageTemplate: '${prefix} ~ ${location} ~ ${func} ~ ${expr}:' };
  const t = '\nconsole.log(\'🪵 ~ app.ts:1 ~ fetchUser ~ id:\', id);';
  assert.equal(update(t, 'app.ts', c).out, '\nconsole.log(\'🪵 ~ app.ts:2 ~ fetchUser ~ id:\', id);');
});

test('empty prefix returns undefined', () => {
  assert.equal(lineNumberEdits(['x'], 'a.ts', { ...cfg, prefix: '' }), undefined);
});
