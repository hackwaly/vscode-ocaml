import * as vscode from 'vscode';
import * as child_process from 'child_process';
const compareVersions = require('compare-versions');

let configuration = vscode.workspace.getConfiguration("ocaml");

let opamVersion = new Promise(async (resolve, reject) => {
    let opamPath = configuration.get<string>('opamPath');
    child_process.exec('opam --version', (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
    });
});

export async function wrapOpamExec(cmd) {
    let useOpamToResolve = configuration.get<boolean>('useOpamToResolve');
    if (useOpamToResolve) {
        let opamPath = configuration.get<string>('opamPath');
        let version = await opamVersion;
        if (compareVersions(version, '2.0.0') < 0) {
            cmd = [opamPath, 'config', 'exec', '--', ...cmd];
        } else {
            cmd = [opamPath, 'exec', '--', ...cmd];
        }
    }
    return cmd;
}

export async function opamSpawn(cmd, opts = {}) {
    cmd = await wrapOpamExec(cmd);
    return child_process.spawn(cmd[0], cmd.slice(1), opts);
}
