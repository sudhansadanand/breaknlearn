// Verifies that shipped JavaScript uses ES5 syntax only (older LG webOS engines).
// Walks the TypeScript compiler's JS AST (TypeScript is already a workspace dev dependency).
// Usage: node scripts/es5-check.mjs <file.js> [...]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";

const K = ts.SyntaxKind;
const FORBIDDEN_KINDS = new Map([
  [K.ArrowFunction, "arrow function"],
  [K.ClassDeclaration, "class"],
  [K.ClassExpression, "class"],
  [K.TemplateExpression, "template literal"],
  [K.NoSubstitutionTemplateLiteral, "template literal"],
  [K.TaggedTemplateExpression, "tagged template"],
  [K.SpreadElement, "spread"],
  [K.SpreadAssignment, "object spread"],
  [K.ShorthandPropertyAssignment, "shorthand property"],
  [K.ComputedPropertyName, "computed property"],
  [K.ObjectBindingPattern, "destructuring"],
  [K.ArrayBindingPattern, "destructuring"],
  [K.ForOfStatement, "for…of"],
  [K.ImportDeclaration, "import"],
  [K.ExportDeclaration, "export"],
  [K.ExportAssignment, "export"],
  [K.MetaProperty, "new.target/import.meta"],
  [K.AwaitExpression, "await"],
  [K.YieldExpression, "yield"],
  [K.MethodDeclaration, "method shorthand"],
  [K.BigIntLiteral, "BigInt"],
  [K.ClassStaticBlockDeclaration, "class static block"],
  [K.PrivateIdentifier, "private name"],
  [K.Decorator, "decorator"],
]);
const FORBIDDEN_OPERATORS = new Map([
  [K.QuestionQuestionToken, "??"],
  [K.AsteriskAsteriskToken, "**"],
  [K.AsteriskAsteriskEqualsToken, "**="],
  [K.QuestionQuestionEqualsToken, "??="],
  [K.BarBarEqualsToken, "||="],
  [K.AmpersandAmpersandEqualsToken, "&&="],
]);

/** Returns a list of ES5 violations ("line:col what"); empty when the source is ES5. */
export function es5Violations(text, fileName = "bundle.js") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES5, true, ts.ScriptKind.JS);
  const out = [];
  const at = (node, what) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push(`${line + 1}:${character + 1} ${what}`);
  };
  for (const d of sf.parseDiagnostics ?? []) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    out.push(`${line + 1}:${character + 1} parse error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  const visit = (node) => {
    const kindWhat = FORBIDDEN_KINDS.get(node.kind);
    if (kindWhat) at(node, kindWhat);
    if (ts.isVariableDeclarationList(node) && node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) at(node, "let/const");
    if (ts.isBinaryExpression(node) && FORBIDDEN_OPERATORS.has(node.operatorToken.kind)) at(node, FORBIDDEN_OPERATORS.get(node.operatorToken.kind));
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) at(node, "optional chaining");
    if (ts.isCallExpression(node) && node.expression.kind === K.ImportKeyword) at(node, "dynamic import");
    if (ts.isParameter(node) && (node.initializer || node.dotDotDotToken)) at(node, "default/rest parameter");
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && (node.asteriskToken || node.modifiers?.some((m) => m.kind === K.AsyncKeyword))) at(node, "generator/async function");
    if (ts.isRegularExpressionLiteral(node) && /\/[a-z]*[uysdv][a-z]*$/.test(node.text)) at(node, "ES2015+ regex flag");
    if (ts.isNumericLiteral(node)) {
      const raw = node.getText(sf);
      if (/^0[bBoO]/.test(raw) || raw.includes("_")) at(node, "ES2015+ numeric literal");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const v = es5Violations(readFileSync(f, "utf8"), f);
    if (v.length) {
      bad++;
      console.error(`${f}: ${v.length} non-ES5 construct(s)\n  ${v.slice(0, 20).join("\n  ")}`);
    } else console.log(`${f}: ES5 OK`);
  }
  process.exit(bad ? 1 : 0);
}
