'use strict';

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as readline from 'readline';
import {log} from './utils';

const noop = () => {};

export class OCamlMerlinSession {
    private _cp: child_process.ChildProcess;
    private _rl: readline.ReadLine;
    private _wait = Promise.resolve();
    private _rejectWait = noop;
    private _protocolVersion: number = 1;

    constructor() {
        this.restart();
    }

    restart() {
        this._rejectWait();
        this._wait = Promise.resolve();
        if (this._rl) {
            this._rl.close();
            this._rl = null;
        }
        if (this._cp) {
            this._cp.kill();
            this._cp = null;
        }

        let merlinPath = vscode.workspace.getConfiguration('ocaml').get<string>('merlinPath');

        this._cp = child_process.spawn(merlinPath, []);
        this._cp.on('exit', (code, signal) => {
            log(`OCamlmerlin exited with code ${code}, signal ${signal}`);
        });
        this._cp.stdout.setEncoding("ascii");
        this._cp.stdin['setDefaultEncoding']("ascii");

        this._rl = readline.createInterface({
            input: this._cp.stdout,
            output: this._cp.stdin,
            terminal: false
        });

        this._wait = this.request(['protocol', 'version', 2]).then(([status, result]) => {
            if (status === 'return' && result.selected === 2) {
                this._protocolVersion = 2;
            }
        });
    }

    request(data: any): any {
        let promise = this._wait.then(() => {
            return new Promise((resolve, reject) => {
                let cmd = JSON.stringify(data);
                cmd = cmd.replace(/[\u0100-\uffff]/g, 
                    c => '\\u' + ('0000'+c.charCodeAt(0).toString(16)).slice(-4));
                log(`command to merlin: ${cmd}`);
                this._rl.question(cmd + '\n', (answer) => {
                    log(`response from merlin: ${answer}`);
                    resolve(JSON.parse(answer));
                });
                this._rejectWait = reject;
            });
        });
        this._wait = promise.then(() => { 
            this._rejectWait = noop;
        }, (err) => {
            console.error(err);
            this._rejectWait = noop;
        });
        return promise;
    }

    async syncBuffer(file, content, token) {
        await this.request(['checkout', 'auto', file]);
        if (token.isCancellationRequested) return null;

        if (this._protocolVersion === 2) {
            await this.request(['tell', 'start', 'end', content]);
        } else {
            await this.request(['seek', 'exact', { line: 1, col: 0 }]);
            if (token.isCancellationRequested) return null;

            await this.request(['tell', 'source-eof', content]);
        }
    }

    dispose() {
        this._rl.close();
        this._cp.kill();
    }
}
