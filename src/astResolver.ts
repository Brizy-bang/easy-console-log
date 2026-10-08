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

export type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: string; /** true 表示该位置不适合打日志，应跳过而非降级 */ skip: boolean };

/** 根据文件名推断 ScriptKind，非 JS/TS 系返回 undefined（调用方降级为行级插入） */
export function scriptKindForFile(fileName: string): ts.ScriptKind | undefined {
  const ext = /\.([cm]?[jt]sx?)$/i.exec(fileName)?.[1].toLowerCase();
  switch (ext) {
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

/**
 * 创建插入点解析器。一份文本只解析一次，可对多个 offset 复用。
 * 返回的 resolve(offset) 中 offset 为表达式首字符在文本中的偏移量。
 */
export function createInsertTargetResolver(
  text: string,
  fileName: string,
  kind: ts.ScriptKind
): (offset: number) => ResolveResult {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (offset: number) =>
    sourceFile.getLineAndCharacterOfPosition(offset).line;

  const ok = (target: ResolvedTarget): ResolveResult => ({ ok: true, target });
  const fail = (reason: string, skip: boolean): ResolveResult => ({ ok: false, reason, skip });

  return function resolve(offset: number): ResolveResult {
    const leaf = innermostNode(sourceFile, offset);

    if (isInTypePosition(leaf)) {
      return fail('类型/枚举声明位置', true);
    }

    // 1. 函数签名区（参数名、函数名）→ 函数体内部第一行
    let cur: ts.Node | undefined = leaf;
    while (cur) {
      if (isFunctionLike(cur)) {
        const body = cur.body;
        if (body) {
          const bodyStart = body.getStart(sourceFile);
          if (offset < bodyStart) {
            if (ts.isBlock(body)) {
              const line = lineOf(bodyStart);
              return ok({ mode: 'inside-start', anchorLine: line, indentLine: line });
            }
            return fail('箭头函数表达式体，无法插入语句', true);
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
          const line = lineOf(body.getStart(sourceFile));
          return ok({ mode: 'inside-start', anchorLine: line, indentLine: line });
        }
        break;
      }
      cur = cur.parent;
    }

    // 3. 常规语句边界
    const stmt = statementAncestor(leaf);
    if (!stmt) {
      return fail('未找到语句边界', false);
    }
    const startLine = lineOf(stmt.getStart(sourceFile));
    if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
      // return/throw 之后不可达，插到语句之前
      return ok({ mode: 'before', anchorLine: startLine, indentLine: startLine });
    }
    // stmt.end 是开区间，end-1 指向语句最后一个字符（避免落到下一行行首）
    const anchorLine = lineOf(Math.max(stmt.end - 1, stmt.getStart(sourceFile)));
    return ok({ mode: 'after', anchorLine, indentLine: startLine });
  };
}
