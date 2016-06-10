'use strict';

import * as child_process from 'child_process';
import {
    DebugSession, Thread, Breakpoint, Source, StackFrame,
    InitializedEvent,
    StoppedEvent,
    TerminatedEvent,
    BreakpointEvent,
    OutputEvent,
    Handles
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as path from 'path';
import * as stream from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import {log} from '../utils';

let uuid = require('uuid');

interface LaunchRequestArguments {
    cd: string;
    program: string;
    arguments: string;
    stopOnEntry: boolean;
}

class SourceSource {
    constructor(public module: string, public content?: string) { }
}

class OCamlDebugSession extends DebugSession {
    private static BREAKPOINT_ID = Symbol();
    private _launchArgs: LaunchRequestArguments;
    private _ocdProc: child_process.ChildProcess;
    private _wait = Promise.resolve();
    private _progStdoutPipeName: string;
    private _progStderrPipeName: string;
    private _progStdout: stream.Readable;
    private _progStderr: stream.Readable;
    private _breakpoints: Map<string, Breakpoint[]>;
    private _modules = [];
    private _moduleToPath = new Map<string, string>();

    constructor() {
        super();
    }

    ocdCommand(cmd, callback) {
        if (Array.isArray(cmd)) {
            cmd = cmd.join(' ');
        }

        this._wait = this._wait.then(() => {
            log(`cmd: ${cmd}`);
            this._ocdProc.stdin.write(cmd + '\n');
            return this.readUntilPrompt().then((output) => { callback(output) });
        });
    }

    readUntilPrompt() {
        return new Promise((resolve) => {
            let buffer = '';
            let onData = (chunk) => {
                buffer += chunk.toString('utf-8');
                if (buffer.slice(-6) === '(ocd) ') {
                    let output = buffer.slice(0, -6);
                    output = output.replace(/\n$/, '');
                    log(`ocd: ${JSON.stringify(output)}`);
                    resolve(output);
                    this._ocdProc.stdout.removeListener('data', onData);
                    return;
                }
            };
            this._ocdProc.stdout.on('data', onData);
        });
    }

    parseEvent(output) {
        if (output.indexOf('Program exit.') >= 0) {
            this.sendEvent(new TerminatedEvent());
        } else {
            let reason = output.indexOf('Breakpoint:') >= 0 ? 'breakpoint' : 'step';
            this.sendEvent(new StoppedEvent(reason, 0));
        }
    }

    getModuleFromFilename(filename) {
        return path.basename(filename, '.ml').replace(/^[a-z]/, (c) => c.toUpperCase());
    }

    getSource(module: string) {
        let filename = module.toLowerCase() + '.ml';
        if (this._moduleToPath.has(module)) {
            return new Source(filename, this._moduleToPath.get(module));
        }
        let index = this._modules.indexOf(module);
        if (index === -1) {
            index = this._modules.length;
            this._modules.push(module);
        }
        return new Source(filename, null, index + 1, 'source');
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        if (os.platform() === 'win32') {
            // We use `mkfifo` to redirect stdout and stderr of program to client.
            this.sendErrorResponse(response, 1, 'Currently OCaml debugger do not support windows os.');
            return;
        }
        response.body.supportsConfigurationDoneRequest = true;
        // response.body.supportsFunctionBreakpoints = true;
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        if (this._ocdProc) {
            this._ocdProc.kill();
        }

        if (this._progStdout) {
            this._progStdout.removeAllListeners();
            if (this._progStdout['destroy']) {
                this._progStdout['destroy']();
            }
        }

        if (this._progStderr) {
            this._progStderr.removeAllListeners();
            if (this._progStderr['destroy']) {
                this._progStderr['destroy']();
            }
        }

        if (this._progStdoutPipeName) {
            child_process.exec(`rm ${this._progStdoutPipeName}`);
        }
        if (this._progStderrPipeName) {
            child_process.exec(`rm ${this._progStderrPipeName}`);
        }

        this._ocdProc = null;
        this._breakpoints = null;
        this._modules = [];
        this._moduleToPath.clear();

        this._progStdoutPipeName = null;
        this._progStderrPipeName = null;
        this._progStdout = null;
        this._progStderr = null;

        super.disconnectRequest(response, args);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        let ocdArgs = [];
        if (args.cd) {
            ocdArgs.push('cd', args.cd);
        }

        ocdArgs.push(args.program);
        if (args.arguments) {
            ocdArgs.push(arguments);
        }
        this._launchArgs = args;
        this._progStdoutPipeName = path.resolve(os.tmpdir(), uuid());
        this._progStderrPipeName = path.resolve(os.tmpdir(), uuid());

        await new Promise((resolve, reject) => {
            child_process.exec(`mkfifo ${this._progStdoutPipeName}`, (err, output) => {
                if (err) return reject(err);
                resolve();
            });
        });

        await new Promise((resolve, reject) => {
            child_process.exec(`mkfifo ${this._progStderrPipeName}`, (err, output) => {
                if (err) return reject(err);
                resolve();
            });
        });

        this._progStdout = fs.createReadStream(this._progStdoutPipeName);
        this._progStdout.on('data', (chunk) => {
            this.sendEvent(new OutputEvent(chunk.toString('utf-8'), 'stdout'));
        });

        this._progStderr = fs.createReadStream(this._progStderrPipeName);
        this._progStderr.on('data', (chunk) => {
            this.sendEvent(new OutputEvent(chunk.toString('utf-8'), 'stderr'));
        });

        this._ocdProc = child_process.spawn('ocamldebug', ocdArgs);
        this._breakpoints = new Map();

        this.ocdCommand([
            'set', 'arguments', `> ${this._progStdoutPipeName}`, `2> ${this._progStderrPipeName}`
        ], () => { });
        this.ocdCommand(['goto', 0], () => { });

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        if (this._launchArgs.stopOnEntry) {
            this.ocdCommand(['goto', 0], this.parseEvent.bind(this));
        } else {
            this.ocdCommand(['run'], this.parseEvent.bind(this));
        }

        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
        let breakpoints = [];
        let module;

        if (args.source.sourceReference > 0) {
            module = this._modules[args.source.sourceReference - 1];
        } else if (args.source.path) {
            module = this.getModuleFromFilename(args.source.path);
        }

        let doSetBreakpoint = async (line, column) => {
            return new Promise((resolve) => {
                this.ocdCommand(['break', '@', module, line, column], (output) => {
                    let match = /^Breakpoint (\d+) at \d+: file ([^,]+), line (\d+), characters (\d+)-(\d+)$/m.exec(output);
                    let breakpoint = null;
                    if (match) {
                        let filename = match[2];
                        if (!this._moduleToPath.has(module) && args.source.path && args.source.path.endsWith(filename)) {
                            this._moduleToPath.set(module, args.source.path);
                        }
                        breakpoint = new Breakpoint(
                            true,
                            +match[3],
                            +match[4],
                            this.getSource(this.getModuleFromFilename(filename))
                        );
                        breakpoint[OCamlDebugSession.BREAKPOINT_ID] = +match[1];
                    } else {
                        breakpoint = new Breakpoint(false);
                    }
                    resolve(breakpoint);
                });
            });
        };

        let doDeleteBreakpoint = async (id) => {
            return new Promise((resolve, reject) => {
                this.ocdCommand(['delete', id], () => {
                    resolve();
                });
            });
        };

        let prevBreakpoints = this._breakpoints.get(module) || [];
        for (let bp of prevBreakpoints) {
            await doDeleteBreakpoint(bp[OCamlDebugSession.BREAKPOINT_ID]);
        }

        for (let {line, column} of args.breakpoints) {
            let breakpoint = await doSetBreakpoint(line, column);
            breakpoints.push(breakpoint);
        }

        this._breakpoints.set(module, breakpoints);

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
        this.ocdCommand('run', this.parseEvent.bind(this));
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
        this.ocdCommand('next', this.parseEvent.bind(this));
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.ocdCommand(['step', 1], this.parseEvent.bind(this));
        this.sendResponse(response);
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.ocdCommand('finish', this.parseEvent.bind(this));
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse) {
        response.body = { threads: [new Thread(0, 'main')] };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
        this.ocdCommand(['backtrace', 100], (text) => {
            let stackFrames = [];

            let lines = text.trim().split(/\n/g);
            if (lines[0] === 'Backtrace:') {
                stackFrames = lines.slice(1).map((line) => {
                    let match = /^#(\d+) ([^ ]+) ([^:]+):([^:]+):([^:]+)$/.exec(line);
                    return new StackFrame(
                        +match[1],
                        '',
                        this.getSource(match[2]),
                        +match[4],
                        +match[5]
                    );
                });
            }

            response.body = { stackFrames };
            this.sendResponse(response);
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
        this.ocdCommand(['frame', args.frameId], () => {
            this.ocdCommand(['print', `(${args.expression})`], (result) => {
                response.body = { result, variablesReference: 0 };
                this.sendResponse(response);
            });
        });
    }

    retrieveSource(module) {
        return new Promise<string>((resolve) => {
            this.ocdCommand(['list', module, 1, 100000], (output: string) => {
                let lines = output.replace(/^(\s*)<\|[a-z]+\|>/mg, '$1').split(/\n/g);
                let num_prefix = lines.length.toString().length;
                let content = lines.map((line) => line.substring(num_prefix)).join('\n');
                resolve(content);
            });
        });
    }

    protected async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments) {
        let module = this._modules[args.sourceReference - 1];
        let content = await this.retrieveSource(module);
        response.body = { content };
        this.sendResponse(response);
    }
}

DebugSession.run(OCamlDebugSession);