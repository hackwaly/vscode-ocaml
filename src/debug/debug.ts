'use strict';

import * as child_process from 'child_process';
import {
    DebugSession, Thread, Breakpoint, Source, StackFrame, Variable, Handles,
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
let evalResultParser = require('./eval_result_parser.js');

let promisify = require('tiny-promisify');
let freeport = promisify(require('freeport'));
let iconv = require('iconv-lite');

let DECODED_STDOUT = Symbol();
let DECODED_STDERR = Symbol();

interface LaunchRequestArguments {
    cd: string;
    includePath?: string[]; 
    program: string;
    arguments?: string[];
    stopOnEntry: boolean;
    socket?: string;
    symbols?: string;
    script?: string;
    encoding?: string;
    ocamldebugEncoding?: string;
    _showLogs?: boolean;
}

export interface VariableContainer {
    expand(session: OCamlDebugSession): Promise<Variable[]>;
    setValue(session: OCamlDebugSession, name: string, value: string): Promise<string>;
}

export class Expander implements VariableContainer {

    private _expanderFunction: () => Promise<Variable[]>;

    constructor(func: () => Promise<Variable[]>) {
        this._expanderFunction = func;
    }

    async expand(session: OCamlDebugSession): Promise<Variable[]> {
        return this._expanderFunction();
    }

    async setValue(session: OCamlDebugSession, name: string, value: string): Promise<string> {
        throw new Error("Setting value not supported");
    }
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
    private _functionBreakpoints: Breakpoint[];
    private _variableHandles: Handles<VariableContainer>;
    private _filenames = [];
    private _filenameToPath = new Map<string, string>();

    constructor() {
        super();
    }

    log(msg: string) {
        log(msg);
        if (this._launchArgs._showLogs) {
            this.sendEvent(new OutputEvent(`${msg}\n`));
        }
    }

    ocdCommand(cmd, callback, callback2?) {
        if (Array.isArray(cmd)) {
            cmd = cmd.join(' ');
        }

        this._wait = this._wait.then(() => {
            this.log(`cmd: ${cmd}`);
            this._debuggerProc.stdin.write(cmd + '\n');
            return this.readUntilPrompt(callback2).then((output) => { callback(output) });
        });
    }

    readUntilPrompt(callback?) {
        return new Promise((resolve) => {
            let buffer = '';
            let onStdoutData = (chunk) => {
                buffer += chunk.replace(/\r\n/g, '\n');
                if (callback) callback(buffer);
                if (buffer.slice(-6) === '(ocd) ') {
                    let output = buffer.slice(0, -6);
                    output = output.replace(/\n$/, '');
                    this.log(`ocd: ${JSON.stringify(output)}`);
                    resolve(output);
                    this._debuggerProc[DECODED_STDOUT].removeListener('data', onStdoutData);
                    this._debuggerProc[DECODED_STDERR].removeListener('data', onStderrData);
                }
            };
            let onStderrData = (chunk) => {
                // TODO: Find better way to handle this.
                // Ignore non-error message from stderr: 'done.\n'.
                if (chunk === 'done.\n') return;
                this.sendEvent(new OutputEvent(chunk));
            }
            this._debuggerProc[DECODED_STDOUT].on('data', onStdoutData);
            this._debuggerProc[DECODED_STDERR].on('data', onStderrData);
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
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = true;
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
        this._functionBreakpoints = null;
        this._variableHandles.reset();
        this._filenames = [];
        this._filenameToPath.clear();

        super.disconnectRequest(response, args);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        let ocdArgs = [];
        if (args.cd) {
            ocdArgs.push('-cd', args.cd);
        }

        if (args.includePath) {
            args.includePath.forEach((path) => {
                ocdArgs.push('-I', path);
            });
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

        ocdArgs.push(path.normalize(args.symbols || args.program));

        this._launchArgs = args;

        let checkEncoding = (name: string, encoding: string) => {
            if (encoding) {
                if (iconv.encodingExists(encoding)) {
                    return encoding;
                }
                this.sendEvent(new OutputEvent(`Encoding "${encoding}" specified by option "${name}" isn't supported. Fallback to "utf-8" encoding.\n`));
            }
            return 'utf-8';
        };

        let debuggerEncoding = checkEncoding('ocamldebugEncoding', args.ocamldebugEncoding);
        let debuggeeEncoding = checkEncoding('encoding', args.encoding);

        this._debuggerProc = child_process.spawn('ocamldebug', ocdArgs);
        this._debuggerProc[DECODED_STDOUT] = iconv.decodeStream(debuggerEncoding);
        this._debuggerProc.stdout.pipe(this._debuggerProc[DECODED_STDOUT]);
        this._debuggerProc[DECODED_STDERR] = iconv.decodeStream(debuggerEncoding);
        this._debuggerProc.stderr.pipe(this._debuggerProc[DECODED_STDERR]);

        this._breakpoints = new Map();
        this._functionBreakpoints = [];
        this._variableHandles = new Handles<VariableContainer>();

        this._wait = this.readUntilPrompt().then(() => { });
        this.ocdCommand(['set', 'loadingmode', 'manual'], () => { });

        let once = false;
        let onceSocketListened = (message: string) => {
            if (once) return;
            once = true;

            if (this._remoteMode) {
                this.sendEvent(new OutputEvent(message));
            } else {
                this._debuggeeProc = child_process.spawn(args.program, args.arguments || [], {
                    env: { "CAML_DEBUG_SOCKET": this._socket },
                    cwd: args.cd || path.dirname(args.program)
                });

                this._debuggeeProc[DECODED_STDOUT] = iconv.decodeStream(debuggeeEncoding);
                this._debuggeeProc.stdout.pipe(this._debuggeeProc[DECODED_STDOUT]);
                this._debuggeeProc[DECODED_STDOUT].on('data', (chunk) => {
                    this.sendEvent(new OutputEvent(chunk, 'stdout'));
                });

                this._debuggeeProc[DECODED_STDERR] = iconv.decodeStream(debuggeeEncoding);
                this._debuggeeProc.stderr.pipe(this._debuggeeProc[DECODED_STDERR]);
                this._debuggeeProc[DECODED_STDERR].on('data', (chunk) => {
                    this.sendEvent(new OutputEvent(chunk, 'stderr'));
                });
            }
        };

        this.ocdCommand(['goto', 0], () => {
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        }, (buffer: string) => {
            if (buffer.includes('Waiting for connection...')) {
                let message = /Waiting for connection\.\.\..*$/m.exec(buffer)[0];
                onceSocketListened(message);
            }
        });
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) {
        if (this._launchArgs.script) {
            let output = await new Promise((resolve) => {
                this.ocdCommand(['source', `"${this._launchArgs.script}"`], resolve);
            });
            if (output) {
                this.sendEvent(new OutputEvent(output as string));
            }
        }

        if (this._launchArgs.stopOnEntry) {
            this.ocdCommand(['goto', 0], this.parseEvent.bind(this));
        } else {
            this.ocdCommand(['run'], this.parseEvent.bind(this));
        }

        this.sendResponse(response);
    }

    private doSetBreakpoint(param: string, source?: DebugProtocol.Source) {
        return new Promise((resolve) => {
            this.ocdCommand(['break', param], (output) => {
                let match = /^Breakpoint (\d+) at \d+: file ([^,]+), line (\d+), characters (\d+)-(\d+)$/m.exec(output);
                let breakpoint = null;
                if (match) {
                    let filename = match[2];
                    // Ugly hack.
                    if (source && !this._filenameToPath.has(filename) && source.path && source.path.endsWith(filename)) {
                        this._filenameToPath.set(filename, source.path);
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
    }

    private doDeleteBreakpoint(id: number) {
        return new Promise((resolve, reject) => {
            this.ocdCommand(['delete', id], () => {
                resolve();
            });
        });
    }

    private async clearBreakpoints(breakpoints: Breakpoint[]) {
        for (let breakpoint of breakpoints) {
            if (breakpoint.verified) {
                let breakpointId = breakpoint[OCamlDebugSession.BREAKPOINT_ID];
                await this.doDeleteBreakpoint(breakpointId);
            }
        }
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
        let breakpoints = [];
        let module;

        if (args.source.sourceReference > 0) {
            module = this.getModuleFromFilename(this._filenames[args.source.sourceReference - 1]);
        } else if (args.source.path) {
            module = this.getModuleFromFilename(args.source.path);
        }

        let prevBreakpoints = this._breakpoints.get(module) || [];
        await this.clearBreakpoints(prevBreakpoints);

        for (let {line, column} of args.breakpoints) {
            let breakpoint = await this.doSetBreakpoint('@ ' + [module, line, column].join(' '), args.source);
            breakpoints.push(breakpoint);
        }

        this._breakpoints.set(module, breakpoints);

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments) {
        let breakpoints = [];

        let prevBreakpoints = this._functionBreakpoints;
        await this.clearBreakpoints(prevBreakpoints);

        for (let {name} of args.breakpoints) {
            let breakpoint = await this.doSetBreakpoint(name);
            breakpoints.push(breakpoint);
        }

        this._functionBreakpoints = breakpoints;

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

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
        this.ocdCommand('backstep', this.parseEvent.bind(this));
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse) {
        response.body = { threads: [new Thread(0, 'main')] };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
        this.ocdCommand(['backtrace', 100], (text: string) => {
            let stackFrames = [];

            let lines = text.trim().split(/\n/g);
            if (lines[0] === 'Backtrace:') {
                lines = lines.slice(1);
            }
            if (lines[lines.length - 1].includes('(Encountered a function with no debugging information)')) {
                lines.pop();
            }

            lines.forEach((line) => {
                let match = /^#(\d+) ([^ ]+) ([^:]+):([^:]+):([^:]+)$/.exec(line);
                if (match) {
                    stackFrames.push(new StackFrame(
                        +match[1],
                        '',
                        this.getSource(match[3]),
                        +match[4],
                        +match[5]
                    ));
                }
            });

            response.body = { stackFrames };
            this.sendResponse(response);
        });
    }

    private parseEvalResult(text: string): Variable {
        let repr = (value: any) => {
            switch (value.kind) {
                case 'plain':
                    return value.value;
                case 'con':
                    return `${value.con} ${repr(value.args)}`;
                case 'tuple':
                    return `(${value.items.map(repr).join(', ')})`;
                case 'array':
                    return `<array>`;
                case 'list':
                    return `<list>`;
                case 'record':
                    return `<record>`;
            }
        };

        let expander = (value) => {
            return async () => {
                switch (value.kind) {
                    case 'con':
                        return [createVariable('%arguments', value.args)];
                    case 'tuple':
                        return value.items.map((item, index) => createVariable(`%${index+1}`, item));
                    case 'array':
                    case 'list':
                        return value.items.map((item, index) => createVariable(`${index}`, item));
                    case 'record':
                        return value.items.map(({name, value}) => createVariable(name, value));
                }
            };
        };

        let createVariable = (name: string, value: any): Variable => {
            let text = repr(value);
            let numIndexed;
            let numNamed;
            
            switch (value.kind) {
                case 'plain':
                    return new Variable(name, text);
                case 'con':
                    numNamed = 1;
                    numIndexed = 0;
                    break;
                case 'record':
                case 'tuple':
                    numNamed = value.items.length;
                    numIndexed = 0;
                    break;
                case 'list':
                case 'array':
                    numIndexed = value.items.length;
                    numNamed = 0;
                    break;
            }

            return new Variable(name, text,
                this._variableHandles.create(new Expander(expander(value))),
                numIndexed, numNamed
            );
        };

        try {
            let data = evalResultParser.parse(text);
            let variable = createVariable(data.name, data.value);
            (variable as DebugProtocol.Variable).type = data.type;
            return variable;
        } catch (ex) {
            let start = ex.location.start.offset;
            let end = Math.max(ex.location.end.offset, Math.min(start + 16, text.length));
            let peek = text.substring(start, end);
            this.log(`Error (${ex}) occurs while parsing at "${peek}...".`);
            return null;
        }
    }

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		let reference = args.variablesReference;
        let variablesContainer = this._variableHandles.get(reference);
        let variables = [];

        if (variablesContainer) {
            try {
                variables = await variablesContainer.expand(this);
            } catch (ex) { }
        }
        
        let filteredVariables = variables;
        if (args.filter === 'named') {
            filteredVariables = variables.filter((variable) => !/^[0-9]+$/.test(variable.name));
        } else if (args.filter === 'indexed') {
            filteredVariables = variables.filter((variable) => {
                if (/^[0-9]+$/.test(variable.name)) {
                    if (!args.count) {
                        return true;
                    }
                    let index = parseInt(variable.name);
                    let start = args.start || 0;
                    return index >= start && index < start + args.count;
                }
                return false;
            });
        }

        response.body = { variables: filteredVariables };
		this.sendResponse(response);
	}

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
        this.ocdCommand(['frame', args.frameId], () => {
            this.ocdCommand(['print', `(${args.expression})`], (result) => {
                let variable = this.parseEvalResult(result);
                if (variable) {
                    response.body = {
                        result: variable.value,
                        variablesReference: variable.variablesReference,
                        type: (variable as DebugProtocol.Variable).type,
                        indexedVariables: (variable as DebugProtocol.Variable).indexedVariables,
                        namedVariables: (variable as DebugProtocol.Variable).namedVariables,
                    };
                    this.sendResponse(response);
                } else {
                    this.sendResponse(response);
                }
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
                    return line.replace(/^\d+ /, '').replace(/<\|[ab]\|>/, '$1');
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