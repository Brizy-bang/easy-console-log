import * as ts from 'typescript';

export type InsertMode =
  /** Append newline + log at the end of the target line (after the statement) */
  | 'after'
  /** Insert log + newline at the start of the target line (before the statement, e.g. return) */
  | 'before'
  /** Append newline + log at the end of the target line, indented one extra level
   * (first line inside a function/loop body) */
  | 'inside-start';

export interface ResolvedTarget {
  mode: InsertMode;
  /** Anchor line for insertion (0-based) */
  anchorLine: number;
  /** Line whose indent is used as reference (0-based); 'after' uses the statement start line, others use anchorLine */
  indentLine: number;
}

/** Skip/failure reasons (English source text, also used as l10n keys and translated by the caller) */
export const REASON = {
  typePosition: 'type or enum declaration',
  arrowSignature: 'arrow function with an expression body has no place for a statement',
  insideArrowBody: 'inside an arrow function expression body',
  sameLineBlock: 'the block opens and closes on the same line',
  noStatement: 'no statement boundary found',
  outsideScript: 'not inside a <script> block',
} as const;

export type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | {
      ok: false;
      reason: string;
      /** true = the position is unsuitable for a log; skip instead of falling back */
      skip: boolean;
    };

/** Range of an expression in the text */
export interface ExprRange {
  start: number;
  end: number;
  text: string;
}

export interface Resolver {
  /** offset is the text offset of the expression's first character */
  resolve(offset: number): ResolveResult;
  /** Loggable expression under the cursor (identifier / member chain); undefined when not loggable */
  expressionAt(offset: number): ExprRange | undefined;
  /** Innermost enclosing function / class names at offset, for ${func}/${cls}; empty string when absent */
  namesAt(offset: number): { func: string; cls: string };
  /** Parameter binding names when the cursor is on a function name; undefined elsewhere */
  paramsAt(offset: number): string[] | undefined;
}

/** Infer ScriptKind from the file name; returns undefined for non-JS/TS (caller falls back to line-level insertion) */
export function scriptKindForFile(fileName: string): ts.ScriptKind | undefined {
  return scriptKindForExt(/\.([cm]?[jt]sx?)$/i.exec(fileName)?.[1]);
}

/** Infer ScriptKind from <script lang="...">; unknown langs parse as TS (the TS parser accepts JS syntax) */
export function scriptKindForLang(lang: string | undefined): ts.ScriptKind {
  return scriptKindForExt(lang) ?? ts.ScriptKind.TS;
}

/** Infer ScriptKind from a file extension */
export function scriptKindForExt(ext: string | undefined): ts.ScriptKind | undefined {
  switch (ext?.toLowerCase()) {
    case 'ts':
    case 'mts':
    case 'cts':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    case 'jsx':
      return ts.ScriptKind.JSX;
    default:
      return undefined;
  }
}

