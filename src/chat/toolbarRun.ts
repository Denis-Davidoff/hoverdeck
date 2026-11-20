/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { confirm } from '../core/notify';
import type { AgentBackend, AgentSession } from './agents';
import type { ApprovalRequest } from './agentProtocol';
import type { AgentId, ApprovalMode, ToolbarRun, ToolbarSkill, ToolEntry } from './chatProtocol';
import { approvalKey } from './chatTab';
import { capAt } from '../core/notifyText';
import { chosenOption, extractResult, stepGate, withChoices, withNextDecision, withResultMarkers, type FilledStep } from './toolbarText';
import type { ToolUpdate } from './agentProtocol';
import { ShellStepSession } from './shellStep';
import { SkillAgents } from './skillAgents';
import { fillVars, shellEnv, type StepRecord } from './workflowVars';
import { executionBound, nextStep, routeCanEnd, RouteCounters, successLeads, type RouteTarget, type RoutedStep, type StepOutcome } from './workflowGraph';

/** What a run needs from the view that started it. */
export interface ToolbarRunHost {
	/** The approval menu's mode for a category key; see `approvalKey`. */
	approvalMode(key: string): ApprovalMode;
	noteServer(server: string): void;
	/** Something a button shows changed. */
	changed(): void;
	/**
	 * A run ended on its own — done, failed, or stopped by its check — and not by
	 * the user's Stop or the view closing: the host tells it as the skill asks
	 * (`ToolbarSkill.notify`, a `toast` result).
	 */
	ended(skill: ToolbarSkill, end: SkillEnd): void;
}

/** How a run ended, for its notification. */
export interface SkillEnd {
	readonly status: 'done' | 'failed';
	/** What the button says: "Copied to the clipboard.", an error, why the skill stopped. */
	readonly message?: string;
	/** The marked result of a clipboard or notification run. */
	readonly result?: string;
	/** The parameters it was run with, for the notification's placeholders. */
	readonly values: Readonly<Record<string, string>>;
}

interface Running {
	skillId: string;
	/** The skill as it was when pressed, and the values it was run with: what its notification is made of. */
	skill: ToolbarSkill;
	values: Readonly<Record<string, string>>;
	/** The agent whose backend holds the session: a Refresh replacing it ends the run. */
	agent: AgentId;
	run: ToolbarRun;
	session?: AgentSession;
	/**
	 * The questions the run is stopped on, oldest first; the button shows the
	 * first. A list, not one slot: a turn that runs tools side by side — parallel
	 * sub-agents, each with a command — asks several at once, and a second
	 * question that replaced the first left that one unanswerable while the CLI
	 * still waited on it, the button reading "running" for good.
	 */
	asked: ApprovalRequest[];
	clear?: ReturnType<typeof setTimeout>;
	stepTimer?: ReturnType<typeof setTimeout>;
	/** The chat it was pressed in, whose agents list shows it. */
	chatId: string;
	/** Its row in that list. */
	row: ToolEntry;
	/** The reply so far, every step's: the row's report once the run ends, however it ends. */
	reply: string;
	/** The step being run, from 0, and its reply alone: what its check and a clipboard result are read from. */
	step: number;
	stepReply: string;
	/**
	 * Turns Claude Code started on its own — announced by `autoTurn` — still
	 * to end: an agent a step started in the background finished, and the CLI
	 * answers that. Their end is not the end of a step, or the next prompt went
	 * out, and its check was judged, on the wrong reply.
	 */
	ownTurns: number;
	/** The tool calls already counted: Codex can report one start twice. */
	seen: Set<string>;
}

/** The ids of the runs' rows in the agents list; an agent's own row has the CLI's tool id. */
export const runRowPrefix = 'toolbar-run-';
/** How many ended runs a chat's agents list keeps; one chat's runs do not push out another's. */
const endedRowsKept = 20;
/** And all chats together, for a window that runs skills all day. */
const endedRowsKeptInAll = 200;
/** Ended shell rows of workflows kept for the Bash tab, all chats together. */
const shellRowsKept = 40;
/** The most of a shell row's output kept for the Bash tab's viewer; the step itself keeps its own tails. */
const shellRowOutputLimit = 200_000;
/** A run's own tool calls kept on its row, as for an agent's. */
const callsKept = 100;
/**
 * The longest report and prompt a row keeps: up to 20 ended rows a chat go out
 * with every state post, so a long reply is cut — the clipboard has it whole.
 */
const rowTextLimit = 20_000;

