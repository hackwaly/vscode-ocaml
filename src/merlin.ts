'use strict';

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as readline from 'readline';

export class OCamlMerlinSession {
    private _cp: child_process.ChildProcess;
    private _rl: readline.ReadLine;
    private _wait = Promise.resolve();

    constructor() {
        let merlinPath = vscode.workspace.getConfiguration('ocaml').get<string>('merlinPath');
        this._cp = child_process.spawn(merlinPath, []);
        this._cp.on('exit', (code, signal) => {
            console.log(`OCamlmerlin exited with code ${code}, signal ${signal}`);
        });
        this._rl = readline.createInterface({
            input: this._cp.stdout,
            output: this._cp.stdin,
            terminal: false
        });
    }
    
    request(data: any): any {
        let promise = this._wait.then(() => {
            return new Promise((resolve, reject) => {
                this._rl.question(JSON.stringify(data) + '\n', (answer) => {
                    let result = JSON.parse(answer);
                    let [kind, payload] = result;
                    if (kind === 'return') {
                        resolve(payload);
                    } else {
                        console.error(result);
                        reject(result);
                    }
                });
            });
        });
        this._wait = promise.then(() => {});
        return promise;
    }
    
    dispose() {
        this._rl.close();
        this._cp.kill();
    }
}
