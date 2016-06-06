'use strict';

import * as vscode from 'vscode';
import {OCamlMerlinSession} from './merlin';

export function activate(context: vscode.ExtensionContext) {
    let configuration = vscode.workspace.getConfiguration("ocaml");
    let session = new OCamlMerlinSession();
    
    context.subscriptions.push(session);
    
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider({language: 'ocaml'}, {
            async provideCompletionItems(document, position, token) {
                let line = document.getText(new vscode.Range(
                    new vscode.Position(position.line, 0),
                    position
                ));
                let prefix = /[A-Za-z_][A-Za-z_'0-9]*(?:\.[A-Za-z_][A-Za-z_'0-9]*)*\.?$/.exec(line)[0];

                await session.request(['checkout', 'auto', document.fileName]);
                if (token.isCancellationRequested) return null;

                await session.request(['seek', 'exact', {line: 1, col: 0}]);
                if (token.isCancellationRequested) return null;

                await session.request(['tell', 'source-eof', document.getText()]);
                if (token.isCancellationRequested) return null;

                let result = await session.request(['complete', 'prefix', prefix, 'at', {line: position.line, col: position.character}]);
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
    
    let provideLinter = async (document, token) => {
        await session.request(['checkout', 'auto', document.fileName]);
        if (token.isCancellationRequested) return null;

        await session.request(['seek', 'exact', {line: 1, col: 0}]);
        if (token.isCancellationRequested) return null;

        await session.request(['tell', 'source-eof', document.getText()]);
        if (token.isCancellationRequested) return null;

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
                new vscode.Range(
                    new vscode.Position(start.line, start.col),
                    new vscode.Position(end.line, end.col)), 
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