/** How long a finished run keeps its done or failed look on the button. */
const shownForMs = 2500;
/** How long a failed run keeps its look, so its reason can be read on hover. */
const failedShownForMs = 8000;

/** Which of a skill's runs its button shows: one waiting on the user, else one running, else the last to end. */
function rank(run: ToolbarRun): number {
	return run.status === 'waiting' ? 3 : run.status === 'running' ? 2 : 1;
}

/**
 * Toolbar skills whose result goes to the clipboard or nowhere: each run is a
 * conversation of its own, never shown in a tab — a session opened on the
 * agent's backend, sent the prompt, and let go when its turn ends.
 *
 * Its questions are answered by the approval menu like a tab's; one the menu
 * leaves to the user stops the run and turns its button to "waiting", and the
 * answer comes from the button's own popover, since there is no conversation
 * to show a card in. A skill may run more than once at a time — the button
 * asks first (`again`) — and its button shows the run that most needs the
 * user: one waiting, else one running, else the last to end.
 */
export class ToolbarRuns implements vscode.Disposable {
	private readonly _runs = new Map<number, Running>();
	/** Rows of runs that ended, newest last: the list keeps them so their reports can be read. */
	private _ended: { chatId: string; row: ToolEntry }[] = [];
	private _next = 0;
	private _disposed = false;
	/**
	 * The command rows of workflows' shell steps, newest last, running and the
	 * last that ended: the Bash tab and Activity list them beside the agents'
	 * own commands. Their output is the run's, never the chat's.
	 */
	private _shells: { chatId: string; row: ToolEntry }[] = [];

	constructor(private readonly _host: ToolbarRunHost) { }

	public get state(): Record<string, ToolbarRun> {
		const out: Record<string, ToolbarRun> = {};
		for (const r of this._runs.values()) {
			const shown = out[r.skillId];
			if (!shown || rank(r.run) > rank(shown) || (rank(r.run) === rank(shown) && (r.run.endedAt ?? 0) >= (shown.endedAt ?? 0))) {
				out[r.skillId] = r.run;
			}
		}
		for (const id of Object.keys(out)) {
			const count = this._running(id).length;
			if (count > 1) {
				out[id] = { ...out[id], count };
			}
		}
		return out;
	}

	private _running(skillId: string): Running[] {
		return [...this._runs.values()].filter(r => r.skillId === skillId && (r.run.status === 'running' || r.run.status === 'waiting'));
	}

	public isRunning(id: string): boolean {
		return this._running(id).length > 0;
	}

	/**
	 * The runs pressed in a chat, as rows of its agents list — asked for: a run
	 * is an agent working in the background, and nothing else showed what it was
	 * doing. Running ones and the last that ended, oldest first.
	 */
	public rows(chatId: string): ToolEntry[] {
		const live = [...this._runs.values()].filter(r => r.chatId === chatId && r.session).map(r => r.row);
		return [...this._ended.filter(e => e.chatId === chatId).map(e => e.row), ...live].sort((a, b) => a.startedAt - b.startedAt);
	}

	/** How many runs pressed in a chat are still going, for its tab's agent count. */
	public runningIn(chatId: string): number {
		return [...this._runs.values()].filter(r => r.chatId === chatId && r.session).length;
	}

	/** A workflow's shell step started: a command row for the Bash tab. */
	private _noteShell(chatId: string, runRowId: string, id: string, command: string, detail: string | undefined): void {
		this._shells.push({
			chatId,
			row: { kind: 'tool', id, tool: 'command', name: 'Shell', detail, input: command, output: '', status: 'running', startedAt: Date.now(), shell: { workflow: runRowId, background: true } },
		});
		// The running ones always stay; of the ended, the newest.
		const ended = this._shells.filter(s => s.row.status !== 'running');
		if (ended.length > shellRowsKept) {
			const drop = new Set(ended.slice(0, ended.length - shellRowsKept));
			this._shells = this._shells.filter(s => !drop.has(s));
		}
	}

	private _updateShell(id: string, update: ToolUpdate): void {
		const found = this._shells.find(s => s.row.id === id);
		if (!found) {
			return;
		}
		const row = found.row;
		if (update.output !== undefined) {
			const text = update.append ? (row.output ?? '') + update.output : update.output;
			row.output = text.length > shellRowOutputLimit ? text.slice(text.length - shellRowOutputLimit) : text;
			// The posts are coalesced; this is what refreshes an open output viewer.
			this._host.changed();
		}
		if (update.status) {
			row.status = update.status;
			row.endedAt = Date.now();
			this._host.changed();
		}
		if (update.exitCode !== undefined) {
			row.exitCode = update.exitCode;
		}
	}

