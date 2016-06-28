'use strict';

import * as child_process from 'child_process';
import {
    DebugSession, Thread, Breakpoint, Source, StackFrame,
    InitializedEvent,
    StoppedEvent,
    TerminatedEvent,
    BreakpointEvent,
    OutputEvent
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as path from 'path';
import * as fs from 'fs';
import {log} from '../utils';

let promisify = require('tiny-promisify');
let freeport = promisify(require('freeport'));

interface LaunchRequestArguments {
    cd: string;
    program: string;
    arguments?: string[];
    stopOnEntry: boolean;
    socket?: string;
}

class OCamlDebugSession extends DebugSession {
    private static BREAKPOINT_ID = Symbol();
    private _launchArgs: LaunchRequestArguments;
    private _debuggeeProc: child_process.ChildProcess;
    private _debuggerProc: child_process.ChildProcess;
    private _wait = Promise.resolve();
    private _remoteMode: boolean = false;
    private _socket: string;
    private _breakpoints: Map<string, Breakpoint[]>;
    private _filenames = [];
    private _filenameToPath = new Map<string, string>();

    constructor() {
        super();
    }

    ocdCommand(cmd, callback, callback2?) {
        if (Array.isArray(cmd)) {
            cmd = cmd.join(' ');
        }

        this._wait = this._wait.then(() => {
            log(`cmd: ${cmd}`);
            this._debuggerProc.stdin.write(cmd + '\n');
            return this.readUntilPrompt(callback2).then((output) => { callback(output) });
        });
    }

    readUntilPrompt(callback?) {
        return new Promise((resolve) => {
            let buffer = '';
            let onData = (chunk) => {
                buffer += chunk.toString('utf-8').replace(/\r\n/g, '\n');
                if (callback) callback(buffer);
                if (buffer.slice(-6) === '(ocd) ') {
                    let output = buffer.slice(0, -6);
                    output = output.replace(/\n$/, '');
                    log(`ocd: ${JSON.stringify(output)}`);
                    resolve(output);
                    this._debuggerProc.stdout.removeListener('data', onData);
                }
            };
            this._debuggerProc.stdout.on('data', onData);
        });
    }

    parseEvent(output) {
        if (output.indexOf('Program exit.') >= 0) {
            this.sendEvent(new TerminatedEvent());
        } else if (output.indexOf('Program end.') >= 0) { 
            let index = output.indexOf('Program end.');
            let reason = output.substring(index + 'Program end.'.length);
            this.sendEvent(new OutputEvent(reason));
            this.sendEvent(new TerminatedEvent());
        } else {
            let reason = output.indexOf('Breakpoint:') >= 0 ? 'breakpoint' : 'step';
            this.sendEvent(new StoppedEvent(reason, 0));
        }
    }

    getModuleFromFilename(filename) {
        return path.basename(filename).split(/\./g)[0].replace(/^[a-z]/, (c) => c.toUpperCase());
    }

    getSource(filename: string) {
        if (this._filenameToPath.has(filename)) {
            return new Source(filename, this._filenameToPath.get(filename));
        }
        let index = this._filenames.indexOf(filename);
        if (index === -1) {
            index = this._filenames.length;
            this._filenames.push(filename);
        }

        let sourcePath = null;        
        let testPath = path.resolve(path.dirname(this._launchArgs.program), filename);
        // TODO: check against list command.
        if (fs.existsSync(testPath)) {
            sourcePath = testPath;
        }
        return new Source(filename, sourcePath, index + 1, 'source');
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body.supportsConfigurationDoneRequest = true;
        // response.body.supportsFunctionBreakpoints = true;
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        if (this._debuggeeProc) {
            this._debuggeeProc.stdout.removeAllListeners();
            this._debuggeeProc.stderr.removeAllListeners();
            this._debuggeeProc.kill();
        }
        
        if (this._debuggerProc) {
            this._debuggerProc.stdin.end('quit\n');
            this._debuggerProc.kill();
        }

        this._remoteMode = false;
        this._socket = null;
        this._debuggeeProc = null;
        this._debuggerProc = null;
        this._breakpoints = null;
        this._filenames = [];
        this._filenameToPath.clear();

        super.disconnectRequest(response, args);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        let ocdArgs = [];
        if (args.cd) {
            ocdArgs.push('-cd', args.cd);
        }

        this._remoteMode = !!args.socket;

        if (this._remoteMode) {
            this._socket = args.socket;
        } else {
            let port = await freeport();
            this._socket = `127.0.0.1:${port}`;
        }

        ocdArgs.push('-s', this._socket);
        // ocdArgs.push('-machine-readable');
        ocdArgs.push(path.normalize(args.program));

        this._launchArgs = args;
        this._debuggerProc = child_process.spawn('ocamldebug', ocdArgs);
        this._breakpoints = new Map();

        this._wait = this.readUntilPrompt().then(() => { });
        this.ocdCommand(['set', 'loadingmode', 'manual'], () => { });
        this.ocdCommand(['goto', 0], () => {
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        }, (buffer: string) => {
            if (!this._debuggeeProc && !this._remoteMode && buffer.includes('Waiting for connection...')) {
                this._debuggeeProc = child_process.spawn(args.program, args.arguments || [], {
                    env: {"CAML_DEBUG_SOCKET": this._socket}
                });
                this._debuggeeProc.stdout.on('data', (chunk) => {
                    this.sendEvent(new OutputEvent(chunk.toString('utf-8'), 'stdout'));
                });
                this._debuggeeProc.stderr.on('data', (chunk) => {
                    this.sendEvent(new OutputEvent(chunk.toString('utf-8'), 'stderr'));
                });
            }
        });
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
            module = this.getModuleFromFilename(this._filenames[args.source.sourceReference - 1]);
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
                        if (!this._filenameToPath.has(filename) && args.source.path && args.source.path.endsWith(filename)) {
                            this._filenameToPath.set(filename, args.source.path);
                        }
                        breakpoint = new Breakpoint(
                            true,
                            +match[3],
                            +match[4],
                            this.getSource(filename)
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
                        this.getSource(match[3]),
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
                let lines = output.split(/\n/g);

                let lastLine = lines[lines.length - 1];
                if (lastLine === 'Position out of range.') {
                    lines.pop();
                }

                let content = lines.map((line) => {
                    // FIXME: make sure do not accidently replace "<|a|>" in a string or comment.
                    return line.replace(/^\d+ /, '').replace(/<\|[a-z]+\|>/, '$1');
                }).join('\n');           

                resolve(content);
            });
        });
    }

    protected async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments) {
        let filename = this._filenames[args.sourceReference - 1];
        let module = this.getModuleFromFilename(filename);
        let content = await this.retrieveSource(module);
        response.body = { content };
        this.sendResponse(response);
    }
}

DebugSession.run(OCamlDebugSession);