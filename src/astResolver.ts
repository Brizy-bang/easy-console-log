import * as ts from 'typescript';

export type InsertMode =
  /** 在目标行末尾追加换行+日志（语句之后） */
  | 'after'
  /** 在目标行行首插入日志+换行（语句之前，如 return） */
  | 'before'
  /** 在目标行末尾追加换行+日志，缩进需加深一级（函数/循环体内部第一行） */
  | 'inside-start';

export interface ResolvedTarget {
  mode: InsertMode;
  /** 插入锚点所在行（0-based） */
  anchorLine: number;
  /** 取缩进参考的行（0-based）。after 用语句起始行，其余同 anchorLine */
  indentLine: number;
}

/** 跳过/失败原因（英文原文，同时作为 l10n 的 key，由调用方翻译） */
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
  | { ok: false; reason: string; /** true 表示该位置不适合打日志，应跳过而非降级 */ skip: boolean };

/** 表达式在文本中的范围 */
export interface ExprRange {
  start: number;
  end: number;
  text: string;
}

export interface Resolver {
  /** offset 为表达式首字符在文本中的偏移量 */
  resolve(offset: number): ResolveResult;
  /** 取光标处可输出的表达式（标识符 / 成员访问链），不是可输出位置时返回 undefined */
  expressionAt(offset: number): ExprRange | undefined;
}

/** 根据文件名推断 ScriptKind，非 JS/TS 系返回 undefined（调用方降级为行级插入） */
export function scriptKindForFile(fileName: string): ts.ScriptKind | undefined {
  return scriptKindForExt(/\.([cm]?[jt]sx?)$/i.exec(fileName)?.[1]);
}

/** 根据 <script lang="..."> 推断 ScriptKind，未知时按 TS 解析（TS 解析器兼容 JS 语法） */
export function scriptKindForLang(lang: string | undefined): ts.ScriptKind {
  return scriptKindForExt(lang) ?? ts.ScriptKind.TS;
}

/** 根据扩展名推断 ScriptKind */
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

/** 语句容器：子节点处于"语句位置"的节点 */
function isStatementContainer(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  );
}

/** 从叶子节点向上找第一个处于语句位置的节点 */
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

/** 叶子节点是否处于纯类型/枚举上下文（打日志无意义） */
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

/** 找到包含 offset 的最内层 AST 节点 */
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

/** 成员访问链的父节点：a.b、a?.b、a[0]、a! */
function isChainParent(parent: ts.Node, child: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(parent) ||
    (ts.isElementAccessExpression(parent) && parent.expression === child) ||
    ts.isNonNullExpression(parent)
  );
}

/**
 * 创建插入点解析器。一份文本只解析一次，可对多个 offset 复用。
 */
export function createResolver(text: string, fileName: string, kind: ts.ScriptKind): Resolver {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (offset: number) =>
    sourceFile.getLineAndCharacterOfPosition(offset).line;

  const ok = (target: ResolvedTarget): ResolveResult => ({ ok: true, target });
  const fail = (reason: string, skip: boolean): ResolveResult => ({ ok: false, reason, skip });

  /** 进入代码块内部第一行；花括号首尾同行时插入会落到块外，需跳过 */
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

    // 1. 函数签名区（参数名、函数名）→ 函数体内部第一行
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
            // 表达式体内的变量（多为参数）在外层语句处已不在作用域
            return fail(inSignature ? REASON.arrowSignature : REASON.insideArrowBody, true);
          }
        }
        break;
      }
      cur = cur.parent;
    }

    // 2. for / for-in / for-of 的初始化区（循环变量等）→ 循环体内部第一行
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

    // 3. 常规语句边界
    const stmt = statementAncestor(leaf);
    if (!stmt) {
      return fail(REASON.noStatement, false);
    }
    const container = stmt.parent;
    const inBlock = !ts.isSourceFile(container);
    const startLine = lineOf(stmt.getStart(sourceFile));
    if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
      // return/throw 之后不可达，插到语句之前；与块起始同行时插到行首会跑到块外
      if (inBlock && lineOf(container.getStart(sourceFile)) === startLine) {
        return fail(REASON.sameLineBlock, true);
      }
      return ok({ mode: 'before', anchorLine: startLine, indentLine: startLine });
    }
    // stmt.end 是开区间，end-1 指向语句最后一个字符（避免落到下一行行首）
    const anchorLine = lineOf(Math.max(stmt.end - 1, stmt.getStart(sourceFile)));
    const braced = ts.isBlock(container) || ts.isModuleBlock(container);
    if (braced && lineOf(container.end - 1) === anchorLine) {
      return fail(REASON.sameLineBlock, true);
    }
    return ok({ mode: 'after', anchorLine, indentLine: startLine });
  }

  function expressionAt(offset: number): ExprRange | undefined {
    // 光标紧贴在标识符末尾时也应识别
    for (const o of [offset, offset - 1]) {
      if (o < 0) {
        continue;
      }
      const leaf = innermostNode(sourceFile, o);
      const isIdent =
        ts.isIdentifier(leaf) ||
        ts.isPrivateIdentifier(leaf) ||
        leaf.kind === ts.SyntaxKind.ThisKeyword;
      // 对象字面量的键名不是变量
      if (!isIdent || (ts.isPropertyAssignment(leaf.parent) && leaf.parent.name === leaf)) {
        continue;
      }
      let node: ts.Node = leaf;
      while (node.parent && isChainParent(node.parent, node)) {
        node = node.parent;
      }
      // user.getName() 中取 user，而非方法引用
      if (ts.isCallExpression(node.parent) && node.parent.expression === node && ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      }
      return { start: node.getStart(sourceFile), end: node.end, text: node.getText(sourceFile) };
    }
    return undefined;
  }

  return { resolve, expressionAt };
}

/**
 * 从 `const { a, b: c, ...rest } = obj` 这类声明中提取所有绑定名。
 * 文本不是变量声明时返回 undefined。
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
