import assert from 'node:assert/strict';
import type { EclConfig } from '../src/config';
import { batchEdits, BatchMode, LineEdit, scanConsole, splitLines } from '../src/consoleScan';

export const cfg: EclConfig = {
  prefix: '🔥',
  quote: "'",
  semicolon: true,
  logFunction: 'console.log',
  includeFilename: true,
  includeLineNumber: true,
  messageTemplate: '${prefix} ~ ${location} ~ ${expr}:',
  diagnosticsEnabled: true,
  diagnosticsSeverity: 'hint',
  updateLineNumbersOnSave: false,
  jsonStringify: false,
  pythonFString: false,
  workspaceExcludeDirs: [],
};

/** Apply LineEdits to text (mimics VS Code: all ranges are based on the original text and must not overlap) */
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

/** Run a batch operation on all console calls in the text */
export function runBatch(text: string, mode: BatchMode, file = 'a.ts') {
  const lines = splitLines(text);
  const r = batchEdits(lines, scanConsole(lines, file), mode, file.endsWith('.py') ? '#' : '//');
  return { out: applyEdits(text, r.edits), ...r };
}
