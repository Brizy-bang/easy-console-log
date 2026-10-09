import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLogStatement, generatedMarker } from '../src/logStatement';
import { cfg } from './helpers';

test('generatedMarker：默认模板、空前缀、模板不以固定文本开头', () => {
  assert.equal(generatedMarker(cfg), '🪵 ~ ');
  assert.equal(generatedMarker({ ...cfg, prefix: '' }), undefined);
  assert.equal(generatedMarker({ ...cfg, messageTemplate: '${location} ${prefix}' }), undefined);
  assert.equal(generatedMarker({ ...cfg, prefix: '', messageTemplate: '[DBG] ${expr}' }), '[DBG] ');
});

test('消息转义：文件名引号、多行表达式', () => {
  assert.equal(
    buildLogStatement('a.b(\n  c\n)', "it's.ts", 3, '', cfg),
    "console.log('🪵 ~ it\\'s.ts:3 ~ a.b( c ):', a.b(\n  c\n));"
  );
});

test('消息转义：$ 替换模式与反引号插值', () => {
  assert.equal(buildLogStatement('x', 'a.ts', 1, '', { ...cfg, prefix: '$&' }), "console.log('$& ~ a.ts:1 ~ x:', x);");
  assert.equal(
    buildLogStatement('x', 'a.ts', 1, '', { ...cfg, quote: '`', prefix: '${x}' }),
    'console.log(`\\${x} ~ a.ts:1 ~ x:`, x);'
  );
});

test('Python：print、无分号、反引号退回单引号', () => {
  assert.equal(buildLogStatement('x', 'a.py', 1, '', { ...cfg, quote: '`' }), "print('🪵 ~ a.py:1 ~ x:', x)");
});