/** Statement container: a node whose children sit in statement position */
function isStatementContainer(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

/** Walk up from a leaf to the first node in statement position */
function statementAncestor(leaf: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = leaf;
  while (cur) {
    if (cur.parent && isStatementContainer(cur.parent)) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Whether the leaf is inside a pure type/enum context (logging would be meaningless) */
function isInTypePosition(leaf: ts.Node): boolean {
  let cur: ts.Node | undefined = leaf;
  while (cur) {
    if (
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeAliasDeclaration(cur) ||
      ts.isEnumDeclaration(cur) ||
      ts.isTypeParameterDeclaration(cur) ||
      ts.isTypeReferenceNode(cur) ||
      ts.isTypeLiteralNode(cur) ||
      ts.isMappedTypeNode(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Find the innermost AST node containing offset */
function innermostNode(sourceFile: ts.SourceFile, offset: number): ts.Node {
  let cur: ts.Node = sourceFile;
  for (;;) {
    let next: ts.Node | undefined;
    cur.forEachChild((child) => {
      if (!next && offset >= child.getStart(sourceFile) && offset < child.end) {
        next = child;
      }
    });
    if (!next) {
      return cur;
    }
    cur = next;
  }
}

/** Member-access chain parents: a.b, a?.b, a[0], a! */
function isChainParent(parent: ts.Node, child: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(parent) ||
    (ts.isElementAccessExpression(parent) && parent.expression === child) ||
    ts.isNonNullExpression(parent)
  );
}

/** Infer a function / class name: its own name first; for anonymous functions and class expressions,
 * the binding variable / property / assignment target */
function inferredName(node: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): string {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const p = node.parent;
  if (p) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(p.left)
    ) {
      return p.left.text;
    }
  }
  return '';
}

/** Collect binding names, incl. destructured ones ({a, b} / [x, y]) */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  const out: string[] = [];
  for (const el of name.elements) {
    if (!ts.isOmittedExpression(el)) {
      out.push(...bindingNames(el.name));
    }
  }
  return out;
}

/** The function-like owned by a name identifier: its own name, or the binding of an anonymous function */
function ownedFunction(leaf: ts.Node): ts.FunctionLikeDeclaration | undefined {
  const p = leaf.parent;
  if (!p) {
    return undefined;
  }
  if (isFunctionLike(p) && p.name === leaf) {
    return p;
  }
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) {
    const init = p.initializer;
    return p.name === leaf && init && isFunctionLike(init) ? init : undefined;
  }
  return undefined;
}

/**
 * Create an insertion-point resolver. A text is parsed once and can be reused for multiple offsets.
 */
export function createResolver(text: string, fileName: string, kind: ts.ScriptKind): Resolver {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (offset: number) =>
    sourceFile.getLineAndCharacterOfPosition(offset).line;

  const ok = (target: ResolvedTarget): ResolveResult => ({ ok: true, target });
  const fail = (reason: string, skip: boolean): ResolveResult => ({ ok: false, reason, skip });

  /** Enter the first line inside a block; when braces open and close on the same line,
   * insertion would land outside - skip */
  const insideBlock = (body: ts.Block): ResolveResult => {
    const line = lineOf(body.getStart(sourceFile));
    if (lineOf(body.end - 1) === line) {
      return fail(REASON.sameLineBlock, true);
    }
    return ok({ mode: 'inside-start', anchorLine: line, indentLine: line });
  };

  function resolve(offset: number): ResolveResult {
    const leaf = innermostNode(sourceFile, offset);

    if (isInTypePosition(leaf)) {
      return fail(REASON.typePosition, true);
    }

    // 1. function signature area (param names, function name) -> first line inside the body
    let cur: ts.Node | undefined = leaf;
    while (cur) {
      if (isFunctionLike(cur)) {
        const body = cur.body;
        if (body) {
          const inSignature = offset < body.getStart(sourceFile);
          if (ts.isBlock(body)) {
            if (inSignature) {
              return insideBlock(body);
            }
          } else {
            // a variable inside an expression body (usually a param) is out of scope at the outer statement
            return fail(inSignature ? REASON.arrowSignature : REASON.insideArrowBody, true);
          }
        }
        break;
      }
      cur = cur.parent;
    }

    // 2. for / for-in / for-of initializer area (loop variables etc.) -> first line inside the loop body
    cur = leaf;
    while (cur) {
      if (ts.isForStatement(cur) || ts.isForInStatement(cur) || ts.isForOfStatement(cur)) {
        const body = cur.statement;
        if (ts.isBlock(body) && offset < body.getStart(sourceFile)) {
          return insideBlock(body);
        }
        break;
      }
      cur = cur.parent;
    }

    // 3. regular statement boundary
    const stmt = statementAncestor(leaf);
    if (!stmt) {
      return fail(REASON.noStatement, false);
    }
    const container = stmt.parent;
    const inBlock = !ts.isSourceFile(container);
    const startLine = lineOf(stmt.getStart(sourceFile));
    if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
      // code after return/throw is unreachable — insert before the statement;
      // when the block starts on the same line, inserting at line start would land outside the block
      if (inBlock && lineOf(container.getStart(sourceFile)) === startLine) {
        return fail(REASON.sameLineBlock, true);
      }
      return ok({ mode: 'before', anchorLine: startLine, indentLine: startLine });
    }
    // stmt.end is exclusive; end-1 points at the statement's last char (avoids landing on the next line start)
    const anchorLine = lineOf(Math.max(stmt.end - 1, stmt.getStart(sourceFile)));
    const braced = ts.isBlock(container) || ts.isModuleBlock(container);
    if (braced && lineOf(container.end - 1) === anchorLine) {
      return fail(REASON.sameLineBlock, true);
    }
    return ok({ mode: 'after', anchorLine, indentLine: startLine });
  }

  function expressionAt(offset: number): ExprRange | undefined {
    // a cursor right at the end of an identifier should still be recognized
    for (const o of [offset, offset - 1]) {
      if (o < 0) {
        continue;
      }
      const leaf = innermostNode(sourceFile, o);
      const isIdent =
        ts.isIdentifier(leaf) ||
        ts.isPrivateIdentifier(leaf) ||
        leaf.kind === ts.SyntaxKind.ThisKeyword;
      // object-literal keys are not variables
      if (!isIdent || (ts.isPropertyAssignment(leaf.parent) && leaf.parent.name === leaf)) {
        continue;
      }
      let node: ts.Node = leaf;
      while (node.parent && isChainParent(node.parent, node)) {
        node = node.parent;
      }
      // for user.getName(), take user rather than the method reference
      if (ts.isCallExpression(node.parent) && node.parent.expression === node && ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      }
      return { start: node.getStart(sourceFile), end: node.end, text: node.getText(sourceFile) };
    }
    return undefined;
  }

  function namesAt(offset: number): { func: string; cls: string } {
    let func = '';
    let cls = '';
    for (let cur: ts.Node | undefined = innermostNode(sourceFile, offset); cur && (!func || !cls); cur = cur.parent) {
      if (!func && isFunctionLike(cur)) {
        // an anonymous callback without a binding name yields '', so the search goes on to the outer function
        func = inferredName(cur);
      } else if (!cls && ts.isClassLike(cur)) {
        cls = inferredName(cur);
      }
    }
    return { func, cls };
  }

  function paramsAt(offset: number): string[] | undefined {
    for (const o of [offset, offset - 1]) {
      if (o < 0) {
        continue;
      }
      const fn = ownedFunction(innermostNode(sourceFile, o));
      if (fn) {
        const names = fn.parameters.flatMap((p) => bindingNames(p.name));
        if (names.length) {
          return names;
        }
      }
    }
    return undefined;
  }

  return { resolve, expressionAt, namesAt, paramsAt };
}

/**
 * Extract all binding names from declarations like `const { a, b: c, ...rest } = obj`.
 * Returns undefined when the text is not a variable declaration.
 */
export function declarationNames(text: string): string[] | undefined {
  const sf = ts.createSourceFile('decl.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements[0];
  if (!stmt || !ts.isVariableStatement(stmt)) {
    return undefined;
  }
  const names: string[] = [];
  const visit = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return;
    }
    for (const el of name.elements) {
      if (!ts.isOmittedExpression(el)) {
        visit(el.name);
      }
    }
  };
  stmt.declarationList.declarations.forEach((d) => visit(d.name));
  return names.length ? names : undefined;
}
