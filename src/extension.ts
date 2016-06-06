'use strict';

import * as vscode from 'vscode';
import {OCamlMerlinSession} from './merlin';

export function activate(context: vscode.ExtensionContext) {
    let configuration = vscode.workspace.getConfiguration("ocaml");
    let session = new OCamlMerlinSession();

    let syncBuffer = async (document, token) => {
        await session.request(['checkout', 'auto', document.fileName]);
        if (token.isCancellationRequested) return null;

        await session.request(['seek', 'exact', {line: 1, col: 0}]);
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
        vscode.languages.registerCompletionItemProvider({language: 'ocaml'}, {
            async provideCompletionItems(document, position, token) {
                let line = document.getText(new vscode.Range(
                    new vscode.Position(position.line, 0),
                    position
                ));
                let prefix = /[A-Za-z_][A-Za-z_'0-9]*(?:\.[A-Za-z_][A-Za-z_'0-9]*)*\.?$/.exec(line)[0];

                await syncBuffer(document, token);
                let result = await session.request(['complete', 'prefix', prefix, 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                return new vscode.CompletionList(result.entries.map(({name, kind, desc, info}) => {
                    let completionItem = new vscode.CompletionItem(name);
                    let kindFromMerlin = (kind) => {
                        switch (kind) {
                            case "value": return vscode.CompletionItemKind.Value;
                            case "variant": return vscode.CompletionItemKind.Enum;
                            case "constructor": return vscode.CompletionItemKind.Constructor;
                            case "label": return vscode.CompletionItemKind.Unit;
                            case "module": return vscode.CompletionItemKind.Module;
                            case "signature": return vscode.CompletionItemKind.Interface;
                            case "type": return vscode.CompletionItemKind.Class;
                            case "method": return vscode.CompletionItemKind.Function;
                            case "#": return vscode.CompletionItemKind.Method;
                            case "exn": return vscode.CompletionItemKind.Class;
                            case "class": return vscode.CompletionItemKind.Class;
                        }
                    };

                    completionItem.kind = kindFromMerlin(kind.toLowerCase());
                    completionItem.detail = desc;
                    completionItem.documentation = info;
                    return completionItem;
                }));
            }
        }, '.'));

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider({language: 'ocaml'}, {
            async provideDefinition(document, position, token) {
                await syncBuffer(document, token);

                for (let kind of ['ml', 'mli']) {
                    let result = await session.request(['locate', null, 'ml', 'at', fromVsPos(position)]);
                    if (token.isCancellationRequested) return null;

                    if (typeof result === 'string') {
                        console.log(result);
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
        vscode.languages.registerHoverProvider({language: 'ocaml'}, {
            async provideHover(document, position, token) {
                await syncBuffer(document, token);

                let result = await session.request(['type', 'enclosing', 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (result.length <= 0) return;

                let {start, end, type} = result[0];

                if (type.startsWith('sig')) {
                    let lines = type.split(/\n/g);
                    if (lines.length > 6) {
                        let end = lines.pop();
                        lines = lines.slice(0, 5);
                        lines.push('  (* ... *)');
                        lines.push(end);
                    }
                    type = lines.join('\n');
                } else {
                    type = `type t = ${type}`;
                }

                return new vscode.Hover({language: 'ocaml', value: type}, toVsRange(start, end));
            }
        })
    );

    let provideLinter = async (document, token) => {
        await syncBuffer(document, token);

        let result = await session.request(['errors']);
        if (token.isCancellationRequested) return null;

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