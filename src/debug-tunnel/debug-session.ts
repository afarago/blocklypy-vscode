import {
    Breakpoint,
    BreakpointEvent,
    Handles,
    InitializedEvent,
    Logger,
    logger,
    LoggingDebugSession,
    MemoryEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import { basename } from 'path';
import { logDebug } from '../extension';
import { debugTerminal } from '../extension/debug-channel';
import { showWarning } from '../extension/diagnostics';
import { runPhase1Async, runPhase2Async } from '../logic/run';
import { DebugTunnel } from './debug-tunnel';
import {
    FileAccessor,
    IRuntimeBreakpoint,
    IRuntimeVariableType,
    PybricksTunnelDebugRuntime,
    RuntimeVariable,
} from './runtime';

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** enable logging the Debug Adapter Protocol */
    trace?: boolean;
    /** run without debugging */
    noDebug?: boolean;
    /** The slot number to use when uploading the program (HubOS only, 0-19). */
    slot: number | undefined;
    /** Whether the program is already compiled to bytecode. */
    compiled: boolean | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface IAttachRequestArguments extends ILaunchRequestArguments {}

const NONE_VALUE = 'None';

export class PybricksTunnelDebugSession extends LoggingDebugSession {
    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static threadID = 1;

    private _runtime: PybricksTunnelDebugRuntime;

    private _variableHandles = new Handles<'locals' | RuntimeVariable>();

    private _configurationDone = new Subject();

    private _cancellationTokens = new Map<number, boolean>();

    private _reportProgress = false;
    private _progressId = 10000;
    private _cancelledProgressId: string | undefined = undefined;
    private _isProgressCancellable = true;

    private _valuesInHex = false;
    private _useInvalidatedEvent = false;

    private _addressesInHex = true;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor(fileAccessor: FileAccessor) {
        super();

        // this debugger uses one-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        this._runtime = new PybricksTunnelDebugRuntime(fileAccessor);
        // setup event handlers
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(
                new StoppedEvent('entry', PybricksTunnelDebugSession.threadID),
            );
        });
        this._runtime.on('stopOnStep', () => {
            this.sendEvent(
                new StoppedEvent('step', PybricksTunnelDebugSession.threadID),
            );
        });
        this._runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(
                new StoppedEvent('breakpoint', PybricksTunnelDebugSession.threadID),
            );
        });
        // this._runtime.on('stopOnDataBreakpoint', () => {
        //     this.sendEvent(
        //         new StoppedEvent(
        //             'data breakpoint',
        //             PybricksTunnelDebugSession.threadID,
        //         ),
        //     );
        // });
        // this._runtime.on('stopOnInstructionBreakpoint', () => {
        //     this.sendEvent(
        //         new StoppedEvent(
        //             'instruction breakpoint',
        //             PybricksTunnelDebugSession.threadID,
        //         ),
        //     );
        // });
        this._runtime.on('stopOnException', (exception) => {
            if (exception) {
                this.sendEvent(
                    new StoppedEvent(
                        `exception(${exception})`,
                        PybricksTunnelDebugSession.threadID,
                    ),
                );
            } else {
                this.sendEvent(
                    new StoppedEvent('exception', PybricksTunnelDebugSession.threadID),
                );
            }
        });
        this._runtime.on('breakpointValidated', (bp: IRuntimeBreakpoint) => {
            this.sendEvent(
                new BreakpointEvent('changed', {
                    verified: bp.verified,
                    id: bp.id,
                } as DebugProtocol.Breakpoint),
            );
        });
        this._runtime.on(
            'output',
            (
                type: string,
                text: string,
                filePath: string,
                line: number,
                column: number,
                nolinebreak: boolean,
            ) => {
                let category: string;
                switch (type) {
                    case 'prio':
                        category = 'important';
                        break;
                    case 'out':
                        category = 'stdout';
                        break;
                    case 'err':
                        category = 'stderr';
                        break;
                    default:
                        category = 'console';
                        break;
                }
                const e: DebugProtocol.OutputEvent = new OutputEvent(
                    `${text}${nolinebreak ? '' : '\n'}`,
                    category,
                );

                //!!
                // if (text === 'start' || text === 'startCollapsed' || text === 'end') {
                //     e.body.group = text;
                //     e.body.output = `group-${text}\n`;
                // }

                e.body.source = this.createSource(filePath);
                e.body.line = this.convertDebuggerLineToClient(line);
                e.body.column = this.convertDebuggerColumnToClient(column);
                this.sendEvent(e);
            },
        );
        this._runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

    protected override initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments,
    ): void {
        if (!DebugTunnel.canStartSession()) {
            showWarning('Cannot start debug session: No device connected.');
            this.sendEvent(new TerminatedEvent());
            return;
        }

        /// https://microsoft.github.io/debug-adapter-protocol//specification.html

        if (args.supportsProgressReporting) {
            this._reportProgress = true;
        }
        if (args.supportsInvalidatedEvent) {
            this._useInvalidatedEvent = true;
        }

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDone request.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code use 'evaluate' when hovering over source
        // response.body.supportsEvaluateForHovers = true;

        // make VS Code show a 'step back' button
        // response.body.supportsStepBack = true;

        // make VS Code support data breakpoints
        // response.body.supportsDataBreakpoints = true;

        // make VS Code support completion in REPL
        // response.body.supportsCompletionsRequest = true;
        // response.body.completionTriggerCharacters = ['.', '['];

        // make VS Code send cancel request
        // response.body.supportsCancelRequest = true;

        // make VS Code send the breakpointLocations request
        response.body.supportsBreakpointLocationsRequest = true;

        // make VS Code provide "Step in Target" functionality
        // response.body.supportsStepInTargetsRequest = false;

        // the adapter defines two exceptions filters, one with support for conditions.
        // response.body.supportsExceptionFilterOptions = true;
        // response.body.exceptionBreakpointFilters = [];

        // make VS Code send exceptionInfo request
        // response.body.supportsExceptionInfoRequest = true;

        // make VS Code send setVariable request
        response.body.supportsSetVariable = true;

        // make VS Code send setExpression request
        // response.body.supportsSetExpression = true;

        // make VS Code send disassemble request
        // response.body.supportsDisassembleRequest = true;
        // response.body.supportsSteppingGranularity = true;
        // response.body.supportsInstructionBreakpoints = true;

        // make VS Code able to read and write variable memory
        // response.body.supportsReadMemoryRequest = true;
        // response.body.supportsWriteMemoryRequest = true;

        // response.body.supportSuspendDebuggee = true;
        response.body.supportTerminateDebuggee = true;
        // response.body.supportsFunctionBreakpoints = true;
        // response.body.supportsDelayedStackTraceLoading = true;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
        //setState(StateProp.Debugging, true);
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected override configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
    ): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected override disconnectRequest(
        _response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments,
        _request?: DebugProtocol.Request,
    ): void {
        console.log(
            `disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`,
        );
        void DebugTunnel.stopSession();
        //setState(StateProp.Debugging, false);
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    protected override async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: IAttachRequestArguments,
    ) {
        return this.launchRequest(response, args);
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    protected override async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: ILaunchRequestArguments,
    ) {
        try{
            if (!DebugTunnel.canStartSession()) {
                throw new Error('Not able to start debug session.');
            }

            // 0. Initialize
            // make sure to 'Stop' the buffered logging if 'trace' is not set
            logger.setup(
                args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,
                false,
            );

            // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
            // await this._configurationDone.wait(1000);

            // 2. Prepare runtime
            const runOptions = {
                program: args.program,
                noDebug: args.noDebug,
                compiled: args.compiled,
                slot: args.slot,
            };
            const _args1 = await runPhase1Async(runOptions);
            //!!args1.files,

            // 3. start the program in the runtime
            await this._runtime.start(
                runOptions.program,
                !!args.stopOnEntry,
                args.noDebug === false,
            );

            // 4. start the debug session
            await runPhase2Async(runOptions);

            this.sendResponse(response);
        } catch (err) {
            this.sendEvent(
                new OutputEvent(`Error starting debug session: ${String(err)}\n`, 'stderr'),
            );
            response.success = false;
            response.message = "Error compiling or uploading program";
            this.sendResponse(response);
            this.sendEvent(new TerminatedEvent());
            return;
        }

    }

    protected override setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        _args: DebugProtocol.SetFunctionBreakpointsArguments,
        _request?: DebugProtocol.Request,
    ): void {
        this.sendResponse(response);
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    protected override async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ): Promise<void> {
        const path = args.source.path as string;
        const clientLines = args.lines || [];

        // clear all breakpoints for this file
        this._runtime.clearBreakpoints(path);

        // set and verify breakpoint locations
        const actualBreakpoints0 = clientLines.map(async (l) => {
            const { verified, line, id } = await this._runtime.setBreakPoint(
                path,
                this.convertClientLineToDebugger(l),
            );
            const bp = new Breakpoint(
                verified,
                this.convertDebuggerLineToClient(line),
            ) as DebugProtocol.Breakpoint;
            bp.id = id;
            return bp;
        });
        const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(
            actualBreakpoints0,
        );

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: actualBreakpoints,
        };
        this.sendResponse(response);
    }

    protected override breakpointLocationsRequest(
        response: DebugProtocol.BreakpointLocationsResponse,
        args: DebugProtocol.BreakpointLocationsArguments,
        _request?: DebugProtocol.Request,
    ): void {
        if (args.source.path) {
            const bps = this._runtime.getBreakpoints(
                args.source.path,
                this.convertClientLineToDebugger(args.line),
            );
            response.body = {
                breakpoints: bps.map((col) => {
                    return {
                        line: args.line,
                        column: this.convertDebuggerColumnToClient(col),
                    };
                }),
            };
        } else {
            response.body = {
                breakpoints: [],
            };
        }
        this.sendResponse(response);
    }

    // protected override setExceptionBreakPointsRequest(
    //     response: DebugProtocol.SetExceptionBreakpointsResponse,
    //     args: DebugProtocol.SetExceptionBreakpointsArguments,
    // ): void {
    //     let namedException: string | undefined = undefined;
    //     let otherExceptions = false;

    //     if (args.filterOptions) {
    //         for (const filterOption of args.filterOptions) {
    //             switch (filterOption.filterId) {
    //                 case 'namedException':
    //                     namedException = args.filterOptions[0].condition;
    //                     break;
    //                 case 'otherExceptions':
    //                     otherExceptions = true;
    //                     break;
    //             }
    //         }
    //     }

    //     if (args.filters) {
    //         if (args.filters.indexOf('otherExceptions') >= 0) {
    //             otherExceptions = true;
    //         }
    //     }

    //     // this._runtime.setExceptionsFilters(namedException, otherExceptions);

    //     this.sendResponse(response);
    // }

    // protected override exceptionInfoRequest(
    //     response: DebugProtocol.ExceptionInfoResponse,
    //     args: DebugProtocol.ExceptionInfoArguments,
    // ) {
    //     response.body = {
    //         exceptionId: 'Exception ID',
    //         description: 'This is a descriptive description of the exception.',
    //         breakMode: 'always',
    //         details: {
    //             message: 'Message contained in the exception.',
    //             typeName: 'Short type name of the exception object',
    //             stackTrace: 'stack frame 1\nstack frame 2',
    //         },
    //     };
    //     this.sendResponse(response);
    // }

    protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        // runtime supports no threads so just return a default thread.
        response.body = {
            threads: [new Thread(PybricksTunnelDebugSession.threadID, 'thread 1')],
        };
        this.sendResponse(response);
    }

    protected override stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
    ): void {
        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
        const endFrame = startFrame + maxLevels;

        const stk = this._runtime.stack(startFrame, endFrame);

        response.body = {
            stackFrames: stk.frames.map((f, _ix) => {
                const sf: DebugProtocol.StackFrame = new StackFrame(
                    f.index,
                    f.name,
                    this.createSource(f.file),
                    this.convertDebuggerLineToClient(f.line),
                );
                //     if (typeof f.column === 'number') {
                //         sf.column = this.convertDebuggerColumnToClient(f.column);
                //     }
                //     if (typeof f.instruction === 'number') {
                //         const address = this.formatAddress(f.instruction);
                //         sf.name = `${f.name} ${address}`;
                //         sf.instructionPointerReference = address;
                //     }

                return sf;
            }),
            // 4 options for 'totalFrames':
            //omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
            totalFrames: stk.count, // stk.count is the correct size, should result in a max. of two requests
            //totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
            //totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
        };
        this.sendResponse(response);
    }

    protected override scopesRequest(
        response: DebugProtocol.ScopesResponse,
        _args: DebugProtocol.ScopesArguments,
    ): void {
        response.body = {
            scopes: [
                new Scope('Locals', this._variableHandles.create('locals'), false),
                // new Scope('Globals', this._variableHandles.create('globals'), true),
            ],
        };
        this.sendResponse(response);
    }

    // // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/require-await
    // protected override async writeMemoryRequest(
    //     response: DebugProtocol.WriteMemoryResponse,
    //     { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments,
    // ) {
    //     const variable = this._variableHandles.get(Number(memoryReference));
    //     if (typeof variable === 'object') {
    //         const decoded = base64.toByteArray(data);
    //         variable.setMemory(decoded, offset);
    //         response.body = { bytesWritten: decoded.length };
    //     } else {
    //         response.body = { bytesWritten: 0 };
    //     }

    //     this.sendResponse(response);
    //     this.sendEvent(new InvalidatedEvent(['variables']));
    // }

    // // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/require-await
    // protected override async readMemoryRequest(
    //     response: DebugProtocol.ReadMemoryResponse,
    //     { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments,
    // ) {
    //     const variable = this._variableHandles.get(Number(memoryReference));
    //     if (typeof variable === 'object' && variable.memory) {
    //         const memory = variable.memory.subarray(
    //             Math.min(offset, variable.memory.length),
    //             Math.min(offset + count, variable.memory.length),
    //         );

    //         response.body = {
    //             address: offset.toString(),
    //             data: base64.fromByteArray(memory),
    //             unreadableBytes: count - memory.length,
    //         };
    //     } else {
    //         response.body = {
    //             address: offset.toString(),
    //             data: '',
    //             unreadableBytes: count,
    //         };
    //     }

    //     this.sendResponse(response);
    // }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/require-await
    protected override async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
        _request?: DebugProtocol.Request,
    ): Promise<void> {
        let vs: RuntimeVariable[] = [];

        const v = this._variableHandles.get(args.variablesReference);
        if (v === 'locals') {
            vs = this._runtime.getLocalVariables();
        } else if (v && Array.isArray(v.value)) {
            vs = v.value;
        }

        response.body = {
            variables: vs.map((v) => this.convertFromRuntime(v)),
        };
        this.sendResponse(response);
    }

    protected override setVariableRequest(
        response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments,
    ): void {
        const container = this._variableHandles.get(args.variablesReference);
        const rv =
            container === 'locals'
                ? this._runtime.getLocalVariable(args.name)
                : container instanceof RuntimeVariable &&
                  container.value instanceof Array
                ? container.value.find((v) => v.name === args.name)
                : undefined;

        if (rv) {
            logDebug(`Hub setting variable ${args.name} = ${args.value}`);

            rv.value = this.convertToRuntime(args.value);
            response.body = this.convertFromRuntime(rv);

            if (rv.memory && rv.reference) {
                this.sendEvent(
                    new MemoryEvent(String(rv.reference), 0, rv.memory.length),
                );
            }
        }

        this.sendResponse(response);
    }

    protected override evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments,
        //request?: DebugProtocol.Request,
    ) {
        switch (args.context) {
            case 'repl':
                // handle some REPL commands:
                // 'evaluate' supports to create and delete breakpoints from the 'repl':
                debugTerminal?.handleInputFromTerminal(args.expression + '\r\n');
                break;
        }

        this.sendResponse(response);
    }

    protected override continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments,
    ): void {
        void this._runtime.continue();
        this.sendResponse(response);
    }

    protected override nextRequest(
        response: DebugProtocol.NextResponse,
        _args: DebugProtocol.NextArguments,
    ): void {
        void this._runtime.step();
        this.sendResponse(response);
    }

    protected override stepInTargetsRequest(
        response: DebugProtocol.StepInTargetsResponse,
        _args: DebugProtocol.StepInTargetsArguments,
    ) {
        // const targets = this._runtime.getStepInTargets(args.frameId);
        response.body = {
            // targets: targets.map((t) => {
            //     return { id: t.id, label: t.label };
            // }),
            targets: [],
        };
        this.sendResponse(response);
    }

    // protected override dataBreakpointInfoRequest(
    //     response: DebugProtocol.DataBreakpointInfoResponse,
    //     args: DebugProtocol.DataBreakpointInfoArguments,
    // ): void {
    //     response.body = {
    //         dataId: null,
    //         description: 'cannot break on data access',
    //         accessTypes: undefined,
    //         canPersist: false,
    //     };

    //     if (args.variablesReference && args.name) {
    //         const v = this._variableHandles.get(args.variablesReference);
    //         if (v === 'globals') {
    //             response.body.dataId = args.name;
    //             response.body.description = args.name;
    //             response.body.accessTypes = ['write'];
    //             response.body.canPersist = true;
    //         } else {
    //             response.body.dataId = args.name;
    //             response.body.description = args.name;
    //             response.body.accessTypes = ['read', 'write', 'readWrite'];
    //             response.body.canPersist = true;
    //         }
    //     }

    //     this.sendResponse(response);
    // }

    // protected override setDataBreakpointsRequest(
    //     response: DebugProtocol.SetDataBreakpointsResponse,
    //     args: DebugProtocol.SetDataBreakpointsArguments,
    // ): void {
    //     // clear all data breakpoints
    //     this._runtime.clearAllDataBreakpoints();

    //     response.body = {
    //         breakpoints: [],
    //     };

    //     for (const dbp of args.breakpoints) {
    //         const ok = this._runtime.setDataBreakpoint(
    //             dbp.dataId,
    //             dbp.accessType || 'write',
    //         );
    //         response.body.breakpoints.push({
    //             verified: ok,
    //         });
    //     }

    //     this.sendResponse(response);
    // }

    protected override cancelRequest(
        _response: DebugProtocol.CancelResponse,
        args: DebugProtocol.CancelArguments,
    ) {
        if (args.requestId) {
            this._cancellationTokens.set(args.requestId, true);
        }
        if (args.progressId) {
            this._cancelledProgressId = args.progressId;
        }
    }

    // protected override customRequest(
    //     command: string,
    //     response: DebugProtocol.Response,
    //     args: unknown,
    // ) {
    //     if (command === 'toggleFormatting') {
    //         this._valuesInHex = !this._valuesInHex;
    //         if (this._useInvalidatedEvent) {
    //             this.sendEvent(new InvalidatedEvent(['variables']));
    //         }
    //         this.sendResponse(response);
    //     } else {
    //         super.customRequest(command, response, args);
    //     }
    // }

    //---- helpers

    private convertToRuntime(value: string): IRuntimeVariableType {
        if (value === NONE_VALUE || value.length === 0) {
            return null;
        }
        value = value.trim();
        if (value === 'True') {
            return true;
        }
        if (value === 'False') {
            return false;
        }
        if (value[0] === "'" || value[0] === '"') {
            return value.substr(1, value.length - 2);
        }
        const n = parseFloat(value);
        if (!isNaN(n)) {
            return n;
        }
        return value;
    }

    private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {
        let dapVariable: DebugProtocol.Variable = {
            name: v.name,
            value: '????',
            // type: typeof v.value, // python - does not support - supportsVariableType
            variablesReference: 0,
            evaluateName: '$' + v.name,
        };

        // if (v.name.indexOf('lazy') >= 0) {
        //     // a "lazy" variable needs an additional click to retrieve its value

        //     dapVariable.value = 'lazy var'; // placeholder value
        //     v.reference ??= this._variableHandles.create(
        //         new RuntimeVariable('', [new RuntimeVariable('', v.value)]),
        //     );
        //     dapVariable.variablesReference = v.reference;
        //     dapVariable.presentationHint = { lazy: true };
        // } else {
        if (Array.isArray(v.value)) {
            dapVariable.value = 'Object';
            v.reference ??= this._variableHandles.create(v);
            dapVariable.variablesReference = v.reference;
        } else {
            switch (typeof v.value) {
                case 'number':
                    if (Math.round(v.value) === v.value) {
                        dapVariable.value = this.formatNumber(v.value);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
                        (dapVariable as any).__vscodeVariableMenuContext = 'simple'; // enable context menu contribution
                        dapVariable.type = 'integer';
                    } else {
                        dapVariable.value = v.value.toString();
                        dapVariable.type = 'float';
                    }
                    break;
                case 'string':
                    dapVariable.value = `"${v.value}"`;
                    break;
                case 'boolean':
                    dapVariable.value = v.value ? 'True' : 'False';
                    break;
                default:
                    dapVariable.value = NONE_VALUE;
                    dapVariable.type = NONE_VALUE;
                    break;
            }
        }
        // }

        // if (v.memory) {
        //     v.reference ??= this._variableHandles.create(v);
        //     dapVariable.memoryReference = String(v.reference);
        // }

        return dapVariable;
    }

    private formatNumber(x: number) {
        return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
    }

    private createSource(filePath: string): Source {
        return new Source(
            basename(filePath),
            this.convertDebuggerPathToClient(filePath),
            undefined,
            undefined,
            'pybricks-tunnel-adapter-data',
        );
    }
}
