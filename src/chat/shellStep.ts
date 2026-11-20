/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import type { AgentEvent } from './agentProtocol';
import type { AgentSession, TurnInput } from './agents';
import { scrubEnv } from '../terminal/terminalHost';
import type { StepOutput } from './workflowVars';

/** The most of each stream kept for later steps; the tail is kept, where an error usually is. */
export const shellStreamLimit = 1_000_000;
/** A shell step that runs longer than this is stopped and fails. */
export const shellStepTimeoutMs = 10 * 60_000;
/** After SIGTERM, how long a step has before SIGKILL. */
const killGraceMs = 3_000;

/**
 * One shell step of a workflow, shaped like an agent session so the runner
 * drives it the way it drives an agent's: `send` runs the command, a `tool`
 * row reports it (and through the row, the Bash tab and Activity), and
 * `turnEnd` ends it — with an error when the command exits non-zero.
 *
 * **The command is never filled in.** The text `send` is given is the user's
 * own; every value reaches it through `env` alone (see `workflowVars.ts`).
 *
 * The command runs through the platform's shell in the project folder, with
 * the environment the terminal tabs scrub (`scrubEnv`). It is started in a
 * process group of its own on POSIX, so a stop ends whatever it started too.
 */
export class ShellStepSession implements AgentSession {
	private readonly _events = new vscode.EventEmitter<AgentEvent>();
	readonly onEvent = this._events.event;
	readonly ref = undefined;
	private _child: ChildProcess | undefined;
	private _running = false;
	private _stopped = false;
	private _disposed = false;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _kill: ReturnType<typeof setTimeout> | undefined;
	private _stdout = '';
	private _stderr = '';
	private _exitCode: number | undefined;
	/** The running command's tool row, and why it was ended when it was not the user. */
	private _toolId: string | undefined;
	private _failure: string | undefined;
	private static _next = 0;

	constructor(
		private readonly _cwd: string,
		private readonly _env: Readonly<Record<string, string>>,
		private readonly _label: string,
	) { }

	get running(): boolean {
		return this._running;
	}

	/** What the command left: its streams (tails) and its exit code. */
	get output(): StepOutput {
		return { stdout: this._stdout, stderr: this._stderr, exitCode: this._exitCode };
	}

	async send(input: TurnInput, _model: string, _effort: string | undefined): Promise<boolean> {
		if (this._disposed || this._running || this._child) {
			return false;
		}
		const command = input.text;
		const id = `shell-step-${++ShellStepSession._next}`;
		this._running = true;
		this._toolId = id;
		this._events.fire({ type: 'tool', id, tool: { kind: 'command', name: 'Shell', detail: this._label, input: command } });
		let child: ChildProcess;
		try {
			child = spawn(command, {
				shell: true,
				cwd: this._cwd,
				env: scrubEnv(process.env, { ...this._env }, process.platform),
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			this._finish(id, undefined, `The command could not start: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		this._child = child;
		const take = (which: 'out' | 'err') => (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			if (which === 'out') {
				this._stdout = keepTail(this._stdout + text);
			} else {
				this._stderr = keepTail(this._stderr + text);
			}
			this._events.fire({ type: 'toolUpdate', id, update: { output: text, append: true } });
		};
		child.stdout?.on('data', take('out'));
		child.stderr?.on('data', take('err'));
		let spawnError: string | undefined;
		child.on('error', error => {
			spawnError = error.message;
		});
		this._timer = setTimeout(() => {
			spawnError = this._failure = `The command ran longer than ${Math.round(shellStepTimeoutMs / 60_000)} minutes and was stopped.`;
			this._terminate();
		}, shellStepTimeoutMs);
		child.on('close', (code, signal) => {
			this._exitCode = typeof code === 'number' ? code : undefined;
			const error = this._stopped ? undefined
				: spawnError ?? (code === 0 ? undefined
					: code === null ? `The command was ended by ${signal ?? 'a signal'}.` : `The command exited with code ${code}.`);
			// A timed-out command fails even if the shell had exited 0 before its
			// background child let go of the output.
			this._finish(id, this._stopped ? 'stopped' : this._failure ? 'failed' : code === 0 ? 'done' : 'failed', error);
		});
		return true;
	}

	private _finish(id: string, status: 'done' | 'failed' | 'stopped' | undefined, error: string | undefined): void {
		clearTimeout(this._timer);
		clearTimeout(this._kill);
		this._timer = this._kill = undefined;
		this._child = undefined;
		if (!this._running) {
			return;
		}
		this._running = false;
		if (this._disposed) {
			return;
		}
		this._events.fire({ type: 'toolUpdate', id, update: { status: status ?? 'failed', exitCode: this._exitCode } });
		this._events.fire({ type: 'turnEnd', error: this._stopped ? 'Stopped.' : error, interrupted: this._stopped || undefined });
	}

	private _terminate(): void {
		const child = this._child;
		if (!child) {
			return;
		}
		// The group is signalled even after the shell itself has exited: a
		// command it started in the background (`sleep 600 &`) can still hold
		// the output open, and the step ends only on `close`.
		const signal = (sig: NodeJS.Signals) => {
			try {
				if (process.platform !== 'win32' && child.pid) {
					process.kill(-child.pid, sig);
				} else if (child.exitCode === null) {
					child.kill(sig);
				}
			} catch {
				// Already gone.
			}
		};
		signal('SIGTERM');
		this._kill ??= setTimeout(() => {
			signal('SIGKILL');
			// Whatever still holds the streams (a process that left the group, a
			// Windows grandchild) must not keep the step running: let go of them.
			this._kill = setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				if (this._child === child) {
					this._finish(this._toolId ?? '', this._stopped ? 'stopped' : 'failed', this._failure);
				}
			}, killGraceMs);
		}, killGraceMs);
	}

	stop(): void {
		if (!this._running) {
			return;
		}
		this._stopped = true;
		this._terminate();
	}

	answer(): void {
		// A command asks nothing.
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this.stop();
		this._disposed = true;
		this._events.dispose();
	}
}

function keepTail(text: string): string {
	if (text.length <= shellStreamLimit) {
		return text;
	}
	let start = text.length - shellStreamLimit;
	const code = text.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) {
		start++;
	}
	return text.slice(start);
}
