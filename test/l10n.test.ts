import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { REASON } from '../src/astResolver';

const root = path.resolve(__dirname, '..');

/** 提取源码中 l10n.t('...') 的字面量 key（支持 '...' + '...' 拼接） */
function collectKeys(): Set<string> {
  const keys = new Set<string>(Object.values(REASON));
  const srcDir = path.join(root, 'src');
  const call = /l10n\.t\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g;
  const literal = /'((?:[^'\\]|\\.)*)'/g;
  for (const file of fs.readdirSync(srcDir)) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const m of text.matchAll(call)) {
      const parts = [...m[1].matchAll(literal)].map((p) => JSON.parse(`"${p[1].replace(/"/g, '\\"')}"`));
      keys.add(parts.join(''));
    }
  }
  return keys;
}

test('中文 bundle 与源码中的 l10n key 完全一致', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'));
  const keys = collectKeys();
  assert.deepEqual([...keys].filter((k) => !(k in bundle)), [], 'missing translations');
  assert.deepEqual(Object.keys(bundle).filter((k) => !keys.has(k)), [], 'unused translations');
});

test('nls 中英文 key 一致，且 package.json 引用的 key 都存在', () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const refs = [...pkg.matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]);
  assert.deepEqual(refs.filter((k) => !(k in en)), []);
});
