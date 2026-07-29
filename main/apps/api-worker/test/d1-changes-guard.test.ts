import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// D1のmeta.changes参照を「書き込み成立 >= 1」「未書き込み === 0」の2形に限定する。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function accessName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isMetaExpression(node: ts.Expression, aliases: Set<string>): boolean {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) return aliases.has(expression.text);
  return accessName(expression) === 'meta';
}

function collectMetaAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(['meta']);
  const candidates: Array<{ name: string; value: ts.Expression }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      candidates.push({ name: node.name.text, value: node.initializer });
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      candidates.push({ name: node.left.text, value: node.right });
    } else if (ts.isBindingElement(node)) {
      const propertyName = node.propertyName ?? node.name;
      if (
        ts.isIdentifier(propertyName)
        && propertyName.text === 'meta'
        && ts.isIdentifier(node.name)
      ) {
        aliases.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (!aliases.has(candidate.name) && isMetaExpression(candidate.value, aliases)) {
        aliases.add(candidate.name);
        changed = true;
      }
    }
  }
  return aliases;
}

function isMetaChangesAccess(node: ts.Expression, aliases: Set<string>): boolean {
  if (accessName(node) !== 'changes') return false;
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  return isMetaExpression(node.expression, aliases);
}

function numericLiteralIs(node: ts.Expression, value: number): boolean {
  const expression = unwrapExpression(node);
  return ts.isNumericLiteral(expression) && Number(expression.text) === value;
}

function allowedComparison(access: ts.Expression): boolean {
  let expression = access;
  let parent = expression.parent;
  while (
    parent
    && (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
    && parent.expression === expression
  ) {
    expression = parent;
    parent = expression.parent;
  }
  if (
    parent
    && ts.isBinaryExpression(parent)
    && parent.left === expression
    && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && numericLiteralIs(parent.right, 0)
  ) {
    expression = parent;
    parent = expression.parent;
    while (parent && ts.isParenthesizedExpression(parent) && parent.expression === expression) {
      expression = parent;
      parent = expression.parent;
    }
  }
  if (!parent || !ts.isBinaryExpression(parent) || parent.left !== expression) return false;
  return (
    parent.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
    && numericLiteralIs(parent.right, 1)
  ) || (
    parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && numericLiteralIs(parent.right, 0)
  );
}

function bindingReadsMetaChanges(node: ts.BindingElement, aliases: Set<string>): boolean {
  const propertyName = node.propertyName ?? node.name;
  if (!ts.isIdentifier(propertyName) || propertyName.text !== 'changes') return false;
  const owner = node.parent.parent;
  if (ts.isVariableDeclaration(owner) && owner.initializer) {
    return isMetaExpression(owner.initializer, aliases);
  }
  if (!ts.isBindingElement(owner)) return false;
  const ownerPropertyName = owner.propertyName ?? owner.name;
  return ts.isIdentifier(ownerPropertyName) && ownerPropertyName.text === 'meta';
}

function findMetaChangesViolations(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = collectMetaAliases(sourceFile);
  const violations: string[] = [];
  const report = (node: ts.Node): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${fileName}:${position.line + 1}: ${node.getText(sourceFile)}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && isMetaChangesAccess(node, aliases)
      && !allowedComparison(node)
    ) {
      report(node);
    } else if (ts.isBindingElement(node) && bindingReadsMetaChanges(node, aliases)) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('D1 meta.changesガード', () => {
  it('forbids strict meta.changes comparisons that break under D1 triggers', () => {
    const sourceDirectory = join(root, 'src');
    const violations = listTypeScriptFiles(sourceDirectory)
      .flatMap((path) => findMetaChangesViolations(readFileSync(path, 'utf-8'), path));
    expect(violations, 'meta.changesは直接 >= 1 または === 0 で判定し、別名化しないこと。').toEqual([]);
  });

  it('rejects aliases of meta.changes', () => {
    const invalidSource = `
      const changes = result.meta.changes;
      if (changes === 1) throw new Error();
      if (
        (result.meta.changes ?? 0)
        === 1
      ) throw new Error();
      const metadata = result.meta;
      if ((metadata.changes ?? 0) === 1) throw new Error();
      if ((result['meta']['changes'] ?? 0) !== 1) throw new Error();
      const { changes: renamedChanges } = result.meta;
      if (renamedChanges === 1) throw new Error();
    `;
    expect(findMetaChangesViolations(invalidSource, 'invalid.ts')).toHaveLength(5);
    expect(findMetaChangesViolations(`
      if ((result.meta.changes ?? 0) >= 1) accept();
      if ((result.meta.changes ?? 0) === 0) reject();
    `, 'valid.ts')).toEqual([]);
  });
});
