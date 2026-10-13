import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLogStatement, generatedMarker } from '../src/logStatement';
import { cfg } from './helpers';

test('generatedMarker: default template, empty prefix, template without a fixed head', () => {
  assert.equal(generatedMarker(cfg), '🔥 ~ ');
  assert.equal(generatedMarker({ ...cfg, prefix: '' }), undefined);
  assert.equal(generatedMarker({ ...cfg, messageTemplate: '${location} ${prefix}' }), undefined);
  assert.equal(generatedMarker({ ...cfg, prefix: '', messageTemplate: '[DBG] ${expr}' }), '[DBG] ');
});

test('message escaping: quote in file name, multi-line expression', () => {
  assert.equal(
    buildLogStatement('a.b(\n  c\n)', "it's.ts", 3, '', cfg),
    "console.log('🔥 ~ it\\'s.ts:3 ~ a.b( c ):', a.b(\n  c\n));"
  );
});

test('message escaping: $ replacement patterns and backtick interpolation', () => {
  assert.equal(buildLogStatement('x', 'a.ts', 1, '', { ...cfg, prefix: '$&' }), "console.log('$& ~ a.ts:1 ~ x:', x);");
  assert.equal(
    buildLogStatement('x', 'a.ts', 1, '', { ...cfg, quote: '`', prefix: '${x}' }),
    'console.log(`\\${x} ~ a.ts:1 ~ x:`, x);'
  );
});

test('Python: print, no semicolon, backtick falls back to single quote', () => {
  assert.equal(buildLogStatement('x', 'a.py', 1, '', { ...cfg, quote: '`' }), "print('🔥 ~ a.py:1 ~ x:', x)");
});

test('jsonStringify wraps the expression (JS only)', () => {
  assert.equal(
    buildLogStatement('user', 'a.ts', 2, '', { ...cfg, jsonStringify: true }),
    "console.log('🔥 ~ a.ts:2 ~ user:', JSON.stringify(user, null, 2));"
  );
  // ignored for Python
  assert.equal(
    buildLogStatement('user', 'a.py', 2, '', { ...cfg, jsonStringify: true }),
    "print('🔥 ~ a.py:2 ~ user:', user)"
  );
});

test('Python f-string: self-documenting {(expr)=} with doubled literal braces', () => {
  assert.equal(
    buildLogStatement('x', 'a.py', 2, '', { ...cfg, pythonFString: true }),
    "print(f'🔥 ~ a.py:2 ~ {(x)=}:')"
  );
  // literal braces in the message are doubled; the interpolation is not
  assert.equal(
    buildLogStatement('x', 'a.py', 1, '', {
      ...cfg,
      pythonFString: true,
      messageTemplate: '${prefix} {${expr}}',
    }),
    "print(f'🔥 {{{(x)=}}}')"
  );
});
