'use strict';

import * as vscode from 'vscode';
import {OCamlMerlinSession} from './merlin';
import * as child_process from 'child_process';

let getStream = require('get-stream');
let ocamlLang = { language: 'ocaml' };
let configuration = vscode.workspace.getConfiguration("ocaml");

let doOcpIndent = async (code: string, token: vscode.CancellationToken) => {
    let ocpIndentPath = configuration.get<string>('ocpIndentPath');
    let cp = child_process.spawn(ocpIndentPath, ['--numeric']);

    token.onCancellationRequested(() => {
        cp.disconnect();
    });

    cp.stdin.write(code);
    cp.stdin.end();

    let output = await getStream(cp.stdout);
    cp.unref();
    if (token.isCancellationRequested) return null;

    let newIndents =  output.trim().split(/\n/g).map((n) => +n);
    let oldIndents = code.split(/\n/g).map((line) => /^\s*/.exec(line)[0]);

    let edits = [];
    newIndents.forEach((indent, line) => {
        let oldIndent = oldIndents[line];
        let newIndent = ' '.repeat(indent);
        if (oldIndent !== newIndent) {
            edits.push(vscode.TextEdit.replace(
                new vscode.Range(
                    new vscode.Position(line, 0),
                    new vscode.Position(line, oldIndent.length)
                ),
                newIndent)
            );
        }
    });

    return edits;
};

