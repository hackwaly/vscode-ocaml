'use strict';

import * as vscode from 'vscode';
import {OCamlMerlinSession} from './merlin';
import * as child_process from 'child_process';
import * as Path from 'path';
import * as Fs from 'fs';

let promisify = require('tiny-promisify');
let fsExists = (path: string) => new Promise((resolve) => {
    Fs.exists(path, resolve);
});
let fsWriteFile = promisify(Fs.writeFile);

let getStream = require('get-stream');
let ocamlLang = { language: 'ocaml' };
let configuration = vscode.workspace.getConfiguration("ocaml");

let doOcpIndent = async (code: string, token: vscode.CancellationToken, range?: vscode.Range) => {
    let ocpIndentPath = configuration.get<string>('ocpIndentPath');
    let args = [];
    if (range) {
        args.push('--lines');
        args.push(`${range.start.line + 1}-${range.end.line + 1}`);
    }
    args.push('--numeric');
    let cp = child_process.spawn(ocpIndentPath, args);

    token.onCancellationRequested(() => {
        cp.disconnect();
    });

    cp.stdin.write(code);
    cp.stdin.end();

    let output = await getStream(cp.stdout);
    cp.unref();
    if (token.isCancellationRequested) return null;

    let newIndents = output.trim().split(/\n/g).map((n) => +n);
    let oldIndents = code.split(/\n/g).map((line) => /^\s*/.exec(line)[0]);

    let edits = [];
    let beginLine = range ? range.start.line : 0;
    newIndents.forEach((indent, index) => {
        let line = beginLine + index;
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

let ocamlKeywords = 'and|as|assert|begin|class|constraint|do|done|downto|else|end|exception|external|false|for|fun|function|functor|if|in|include|inherit|inherit!|initializer|lazy|let|match|method|method!|module|mutable|new|object|of|open|open!|or|private|rec|sig|struct|then|to|true|try|type|val|val!|virtual|when|while|with'.split('|');

export function activate(context: vscode.ExtensionContext) {
    let session = new OCamlMerlinSession();

    let toVsPos = (pos) => {
        return new vscode.Position(pos.line - 1, pos.col);
    };
    let fromVsPos = (pos: vscode.Position) => {
        return { line: pos.line + 1, col: pos.character };
    };
    let toVsRange = (start, end) => {
        return new vscode.Range(toVsPos(start), toVsPos(end));
    };

    context.subscriptions.push(
        vscode.languages.setLanguageConfiguration('ocaml', {
            indentationRules: {
                increaseIndentPattern: /^\s*(type|let)\s[^=]*=\s*$|\b(do|begin|struct|sig)\s*$/,
                decreaseIndentPattern: /\b(done|end)\s*$/,
            }
        })
    );

    context.subscriptions.push(session);

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(ocamlLang, {
            provideDocumentFormattingEdits(document, options, token) {
                return doOcpIndent(document.getText(), token);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider(ocamlLang, {
            provideDocumentRangeFormattingEdits(document, range, options, token) {
                return doOcpIndent(document.getText(), token, range);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerOnTypeFormattingEditProvider(ocamlLang, {
            async provideOnTypeFormattingEdits(document, position, ch, options, token) {
                let isEndAt = (word) => {
                    let wordRange = document.getWordRangeAtPosition(position);
                    return wordRange.end.isEqual(position) && document.getText(wordRange) === word;
                };
                if ((ch === 'd' && !isEndAt('end')) || (ch === 'e' && !isEndAt('done'))) {
                    return [];
                }
                return doOcpIndent(document.getText(), token);
            }
        }, ';', '|', ')', ']', '}', 'd', 'e')
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(ocamlLang, {
            async provideCompletionItems(document, position, token) {
                return new vscode.CompletionList(ocamlKeywords.map((keyword) => {
                    let completionItem = new vscode.CompletionItem(keyword);
                    completionItem.kind = vscode.CompletionItemKind.Keyword;
                    return completionItem;
                }));
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(ocamlLang, {
            async provideCompletionItems(document, position, token) {
                let line = document.getText(new vscode.Range(
                    new vscode.Position(position.line, 0),
                    position
                ));
                let prefix = /[A-Za-z_][A-Za-z_'0-9]*(?:\.[A-Za-z_][A-Za-z_'0-9]*)*\.?$/.exec(line)[0];

                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

                let [status, result] = await session.request(['complete', 'prefix', prefix, 'at', fromVsPos(position), 'with', 'doc']);
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
                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

                let locate = async (kind: string): Promise<vscode.Location> => {
                    let [status, result] = await session.request(['locate', null, kind, 'at', fromVsPos(position)]);
                    if (token.isCancellationRequested) return null;

                    if (status !== 'return' || typeof result === 'string') {
                        return null;
                    }

                    let uri = document.uri;
                    let {file, pos} = result;
                    if (file) {
                        uri = vscode.Uri.file(file);
                    }

                    return new vscode.Location(uri, toVsPos(pos));
                };

                let mlDef = await locate('ml');
                let mliDef = await locate('mli');

                let locs = [];

                if (mlDef && mliDef) {
                    if (mlDef.uri.toString() === mliDef.uri.toString() && mlDef.range.isEqual(mliDef.range)) {
                        locs = [mlDef];
                    } else {
                        locs = [mliDef, mlDef];
                    }
                } else {
                    if (mliDef) locs.push(mliDef);
                    if (mlDef) locs.push(mlDef);
                }

                return locs;
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(ocamlLang, {
            async provideDocumentSymbols(document, token) {
                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

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
                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

                let [status, result] = await session.request(['type', 'enclosing', 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (status !== 'return' || result.length <= 0) return;

                let {start, end, type} = result[0];

                // Try expand type
                if (/^[A-Za-z_0-9']+$/.test(type)) {
                    let [status, result] = await session.request(['type', 'enclosing', 'at', fromVsPos(position)]);
                    if (token.isCancellationRequested) return null;
                    if (!(status !== 'return' || result.length <= 0)) {
                        start = result[0].start;
                        end = result[0].end;
                        type = result[0].type;
                    }
                }

                if (type.includes('\n')) {
                    let lines = type.split(/\n/g);
                    if (lines.length > 6) {
                        let end = lines.pop();
                        lines = lines.slice(0, 5);
                        lines.push('  (* ... *)');
                        lines.push(end);
                    }
                    type = lines.join('\n');
                }

                if (/^sig\b/.test(type)) {
                    type = `module type _ = ${type}`;
                } else if (!/^type\b/.test(type)) {
                    type = `type _ = ${type}`;
                }

                return new vscode.Hover({ language: 'ocaml', value: type }, toVsRange(start, end));
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentHighlightProvider(ocamlLang, {
            async provideDocumentHighlights(document, position, token) {
                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

                let [status, result] = await session.request(['occurrences', 'ident', 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (status !== 'return' || result.length <= 0) return;

                return result.map((item) => {
                    return new vscode.DocumentHighlight(toVsRange(item.start, item.end));
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerRenameProvider(ocamlLang, {
            async provideRenameEdits(document, position, newName, token) {
                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

                let [status, result] = await session.request(['occurrences', 'ident', 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (status !== 'return' || result.length <= 0) return;

                let edits = result.map((item) => {
                    return new vscode.TextEdit(toVsRange(item.start, item.end), newName);
                });

                let edit = new vscode.WorkspaceEdit();
                edit.set(document.uri, edits);
                return edit;
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(ocamlLang, {
            async provideReferences(document, position, context, token) {
                await session.syncBuffer(document.fileName, document.getText(), token);
                if (token.isCancellationRequested) return null;

                let [status, result] = await session.request(['occurrences', 'ident', 'at', fromVsPos(position)]);
                if (token.isCancellationRequested) return null;

                if (status !== 'return' || result.length <= 0) return;

                return result.map((item) => {
                    return new vscode.Location(document.uri, toVsRange(item.start, item.end));
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ocaml.switch_mli_ml', async () => {
            let editor = vscode.window.activeTextEditor;
            let doc = editor != null ? editor.document : null;
            let path = doc != null ? doc.fileName : null;
            let ext = Path.extname(path || '');
            let newExt = { '.mli': '.ml', '.ml': '.mli' }[ext];
            if (!newExt) {
                await vscode.window.showInformationMessage('Target file must be an OCaml signature or implementation file');
                return;
            }

            let newPath = path.substring(0, path.length - ext.length) + newExt;
            if (!(await fsExists(newPath))) {
                await fsWriteFile(newPath, '');
                let name = { '.mli': 'Signature', '.ml': 'Implementation' }[newExt];
                await vscode.window.showInformationMessage(`${name} file doesn't exist. New file has created for you.`);
            }

            await vscode.commands.executeCommand(
                'vscode.open',
                vscode.Uri.file(newPath)
            );
        })
    );


    let utopTerm: vscode.Terminal;
    context.subscriptions.push(
        vscode.commands.registerCommand('ocaml.utop', async () => {
            if (utopTerm) {
                utopTerm.dispose();
            }
            utopTerm = vscode.window.createTerminal('OCaml UTop');
            utopTerm.sendText('utop', true);
            utopTerm.show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ocaml.utop_send', async () => {
            if (!utopTerm) return;

            let editor = vscode.window.activeTextEditor;
            if (!editor) return;

            let selection = editor.document.getText(editor.selection);
            utopTerm.sendText(selection);
            utopTerm.show();
        })
    );

    let provideLinter = async (document: vscode.TextDocument, token) => {
        await session.syncBuffer(document.fileName, document.getText(), token);
        if (token.isCancellationRequested) return null;

        let [status, result] = await session.request(['errors']);
        if (token.isCancellationRequested) return null;

        if (status !== 'return') return;

        let diagnostics = [];

        result.map(({type, start, end, message}) => {
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

            if (type === 'type' &&
                message.startsWith('Error: Signature mismatch:') &&
                message.includes(': Actual declaration')) {
                let regex = /^\s*File ("[^"]+"), line (\d+), characters (\d+)-(\d+): Actual declaration$/mg;
                for (let match; (match = regex.exec(message)) !== null;) {
                    let file = JSON.parse(match[1]);
                    let line = JSON.parse(match[2]);
                    let col1 = JSON.parse(match[3]);
                    let col2 = JSON.parse(match[4]);

                    if (Path.basename(file) === Path.basename(document.fileName)) {
                        diagnostics.push(
                            new vscode.Diagnostic(
                                toVsRange({ line, col: col1 }, { line, col: col2 }),
                                message,
                                fromType(type.toLowerCase())
                            )
                        );
                    } else {
                        // Log here?
                    }
                }
                return;
            }

            diagnostics.push(
                new vscode.Diagnostic(
                    toVsRange(start, end),
                    message,
                    fromType(type.toLowerCase())
                )
            );
        });

        return diagnostics;
    };

    let LINTER_DEBOUNCE_TIMER = Symbol();
    let LINTER_TOKEN_SOURCE = Symbol();

    let diagnosticCollection = vscode.languages.createDiagnosticCollection('ocaml');

    let lintDocument = (document: vscode.TextDocument) => {
        if (document.languageId !== 'ocaml') return;

        clearTimeout(document[LINTER_DEBOUNCE_TIMER]);
        document[LINTER_DEBOUNCE_TIMER] = setTimeout(async () => {
            if (document[LINTER_TOKEN_SOURCE]) {
                document[LINTER_TOKEN_SOURCE].cancel();
            }
            document[LINTER_TOKEN_SOURCE] = new vscode.CancellationTokenSource();

            let diagnostics = await provideLinter(document, document[LINTER_TOKEN_SOURCE].token);
            diagnosticCollection.set(document.uri, diagnostics);
        }, configuration.get<number>('lintDelay'));
    };

    vscode.workspace.onDidChangeTextDocument(({document}) => {
        if (document.languageId === 'ocaml') {
            lintDocument(document);
            return;
        }

        let relintOpenedDocuments = () => {
            diagnosticCollection.clear();
            for (let document of vscode.workspace.textDocuments) {
                if (document.languageId === 'ocaml') {
                    lintDocument(document);
                }
            }
        };

        let path = Path.basename(document.fileName);
        if (path === '.merlin') {
            relintOpenedDocuments();
        }
    });
}

export function deactivate() {
}