	/** A workflow's shell rows pressed in a chat, running and recently ended; with their output. */
	public shellRows(chatId: string): ToolEntry[] {
		return this._shells.filter(s => s.chatId === chatId).map(s => s.row);
	}

	/** One shell row by id, whichever chat it belongs to. */
	public shellRow(id: string): { chatId: string; row: ToolEntry } | undefined {
		return this._shells.find(s => s.row.id === id);
	}

	/** Every run pressed in a chat, which its tab has let go of (`TabHost.released`). */
	public stopChat(chatId: string): void {
		for (const [key, entry] of this._runs) {
			if (entry.chatId === chatId && entry.session) {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("Stopped."), endedAt: Date.now() }, failedShownForMs, true);
			}
		}
	}

	/** Stops one run, from the agents list; false when it is not one of these or already over. */
	public stopRow(rowId: string): boolean {
		for (const [key, entry] of this._runs) {
			if (entry.row.id === rowId && entry.session) {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("Stopped."), endedAt: Date.now() }, failedShownForMs, true);
				return true;
			}
		}
		return false;
	}

	/**
	 * `steps` are the skill's prompts, filled in and written for the agent: the
	 * first is sent now and each next one, in the same session, once the turn
	 * before it has ended and its check — if it has one — passed. The row shows
	 * the user's own text; the instructions added around it (the check's
	 * markers, the clipboard's) are ours.
	 */
	public start(skill: ToolbarSkill, steps: readonly FilledStep[], values: Readonly<Record<string, string>>, chatId: string, backend: AgentBackend, model: string, effort: string | undefined, cwd: string, root: string | undefined, ownSettings = true): void {
		if (this._disposed) {
			return;
		}
		// A finished run of the same skill stops showing: the new one is what the button is about.
		for (const [key, r] of this._runs) {
			if (r.skillId === skill.id && !this._running(skill.id).includes(r)) {
				if (r.clear) {
					clearTimeout(r.clear);
				}
				this._runs.delete(key);
			}
		}
		if (!steps.length) {
			return;
		}
		const key = ++this._next;
		// A workflow — a skill with a shell step or a named step — runs each step
		// on its own: a new session for an agent's, a command for a shell's, and
		// what each left is handed to the steps after it (`workflowVars.ts`).
		const workflow = !!skill.workflow || steps.some(s => s.shell || s.name);
		const records: StepRecord[] = [];
		const label = (at: number) => steps[at].name ?? vscode.l10n.t("step {0}", at + 1);
		const open = (at: number): AgentSession => steps[at].shell
			? new ShellStepSession(cwd, shellEnv(values, records), `/${skill.name} · ${label(at)}`)
			: backend.openSession(cwd, undefined, 0, root, undefined, ownSettings);
		// Routes between steps (`onSuccess` / `onFailure`): without any, the run
		// goes on step by step as it always has. With them, `workflowGraph`
		// decides where it goes, counts every route back, and the run never
		// executes more than `executionBound` steps.
		const routed = workflow && steps.some(s => s.onSuccess || s.onFailure || s.choices);
		const graph: RoutedStep[] = steps.map((s, i) => ({
			id: String(i), kind: s.choices ? 'decide' : s.shell ? 'shell' : 'ai',
			onSuccess: routeTarget(s.onSuccess, 'next'), onFailure: routeTarget(s.onFailure, 'fail'),
			...(s.choices ? { choices: s.choices.map(c => ({ label: c.label, route: routeTarget(c.route, 'next') })) } : {}),
		}));
		/** The label a decision step chose, for `{{steps.x.choice}}`. */
		let chosen: string | undefined;
		/** The step whose prompt carried the next step's check: only its answer gates that step. */
		let askedCheck: number | undefined;
		const counters = new RouteCounters();
		const bound = executionBound(graph);
		counters.execute(bound);
		/** Whether a step's success can end the run, so its prompt carries the result markers. */
		// A route back that goes on once spent can end the run from the last step too.
		const endsOn = (route: RouteTarget, at: number) => routeCanEnd(route, at === steps.length - 1);
		const ends = (at: number) => routed
			? graph[at].choices ? graph[at].choices!.some(c => endsOn(c.route, at)) : endsOn(graph[at].onSuccess, at)
			: at === steps.length - 1;
		const many = steps.length > 1;
		const shown = many
			? steps.map((step, i) => `${i + 1}. ${step.shell ? '$ ' : ''}${step.check ? `(if: ${step.check}) ` : ''}${step.text}`).join('\n\n')
			: steps[0].text;
		const row: ToolEntry = {
			kind: 'tool', id: `${runRowPrefix}${key}`, tool: 'agent', name: skill.name, detail: many ? `/${skill.name} · 1/${steps.length}` : `/${skill.name}`,
			input: capAt(shown, rowTextLimit), status: 'running', startedAt: Date.now(),
			agent: { type: (workflow ? 'workflow' : 'toolbar skill') + (skill.result === 'clipboard' ? ' · to the clipboard' : skill.result === 'toast' ? ' · in a notification' : ' · silent'), model, background: true, origin: 'toolbar', skill: skill.id, toolUses: 0, tokens: 0, calls: [] },
		};
		const entry: Running = {
			skillId: skill.id, skill, values, agent: backend.id, run: many ? { status: 'running', step: 1, steps: steps.length } : { status: 'running' },
			session: open(0), asked: [], chatId, row, reply: '', seen: new Set(), step: 0, stepReply: '', ownTurns: 0,
		};
		this._runs.set(key, entry);
		let children = new SkillAgents();
		let pendingEnd = false;
		const current = (session: AgentSession) => this._runs.get(key) === entry && entry.session === session;
		/** What the step that just ended left, for the steps after it. */
		const record = () => {
			const session = entry.session!;
			const output = session instanceof ShellStepSession ? session.output : { reply: entry.stepReply, ...(chosen !== undefined ? { choice: chosen } : {}) };
			chosen = undefined;
			records.push({ number: entry.step + 1, name: steps[entry.step].name, output });
		};
		/** Opens step `at` in a new session and sends it; `back` names a route back being taken. */
		const goto = (at: number, back?: { taken: number; times: number }) => {
			if (!counters.execute(bound)) {
				void this._finish(skill, key, entry, vscode.l10n.t("The workflow ran {0} steps, its limit.", bound), entry.stepReply);
				return;
			}
			record();
			const old = entry.session;
			entry.session = open(at);
			old?.dispose();
			children = new SkillAgents();
			pendingEnd = false;
			entry.ownTurns = 0;
			attach(entry.session);
			entry.step = at;
			send(back);
		};
		/** Where a routed workflow goes after its step ended; `error` is a failure's reason. */
		const route = (error?: string) => {
			const choices = steps[entry.step].choices;
			let outcome: StepOutcome = error ? { kind: 'failure' } : { kind: 'success' };
			if (choices && !error) {
				const index = chosenOption(entry.stepReply, choices.length);
				if (index === undefined) {
					// No choice is a failure of the step: its failure route decides.
					error = vscode.l10n.t("The agent did not choose one of: {0}.", choices.map(c => c.label).join(', '));
					outcome = { kind: 'failure' };
				} else {
					chosen = choices[index].label;
					outcome = { kind: 'choice', index };
					row.detail = `${row.detail ?? ''} · → ${chosen}`;
				}
			}
			const result = nextStep(graph, entry.step, outcome, counters);
			if (result.kind === 'done') {
				const last = entry.session;
				const shell = last instanceof ShellStepSession;
				void this._finish(skill, key, entry, undefined, shell ? last.output.stdout ?? '' : entry.stepReply, shell);
				return;
			}
			if (result.kind === 'fail') {
				// The graph names steps by index; the user knows them by name or number.
				const why = result.why.replace(/"(\d+)"/g, (_, n: string) => `"${label(Number(n))}"`);
				const failed = error && vscode.l10n.t("Step \"{0}\" failed: {1}", label(entry.step), error);
				// A plain failure says only that; a spent route back says why it stopped too.
				void this._finish(skill, key, entry, failed ? (graph[entry.step].onFailure.kind === 'fail' ? failed : `${failed} ${why}`) : why, entry.stepReply);
				return;
			}
			// The check of a prompt applies only when the run arrives at it in order.
			if (!result.back && result.index === entry.step + 1 && !error && !choices && askedCheck === entry.step) {
				const gate = stepGate(steps[result.index].check, undefined, entry.stepReply);
				if (!gate.go) {
					const why = vscode.l10n.t("Stopped after prompt {0} of {1}: {2}.", entry.step + 1, steps.length, gate.why);
					this._end(key, entry, { status: 'done', message: why, endedAt: Date.now() }, shownForMs);
					confirm(vscode.l10n.t("{0}: {1}", skill.label ?? skill.name, why));
					return;
				}
			}
			goto(result.index, result.back && result.taken !== undefined && result.times !== undefined ? { taken: result.taken, times: result.times } : undefined);
		};
		const advance = (error?: string) => {
			if (routed) {
				route(error);
				return;
			}
			const next = steps[entry.step + 1];
			if (!next) {
				const last = entry.session;
				// A command's result is what it printed, as it printed it.
				const shell = last instanceof ShellStepSession;
				void this._finish(skill, key, entry, error, shell ? last.output.stdout ?? '' : entry.stepReply, shell);
				return;
			}
			const gate = stepGate(next.check, error, entry.stepReply);
			if (!gate.go) {
				// The skill stops here, as asked: not a failure of the run unless
				// the step itself failed.
				const why = vscode.l10n.t("Stopped after prompt {0} of {1}: {2}.", entry.step + 1, steps.length, gate.why);
				this._end(key, entry, error
					? { status: 'failed', message: `${error} ${why}`, endedAt: Date.now() }
					: { status: 'done', message: why, endedAt: Date.now() }, error ? failedShownForMs : shownForMs);
				if (!error) {
					confirm(vscode.l10n.t("{0}: {1}", skill.label ?? skill.name, why));
				}
				return;
			}
			// Every step's reply is kept, so `{{steps.N.reply}}` fills in a plain skill too.
			record();
			if (workflow) {
				const old = entry.session;
				entry.session = open(entry.step + 1);
				old?.dispose();
				children = new SkillAgents();
				pendingEnd = false;
				entry.ownTurns = 0;
				attach(entry.session);
			}
			entry.step++;
			send();
		};
		const scheduleAdvance = (session: AgentSession) => {
			if (entry.stepTimer) { clearTimeout(entry.stepTimer); entry.stepTimer = undefined; }
			if (!current(session) || !pendingEnd || children.running || session.running || entry.ownTurns || entry.asked.length) { return; }
			// Allow the parent's automatic reply to a child result to start first.
			entry.stepTimer = setTimeout(() => {
				entry.stepTimer = undefined;
				if (!current(session) || !pendingEnd || children.running || session.running || entry.ownTurns || entry.asked.length) { return; }
				pendingEnd = false;
				advance();
			}, session instanceof ShellStepSession ? 0 : 500);
		};

		const attach = (session: AgentSession) => session.onEvent(event => {
			if (!current(session)) {
				return;
			}
			children.observe(event);
			if (event.type !== 'turnEnd') { scheduleAdvance(session); }
			switch (event.type) {
				case 'text':
					entry.reply += event.text;
					entry.stepReply += event.text;
					return;
				case 'textBreak':
					entry.reply += entry.reply && !entry.reply.endsWith('\n\n') ? '\n\n' : '';
					entry.stepReply += entry.stepReply ? '\n\n' : '';
					return;
				case 'tool': {
					// Its own calls, as an agent's card lists them; the reply is set on
					// the row only at the end, or the list rebuilt on every chunk (#365).
					const info = row.agent!;
					if (entry.seen.has(event.id)) {
						return;
					}
					entry.seen.add(event.id);
					if (info.calls.length < callsKept) {
						info.calls.push({ name: event.tool.name, detail: event.tool.detail ?? (session instanceof ShellStepSession ? event.tool.input : undefined) });
					}
					info.toolUses = (info.toolUses ?? 0) + 1;
					info.lastTool = event.tool.name;
					if (session instanceof ShellStepSession) {
						this._noteShell(chatId, row.id, event.id, event.tool.input ?? '', event.tool.detail);
					}
					this._host.changed();
					return;
				}
				case 'toolUpdate':
					if (session instanceof ShellStepSession) {
						this._updateShell(event.id, event.update);
					}
					return;
				case 'tokens':
					row.agent!.tokens = event.cumulative ? event.input + event.output : (row.agent!.tokens ?? 0) + event.input + event.output;
					this._host.changed();
					return;
				case 'approval': {
					const request = event.request;
					// A question with choices has no conversation to be shown in
					// and is skipped: the agent is told to go on with its best
					// judgement and say what it chose.
					if (request.questions) {
						session.answer(request.id, false);
						return;
					}
					if (request.what === 'mcp' && request.server) {
						this._host.noteServer(request.server);
					}
					const mode = this._host.approvalMode(approvalKey(request));
					if (mode !== 'ask') {
						session.answer(request.id, mode === 'auto');
						return;
					}
					entry.asked.push(request);
					this._showAsked(entry);
					return;
				}
				case 'approvalDone':
					if (entry.asked.some(q => q.id === event.id)) {
						entry.asked = entry.asked.filter(q => q.id !== event.id);
						this._showAsked(entry);
						scheduleAdvance(session);
					}
					return;
				case 'autoTurn':
					entry.ownTurns++;
					return;
				case 'turnEnd': {
					if (event.error) {
						pendingEnd = false;
						// A failure goes where the step's route says; the user's Stop never does.
						if (routed && !event.interrupted && event.error !== 'Stopped.') {
							route(event.error);
							return;
						}
						const what = workflow ? vscode.l10n.t("Step \"{0}\" failed: {1}", label(entry.step), event.error) : event.error;
						void this._finish(skill, key, entry, what, entry.stepReply);
						return;
					}
					if (entry.ownTurns > 0) { entry.ownTurns--; }
					else { pendingEnd = true; }
					scheduleAdvance(session);
					return;
				}
			}
		});
		attach(entry.session!);
		// The prompt of the step being run, with what the agent is asked to add:
		// the check of the step after it, or, on the last, the clipboard markers.
		// A shell step's command goes as written; its values are in its environment.
		const send = (back?: { taken: number; times: number }) => {
			const at = entry.step;
			const step = steps[at];
			const session = entry.session!;
			let text = step.shell ? step.text : fillVars(step.text, values, records);
			// The next prompt's check is asked only when the run goes there in order.
			// `successLeads` is the rule `nextStep` applies after the step, so the gate reads an answer to the check it asked.
			const check = !routed || successLeads(graph, at, counters) === 'next' ? steps[at + 1]?.check : undefined;
			askedCheck = check !== undefined ? at : undefined;
			if (step.choices && !step.shell) {
				// A decision step's options end the prompt, after any result markers.
				if (ends(at) && (skill.result === 'clipboard' || skill.result === 'toast')) {
					text = withResultMarkers(text, skill.result === 'toast' ? 'notification' : 'clipboard');
				}
				text = withChoices(text, step.choices.map(c => c.label));
			} else if (!step.shell) {
				if (check) {
					text = withNextDecision(text, fillVars(check, values, records));
				} else if (ends(at) && skill.result === 'clipboard') {
					text = withResultMarkers(text);
				} else if (ends(at) && skill.result === 'toast') {
					text = withResultMarkers(text, 'notification');
				}
			}
			entry.stepReply = '';
			if (many) {
				entry.run = { ...entry.run, step: at + 1, steps: steps.length };
				row.detail = `/${skill.name} · ${at + 1}/${steps.length}${workflow ? ` · ${label(at)}` : ''}${back ? ` · ${vscode.l10n.t("back {0}/{1}", back.taken, back.times)}` : ''}`;
				if (at > 0) {
					entry.reply += entry.reply ? '\n\n---\n\n' : '';
				}
			}
			this._host.changed();
			session.send({ text, images: [] }, model, effort).then(sent => {
				if (!sent && current(session)) {
					void this._finish(skill, key, entry, vscode.l10n.t("Step \"{0}\" could not start.", label(at)), entry.stepReply);
				}
			}, err => {
				if (current(session)) {
					void this._finish(skill, key, entry, err instanceof Error ? err.message : String(err), entry.stepReply);
				}
			});
		};
		send();
	}

	/**
	 * The answer to the question the user was shown, named by its id. With two
	 * runs of the skill waiting, the button shows the newer one's question, and
	 * answering "the skill's" — the first found — approved a command nobody had
	 * seen. A question that is no longer open is not answered at all.
	 */
	public answer(skillId: string, approvalId: string, allow: boolean): void {
		const entry = this._running(skillId).find(r => r.session && r.asked.some(q => q.id === approvalId));
		if (!entry?.session) {
			return;
		}
		entry.session.answer(approvalId, allow);
		entry.asked = entry.asked.filter(q => q.id !== approvalId);
		this._showAsked(entry);
	}

	/**
	 * The approval menu changed: a question whose category is no longer on Ask
	 * is answered now, as a tab's waiting cards are (`approvalModesChanged`).
	 */
	public approvalModesChanged(): void {
		for (const entry of this._runs.values()) {
			const session = entry.session;
			if (!session || !entry.asked.length) {
				continue;
			}
			const left: ApprovalRequest[] = [];
			for (const q of entry.asked) {
				const mode = this._host.approvalMode(approvalKey(q));
				if (mode === 'ask') {
					left.push(q);
				} else {
					session.answer(q.id, mode === 'auto');
				}
			}
			if (left.length !== entry.asked.length) {
				entry.asked = left;
				this._showAsked(entry);
			}
		}
	}

	/** The run's look: waiting on its oldest open question, else running. */
	private _showAsked(entry: Running): void {
		const q = entry.asked[0];
		const approval = q ? { id: q.id, title: q.title, detail: q.detail } : undefined;
		const step = entry.run.steps ? { step: entry.run.step, steps: entry.run.steps } : {};
		entry.run = approval ? { status: 'waiting', approval, ...step } : { status: 'running', ...step };
		// The agents list says so too, and answers it there as the button does.
		entry.row.agent!.waiting = approval;
		this._host.changed();
	}

	/**
	 * The view closed: nothing can show a run or answer its question any more,
	 * so every run still going ends, as the tabs' conversations do — a CLI is
	 * not left working unseen on the user's quota (#356). The view is kept
	 * while hidden (`retainContextWhenHidden`), so this is a real close.
	 */
	public viewClosed(): void {
		for (const [key, entry] of this._runs) {
			if (entry.run.status === 'running' || entry.run.status === 'waiting') {
				// Not told: every run ends at once here, and the user closed the view.
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("The chat view was closed."), endedAt: Date.now() }, failedShownForMs, false, undefined, true);
			}
		}
	}

	/** Every run of the skill still going. */
	public stop(skillId: string): void {
		for (const [key, entry] of this._runs) {
			if (entry.skillId === skillId && (entry.run.status === 'running' || entry.run.status === 'waiting')) {
				this._end(key, entry, { status: 'failed', message: vscode.l10n.t("Stopped."), endedAt: Date.now() }, failedShownForMs, true);
			}
		}
	}

	/** `raw`: the reply is a command's stdout, taken as it is rather than read for result markers. */
	private async _finish(skill: ToolbarSkill, key: number, entry: Running, error: string | undefined, reply: string, raw = false): Promise<void> {
		if (this._runs.get(key) !== entry || !entry.session) {
			return;
		}
		const name = skill.label ?? skill.name;
		if (error) {
			this._end(key, entry, { status: 'failed', message: error, endedAt: Date.now() }, failedShownForMs);
			return;
		}
		if (skill.result !== 'clipboard' && skill.result !== 'toast') {
			this._end(key, entry, { status: 'done', message: vscode.l10n.t("Done."), endedAt: Date.now() }, shownForMs);
			confirm(vscode.l10n.t("{0} is done.", name));
			return;
		}
		// No markers: the model ignored the instruction. Its last code block is
		// the next best thing, then the whole reply; the button says which.
		const found = raw ? undefined : extractResult(reply);
		const copied = found?.text ?? reply.trim();
		if (!copied) {
			this._end(key, entry, { status: 'failed', message: skill.result === 'toast' ? vscode.l10n.t("The reply was empty; there was nothing to show.") : vscode.l10n.t("The reply was empty; nothing was copied."), endedAt: Date.now() }, failedShownForMs);
			return;
		}
		if (skill.result === 'toast') {
			// The host shows it (`ended`), with Copy and Open for the whole of it.
			this._end(key, entry, { status: 'done', message: vscode.l10n.t("Shown in a notification."), endedAt: Date.now() }, shownForMs, false, copied);
			return;
		}
		try {
			await vscode.env.clipboard.writeText(copied);
		} catch (err) {
			if (this._runs.get(key) === entry && entry.session) {
				this._end(key, entry, { status: 'failed', message: err instanceof Error ? err.message : String(err), endedAt: Date.now() }, failedShownForMs);
			}
			return;
		}
		// Stopped, forgotten or disposed while the clipboard was written: that
		// ending stands, rather than being overwritten with "Copied".
		if (this._runs.get(key) !== entry || !entry.session) {
			return;
		}
		const message = raw || found?.source === 'markers'
			? vscode.l10n.t("Copied to the clipboard.")
			: found?.source === 'fence'
				? vscode.l10n.t("The reply had no result markers; its last code block was copied.")
				: vscode.l10n.t("The reply had no result markers; the whole reply was copied.");
		this._end(key, entry, { status: 'done', message, endedAt: Date.now() }, shownForMs);
		confirm(vscode.l10n.t("{0}: {1}", name, message));
	}

	/**
	 * The session is let go here, every way a run ends: a Claude process ends with
	 * it. The host is told of an end the user did not cause (`stopped`, `quiet`).
	 */
	private _end(key: number, entry: Running, run: ToolbarRun, shownFor: number, stopped = false, result?: string, quiet = false): void {
		clearTimeout(entry.stepTimer);
		entry.stepTimer = undefined;
		const session = entry.session;
		entry.session = undefined;
		entry.asked = [];
		entry.run = run;
		session?.dispose();
		// A disposed shell step reports nothing more: its row ends with the run.
		for (const shell of this._shells) {
			if (shell.row.shell?.workflow === entry.row.id && shell.row.status === 'running') {
				shell.row.status = 'stopped';
				shell.row.endedAt = run.endedAt ?? Date.now();
			}
		}
		if (this._disposed) {
			return;
		}
		const row = entry.row;
		this._closeRow(entry, run.status === 'done' ? 'done' : stopped ? 'stopped' : 'failed', run.endedAt);
		if (run.status !== 'done' && run.message && !stopped) {
			row.output = row.output ? `${run.message}\n\n${row.output}` : run.message;
		} else if (run.status === 'done' && run.message) {
			row.output = row.output ? `${row.output}\n\n*${run.message}*` : run.message;
		}
		this._keepEnded(entry.chatId, row);
		this._host.changed();
		if (!stopped && !quiet && (run.status === 'done' || run.status === 'failed')) {
			this._host.ended(entry.skill, { status: run.status, message: run.message, result, values: entry.values });
		}
		entry.clear = setTimeout(() => {
			if (this._runs.get(key) === entry) {
				this._runs.delete(key);
				this._host.changed();
			}
		}, shownFor);
	}

	/**
	 * A Refresh replaced the agent's backend, which disposes every session it
	 * held — and a disposed session reports no end of its turn (Claude's is
	 * suppressed once disposed, Codex's emitter is gone), so without this the
	 * run read "running" for the life of the view, and a question it was
	 * stopped on offered an Allow that reached nothing. The registry announces
	 * the replacement before disposing, so the session is let go here first.
	 */
	public backendReplaced(agent: AgentId, gone: boolean): void {
		for (const [key, entry] of this._runs) {
			if (entry.agent === agent && entry.session && (entry.run.status === 'running' || entry.run.status === 'waiting')) {
				const message = gone
					? vscode.l10n.t("The agent is no longer installed; the run ended.")
					: vscode.l10n.t("The agent was replaced by another installed copy; the run ended. Run it again.");
				this._end(key, entry, { status: 'failed', message, endedAt: Date.now() }, failedShownForMs);
			}
		}
	}

	/** The row stays in its chat's list once the button has forgotten the run: its end, and the reply as its report. */
	private _closeRow(entry: Running, status: ToolEntry['status'], endedAt = Date.now()): void {
		const row = entry.row;
		row.output = capAt(entry.reply.trim(), rowTextLimit) || undefined;
		row.status = status;
		row.endedAt = endedAt;
		row.agent!.lastTool = undefined;
		row.agent!.waiting = undefined;
	}

	private _keepEnded(chatId: string, row: ToolEntry): void {
		this._ended.push({ chatId, row });
		const mine = this._ended.filter(e => e.chatId === chatId);
		if (mine.length > endedRowsKept) {
			const drop = new Set(mine.slice(0, mine.length - endedRowsKept));
			this._ended = this._ended.filter(e => !drop.has(e));
		}
		this._ended = this._ended.slice(-endedRowsKeptInAll);
	}

	/** A skill deleted while it runs: stopped, and nothing left to show. */
	public forget(skillId: string): void {
		for (const [key, entry] of this._runs) {
			if (entry.skillId !== skillId) {
				continue;
			}
			if (entry.session) {
				// A deleted skill's run still ran: its row says it was stopped.
				this._closeRow(entry, 'stopped');
				this._keepEnded(entry.chatId, entry.row);
			}
			if (entry.clear) {
				clearTimeout(entry.clear);
			}
			clearTimeout(entry.stepTimer);
			entry.session?.dispose();
			this._runs.delete(key);
		}
	}

	public dispose(): void {
		this._disposed = true;
		for (const entry of this._runs.values()) {
			if (entry.clear) {
				clearTimeout(entry.clear);
			}
			clearTimeout(entry.stepTimer);
			entry.session?.dispose();
			entry.session = undefined;
		}
		this._runs.clear();
	}
}

/** A stored route as `workflowGraph` reads it; absent, the outcome's default. */
function routeTarget(route: FilledStep['onSuccess'], fallback: 'next' | 'fail'): RouteTarget {
	if (!route) {
		return { kind: fallback };
	}
	return route.to === 'step'
		? { kind: 'step', step: String(route.step), times: route.times, whenSpent: route.whenSpent }
		: { kind: route.to };
}
