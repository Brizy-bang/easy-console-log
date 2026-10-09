import assert from 'node:assert/strict';
import type { EclConfig } from '../src/config';
import { batchEdits, BatchMode, LineEdit, scanConsole, splitLines } from '../src/consoleScan';

export const cfg: EclConfig = {
  prefix: '🪵',
  quote: "'",
  semicolon: true,
  logFunction: 'console.log',
  includeFilename: true,
  includeLineNumber: true,
  messageTemplate: '${prefix} ~ ${location} ~ ${expr}:',
  diagnosticsEnabled: true,
  diagnosticsSeverity: 'hint',
  updateLineNumbersOnSave: false,
};

/** 将 LineEdit 应用到文本（模拟 VSCode：所有范围基于原文，且不允许重叠） */
export function applyEdits(text: string, edits: readonly LineEdit[]): string {
  const lines = splitLines(text);
  const off = (l: number, c: number) => lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0) + c;
  const ops = edits.map((e) =>
    e.kind === 'insert'
      ? { s: off(e.line, e.char), e: off(e.line, e.char), t: e.text }
      : { s: off(e.line, e.char), e: off(e.endLine, e.endChar), t: e.kind === 'replace' ? e.text : '' }
  );
  ops.sort((a, b) => b.s - a.s);
  for (let i = 1; i < ops.length; i++) {
    assert.ok(ops[i].e <= ops[i - 1].s || ops[i].s === ops[i].e, 'edits overlap');
  }
  let out = text;
  for (const o of ops) {
    out = out.slice(0, o.s) + o.t + out.slice(o.e);
  }
  return out;
}

/** 对文本中所有 console 调用执行批量操作 */
export function runBatch(text: string, mode: BatchMode, file = 'a.ts') {
  const lines = splitLines(text);
  const r = batchEdits(lines, scanConsole(lines, file), mode, file.endsWith('.py') ? '#' : '//');
  return { out: applyEdits(text, r.edits), ...r };
}
