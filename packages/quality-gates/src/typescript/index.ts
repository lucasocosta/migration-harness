import ts from 'typescript';
import { resolve } from 'node:path';

export function checkTypeScript(files: Record<string, string>, root = process.cwd()): { passed: boolean; diagnostics: string[] } {
  const virtual = new Map(Object.entries(files).map(([path, content]) => [resolve(root, path), content]));
  const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, types: [] };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host), originalExists = host.fileExists.bind(host);
  host.readFile = path => virtual.get(resolve(path)) ?? originalRead(path);
  host.fileExists = path => virtual.has(resolve(path)) || originalExists(path);
  host.getSourceFile = (path, version) => {
    const content = host.readFile(path);
    return content === undefined ? undefined : ts.createSourceFile(path, content, version, true);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map(d => `${d.file?.fileName ?? 'typescript'}:${d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  return { passed: diagnostics.length === 0, diagnostics };
}