export function activate(context: vscode.ExtensionContext) {
    let session = new OCamlMerlinSession();

    let syncBuffer = async (document, token) => {
        await session.request(['checkout', 'auto', document.fileName]);
        if (token.isCancellationRequested) return null;

        await session.request(['seek', 'exact', { line: 1, col: 0 }]);
        if (token.isCancellationRequested) return null;

        await session.request(['tell', 'source-eof', document.getText()]);
        if (token.isCancellationRequested) return null;
    };

    let toVsPos = (pos) => {
        return new vscode.Position(pos.line - 1, pos.col);
    };
    let fromVsPos = (pos: vscode.Position) => {
        return {line: pos.line + 1, col: pos.character};
    };
    let toVsRange = (start, end) => {
        return new vscode.Range(toVsPos(start), toVsPos(end));
    };

    context.subscriptions.push(session);

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(ocamlLang, {
            provideDocumentFormattingEdits(document, options, token) {
                return doOcpIndent(document.getText(), token);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerOnTypeFormattingEditProvider(ocamlLang, {
            async provideOnTypeFormattingEdits(document, position, ch, options, token) {
                return doOcpIndent(document.getText(), token);
            }
        }, ' ', ';', '\n', ')', ']', '}')
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(ocamlLang, {
            async provideCompletionItems(document, position, token) {
                let line = document.getText(new vscode.Range(
                    new vscode.Position(position.line, 0),
                    position
                ));
                let prefix = /[A-Za-z_][A-Za-z_'0-9]*(?:\.[A-Za-z_][A-Za-z_'0-9]*)*\.?$/.exec(line)[0];

                await syncBuffer(document, token);
                let [status, result] = await session.request(['complete', 'prefix', prefix, 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (status !== 'return') return;

                return new vscode.CompletionList(result.entries.map(({name, kind, desc, info}) => {
                    let completionItem = new vscode.CompletionItem(name);
                    let toVsKind = (kind) => {
                        switch (kind.toLowerCase()) {
                            case "value": return vscode.CompletionItemKind.Value;
                            case "variant": return vscode.CompletionItemKind.Enum;
                            case "constructor": return vscode.CompletionItemKind.Constructor;
                            case "label": return vscode.CompletionItemKind.Field;
                            case "module": return vscode.CompletionItemKind.Module;
                            case "signature": return vscode.CompletionItemKind.Interface;
                            case "type": return vscode.CompletionItemKind.Class;
                            case "method": return vscode.CompletionItemKind.Function;
                            case "#": return vscode.CompletionItemKind.Method;
                            case "exn": return vscode.CompletionItemKind.Constructor;
                            case "class": return vscode.CompletionItemKind.Class;
                        }
                    };

                    completionItem.kind = toVsKind(kind);
                    completionItem.detail = desc;
                    completionItem.documentation = info;
                    return completionItem;
                }));
            }
        }, '.'));

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(ocamlLang, {
            async provideDefinition(document, position, token) {
                await syncBuffer(document, token);

                for (let kind of ['ml', 'mli']) {
                    let [status, result] = await session.request(['locate', null, 'ml', 'at', fromVsPos(position)]);
                    if (token.isCancellationRequested) return null;

                    if (status !== 'return' || typeof result === 'string') {
                        continue;
                    }

                    let uri = document.uri;
                    let {file, pos} = result;
                    if (file) {
                        uri = vscode.Uri.file(file);
                    }
                    return new vscode.Location(uri, toVsPos(pos));
                }

                return null;
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(ocamlLang, {
            async provideDocumentSymbols(document, token) {
                await syncBuffer(document, token);

                let [status, result] = await session.request(['outline']);
                if (token.isCancellationRequested) return null;

                if (status !== 'return') return null;

                let symbols = [];
                let toVsKind = (kind) => {
                    switch (kind.toLowerCase()) {
                        case "value": return vscode.SymbolKind.Variable;
                        case "variant": return vscode.SymbolKind.Enum;
                        case "constructor": return vscode.SymbolKind.Constructor;
                        case "label": return vscode.SymbolKind.Field;
                        case "module": return vscode.SymbolKind.Module;
                        case "signature": return vscode.SymbolKind.Interface;
                        case "type": return vscode.SymbolKind.Class;
                        case "method": return vscode.SymbolKind.Function;
                        case "#": return vscode.SymbolKind.Method;
                        case "exn": return vscode.SymbolKind.Constructor;
                        case "class": return vscode.SymbolKind.Class;
                    }
                };
                let traverse = (nodes) => {
                    for (let {name, kind, start, end, children} of nodes) {
                        symbols.push(new vscode.SymbolInformation(name, toVsKind(kind), toVsRange(start, end)));
                        if (Array.isArray(children)) {
                            traverse(children);
                        }
                    }
                };
                traverse(result);
                return symbols;
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(ocamlLang, {
            async provideHover(document, position, token) {
                await syncBuffer(document, token);

                let [status, result] = await session.request(['type', 'enclosing', 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (status !== 'return' || result.length <= 0) return;

                let {start, end, type} = result[0];

                if (type.includes('\n')) {
                    let lines = type.split(/\n/g);
                    if (lines.length > 6) {
                        let end = lines.pop();
                        lines = lines.slice(0, 5);
                        lines.push('  (* ... *)');
                        lines.push(end);
                    }
                    type = lines.join('\n');
                } else if (!type.startsWith('type ')) {
                    type = `type _ = ${type}`;
                }

                return new vscode.Hover({language: 'ocaml', value: type}, toVsRange(start, end));
            }
        })
    );

    let provideLinter = async (document, token) => {
        await syncBuffer(document, token);

        let [status, result] = await session.request(['errors']);
        if (token.isCancellationRequested) return null;

        if (status !== 'return') return;

        return result.map(({type, start, end, message}) => {
            let fromType = (type) => {
                switch (type) {
                    case 'type':
                    case "parser":
                    case "env":
                    case "unknown":
                        return vscode.DiagnosticSeverity.Error;
                    case "warning":
                        return vscode.DiagnosticSeverity.Warning;
                }
            };

            return new vscode.Diagnostic(
                toVsRange(start, end),
                message,
                fromType(type.toLowerCase()));
        });
    };

    let diagnosticCollection = vscode.languages.createDiagnosticCollection('ocaml');
    let linterCancellationTokenSource: vscode.CancellationTokenSource;
    let linterDebounceTimer: number;

    vscode.workspace.onDidChangeTextDocument(({document}) => {
        if (document.languageId !== 'ocaml') return;

        clearTimeout(linterDebounceTimer);
        linterDebounceTimer = setTimeout(async () => {
            if (linterCancellationTokenSource) {
                linterCancellationTokenSource.cancel();
            }
            linterCancellationTokenSource = new vscode.CancellationTokenSource();

            let diagnostics = await provideLinter(document, linterCancellationTokenSource.token);
            diagnosticCollection.set(document.uri, diagnostics);
        }, configuration.get<number>('lintDelay'));
    });
}

export function deactivate() {
}