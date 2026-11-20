/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat's toolbar skills as text: what a stored or sent skill may look
 * like, the prompt with its parameters filled in, the agent's own way of
 * writing a skill, and the result markers of a clipboard run.
 *
 * A leaf module with no `vscode` and no relative value imports, so `npm test`
 * loads it directly (see "Recipe for the next feature" in CLAUDE.md).
 */

import type { ChatCommand, ToolbarChoice, ToolbarColors, ToolbarNotify, ToolbarParam, ToolbarSkill, ToolbarRoute, ToolbarStep, ToolbarWorkflowStep } from './chatProtocol';

/**
 * As typed after `/` or `$`: lower case, no spaces, like a CLI's own skills
 * (`one-more-review`, `pdf:pdf`) — asked for.
 */
export const toolbarNameShape = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** The colours a toolbar skill can take besides `#rrggbb`: the theme's chart colours, so every theme has them. */
export const toolbarColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
const hexColor = /^#[0-9a-f]{6}$/i;
const paramNameShape = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const iconShape = /^[a-z0-9-]{1,60}$/;
/** A workflow step's name, as `{{steps.<name>.stdout}}` and `STEP_<NAME>_STDOUT` read it. */
export const stepNameShape = /^[a-z][a-z0-9_]{0,31}$/;

export const toolbarLimits = {
	skills: 30,
	prompt: 20_000,
	/** Prompts after the first: a chain is a few steps, not a script. */
	followUps: 9,
	check: 2_000,
	label: 40,
	tooltip: 200,
	params: 10,
	maxLength: 10_000,
	options: 30,
	option: 100,
	/** A notification's own text, before its placeholders are filled in. */
	notifyText: 500,
} as const;

/**
 * A skill as it may be stored, from whatever the view sent or `globalState`
 * held: trimmed, cut to the limits, and refused — with the reason — when it
 * cannot be run as it is. The host is the one that decides; the editor's own
 * checks are a convenience.
 */
export function validToolbarSkill(raw: unknown): ToolbarSkill | string {
	if (!isRecord(raw)) {
		return 'Not a skill.';
	}
	const id = typeof raw.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(raw.id) ? raw.id : undefined;
	if (!id) {
		return 'The skill has no id.';
	}
	// Lower-cased rather than refused: a skill saved before names had to be
	// lower case is kept, under the name it can now be typed as.
	const name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase() : '';
	if (!toolbarNameShape.test(name)) {
		return 'The name is a single word of lower-case letters, digits, "-", "_", ":" or ".", at most 64 characters — no spaces.';
	}
	const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
	if (!prompt) {
		return 'The prompt is empty.';
	}
	if (prompt.length > toolbarLimits.prompt) {
		return `The prompt is longer than ${toolbarLimits.prompt} characters.`;
	}
	const followUps: ToolbarStep[] = [];
	// The raw index of each kept follow-up, so `workflow` (aligned with the
	// steps as sent, blank rows included) still lines up after a blank is dropped.
	const kept: number[] = [];
	const rawFollowUps: unknown[] = Array.isArray(raw.followUps) ? raw.followUps : [];
	for (let i = 0; i < rawFollowUps.length; i++) {
		const step = validStep(rawFollowUps[i], followUps.length + 2);
		if (typeof step === 'string') {
			return step;
		}
		if (step) {
			followUps.push(step);
			kept.push(i + 1);
		}
	}
	if (followUps.length > toolbarLimits.followUps) {
		return `A skill sends at most ${toolbarLimits.followUps + 1} prompts.`;
	}
	const workflow = validWorkflow(raw.workflow, [0, ...kept]);
	if (typeof workflow === 'string') {
		return workflow;
	}
	const result = raw.result === 'clipboard' || raw.result === 'silent' || raw.result === 'toast' ? raw.result : 'chat';
	// How the first prompt goes in the chat while the agent works: `later` (the default) waits for the turn.
	const firstSend = result === 'chat' && raw.firstSend === 'now' ? 'now' as const : undefined;
	const notify = validNotify(raw.notify);
	if (typeof notify === 'string') {
		return notify;
	}
	const agents = raw.agents === 'claude' || raw.agents === 'codex' || raw.agents === 'gemini' || raw.agents === 'openrouter' || raw.agents === 'opencode' || raw.agents === 'pi' ? raw.agents : 'all';
	const icon = typeof raw.icon === 'string' && iconShape.test(raw.icon) ? raw.icon : 'sparkle';
	const colors = validColors(raw.colors, raw.color);
	const label = text(raw.label, toolbarLimits.label);
	const tooltip = text(raw.tooltip, toolbarLimits.tooltip);
	const params: ToolbarParam[] = [];
	for (const p of Array.isArray(raw.params) ? raw.params : []) {
		const param = validParam(p);
		if (typeof param === 'string') {
			return param;
		}
		if (params.some(q => q.name === param.name)) {
			return `Two parameters are named "${param.name}".`;
		}
		params.push(param);
	}
	if (params.length > toolbarLimits.params) {
		return `A skill takes at most ${toolbarLimits.params} parameters.`;
	}
	if (workflow) {
		if (result === 'chat' && workflow.some(step => step.shell)) {
			return 'A workflow with shell steps runs in the background: choose the clipboard, silently or a notification for its result.';
		}
		if (result === 'chat' && workflow.some(step => step.onSuccess || step.onFailure)) {
			return 'A workflow with routes between steps runs in the background: choose the clipboard, silently or a notification for its result.';
		}
		if (result === 'chat' && workflow.some(step => step.choices)) {
			return 'A workflow with decision steps runs in the background: choose the clipboard, silently or a notification for its result.';
		}
		for (let i = 1; i < workflow.length; i++) {
			if (workflow[i - 1].shell && followUps[i - 1].check) {
				return `Step ${i + 1} follows a shell step and cannot have a check: the command's exit code decides whether the workflow goes on.`;
			}
			if (workflow[i - 1].choices && followUps[i - 1].check) {
				return `Step ${i + 1} follows a decision step and cannot have a check: the choice decides where the workflow goes.`;
			}
		}
	}
	return { id, name, prompt, followUps: followUps.length ? followUps : undefined, workflow, result, firstSend, notify, agents, icon, label, tooltip, colors, params };
}

/**
 * The kind and name of each step, picked out at `indexes` (the raw positions
 * of the steps kept). Absent when no step is a shell command and none has a
 * name: then the skill is an ordinary one.
 */
function validWorkflow(raw: unknown, indexes: readonly number[]): ToolbarWorkflowStep[] | string | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const steps: ToolbarWorkflowStep[] = [];
	const names = new Set<string>();
	for (let i = 0; i < indexes.length; i++) {
		const item = raw[indexes[i]];
		const from = isRecord(item) ? item : {};
		const shell = from.shell === true;
		const stepName = typeof from.name === 'string' ? from.name.trim() : '';
		if (stepName && !stepNameShape.test(stepName)) {
			return `Step ${i + 1}'s name is lower-case letters, digits and "_", starting with a letter, at most 32 characters.`;
		}
		if (stepName === 'prev') {
			return '"prev" names the step before, in `{{steps.prev.stdout}}`: give the step another name.';
		}
		if (stepName && names.has(stepName)) {
			return `Two steps are named "${stepName}".`;
		}
		if (stepName) {
			names.add(stepName);
		}
		const choices = validChoices(from.choices, i, indexes);
		if (typeof choices === 'string') {
			return choices;
		}
		if (choices && shell) {
			return `Step ${i + 1} is a shell command and cannot decide: only an agent step chooses.`;
		}
		// A decision step goes where its choice says; success has no route of its own.
		const onSuccess = choices ? undefined : validRoute(from.onSuccess, i, indexes, 'success');
		if (typeof onSuccess === 'string') {
			return onSuccess;
		}
		const onFailure = validRoute(from.onFailure, i, indexes, 'failure');
		if (typeof onFailure === 'string') {
			return onFailure;
		}
		steps.push({
			...(shell ? { shell: true as const } : {}),
			...(stepName ? { name: stepName } : {}),
			...(onSuccess ? { onSuccess } : {}),
			...(onFailure ? { onFailure } : {}),
			...(choices ? { choices } : {}),
		});
	}
	return steps.some(step => step.shell || step.name || step.onSuccess || step.onFailure || step.choices) ? steps : undefined;
}

/** A decision step offers 2 to this many choices. */
export const workflowMaxChoices = 5;
/** The longest choice label, in characters. */
export const choiceLabelLimit = 40;

/**
 * A decision step's choices: 2 to {@link workflowMaxChoices}, each a label on
 * one line (no `<` or `>`, which the choice marker uses) and a route. Labels
 * differ ignoring case, since the agent is shown them side by side. Every
 * route is stored, `next` included: a choice has no default.
 */
function validChoices(raw: unknown, at: number, indexes: readonly number[]): ToolbarChoice[] | string | undefined {
	if (!Array.isArray(raw) || raw.length === 0) {
		return undefined;
	}
	if (raw.length < 2 || raw.length > workflowMaxChoices) {
		return `Step ${at + 1} decides between 2 and ${workflowMaxChoices} choices.`;
	}
	const choices: ToolbarChoice[] = [];
	const seen = new Set<string>();
	for (let c = 0; c < raw.length; c++) {
		const item: Record<string, unknown> = isRecord(raw[c]) ? raw[c] : {};
		const label = typeof item.label === 'string' ? item.label.trim() : '';
		if (!label) {
			return `Step ${at + 1}, choice ${c + 1} has no label.`;
		}
		if (label.length > choiceLabelLimit || /[\r\n<>]/.test(label)) {
			return `Step ${at + 1}, choice ${c + 1}: a label is one line of at most ${choiceLabelLimit} characters, without "<" or ">".`;
		}
		if (seen.has(label.toLowerCase())) {
			return `Step ${at + 1} offers "${label}" twice.`;
		}
		seen.add(label.toLowerCase());
		const route = validRoute(item.route, at, indexes, 'choice');
		if (typeof route === 'string') {
			return route.replace('on choice', `choice "${label}"`);
		}
		choices.push({ label, route: route ?? { to: 'next' } });
	}
	return choices;
}

/** How many times a route back may be taken: the same bound as `workflowGraph.maxBackTimes`, written twice (a leaf). */
export const workflowMaxBack = 3;

/**
 * A step's route, its target remapped from the editor's raw position to the
 * index among the steps kept. The default for its outcome (on for success,
 * fail for failure) is not stored. A route back needs `times` 1–3; a route
 * forward takes neither `times` nor `whenSpent`. The rules are
 * `workflowGraph.routeProblems`', written again here because this module is a
 * leaf `npm test` loads directly.
 */
function validRoute(raw: unknown, at: number, indexes: readonly number[], outcome: 'success' | 'failure' | 'choice'): ToolbarRoute | string | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const where = `Step ${at + 1}, on ${outcome}`;
	if (raw.to === 'next' || raw.to === 'done' || raw.to === 'fail') {
		const isDefault = outcome === 'success' ? raw.to === 'next' : outcome === 'failure' && raw.to === 'fail';
		if (raw.to === 'next' && at === indexes.length - 1) {
			return outcome === 'success' ? undefined : { to: 'done' };
		}
		return isDefault ? undefined : { to: raw.to };
	}
	if (raw.to !== 'step') {
		return undefined;
	}
	const target = typeof raw.step === 'number' && Number.isInteger(raw.step) ? indexes.indexOf(raw.step) : -1;
	if (target < 0) {
		return `${where}: the step it goes to is empty or gone.`;
	}
	if (target > at) {
		return target === at + 1 && outcome === 'success' ? undefined
			: target === at + 1 && outcome === 'choice' ? { to: 'next' } : { to: 'step', step: target };
	}
	const times = raw.times;
	if (typeof times !== 'number' || !Number.isInteger(times) || times < 1 || times > workflowMaxBack) {
		return `${where}: going back is allowed 1 to ${workflowMaxBack} times.`;
	}
	return { to: 'step', step: target, times, whenSpent: raw.whenSpent === 'next' ? 'next' : 'fail' };
}

/** None, ours, or the user's own text — which may not be empty, or the notification would say nothing. */
function validNotify(raw: unknown): ToolbarNotify | string | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	if (raw.mode === 'auto') {
		return { mode: 'auto' };
	}
	if (raw.mode !== 'text') {
		return undefined;
	}
	const value = typeof raw.text === 'string' ? raw.text.trim() : '';
	if (!value) {
		return 'The notification text is empty.';
	}
	if (value.length > toolbarLimits.notifyText) {
		return `The notification text is longer than ${toolbarLimits.notifyText} characters.`;
	}
	return { mode: 'text', text: value };
}

/**
 * A notification's own text with its placeholders filled in: `{{skill}}`,
 * `{{status}}`, `{{message}}`, `{{result}}` and the skill's parameters, by
 * name. A placeholder naming none of them is left as written, as in a prompt.
 * The values are put in as they are — the caller makes the whole safe for a
 * notification (`plainInNotification`), since a result is a model's text.
 */
export function notificationText(template: string, values: Readonly<Record<string, string>>): string {
	return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
		(whole, name: string) => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole);
}

/**
 * One prompt after the first: an empty one is dropped rather than refused (a
 * row the editor left blank). An empty check is no check.
 */
function validStep(raw: unknown, number: number): ToolbarStep | string | undefined {
	const from = isRecord(raw) ? raw : { prompt: raw };
	const prompt = typeof from.prompt === 'string' ? from.prompt.trim() : '';
	if (!prompt) {
		return undefined;
	}
	if (prompt.length > toolbarLimits.prompt) {
		return `Prompt ${number} is longer than ${toolbarLimits.prompt} characters.`;
	}
	const check = typeof from.check === 'string' ? from.check.trim() : '';
	if (check.length > toolbarLimits.check) {
		return `The check before prompt ${number} is longer than ${toolbarLimits.check} characters.`;
	}
	return check ? { prompt, check } : { prompt };
}

/** One colour, as the host keeps it: a theme colour by name or `#rrggbb`, nothing else reaching CSS. */
function validColor(value: unknown): string | undefined {
	return typeof value === 'string' && ((toolbarColors as readonly string[]).includes(value) || hexColor.test(value))
		? value.toLowerCase() : undefined;
}

/**
 * The label, border and icon colours. A skill saved when there was one colour
 * (`color`, which tinted the label and the icon) is read as those two.
 */
function validColors(raw: unknown, legacy: unknown): ToolbarColors | undefined {
	const from = isRecord(raw) ? raw : { text: legacy, icon: legacy };
	const colors = { text: validColor(from.text), border: validColor(from.border), icon: validColor(from.icon) };
	return colors.text || colors.border || colors.icon ? colors : undefined;
}

function validParam(raw: unknown): ToolbarParam | string {
	if (!isRecord(raw)) {
		return 'A parameter is malformed.';
	}
	const name = typeof raw.name === 'string' ? raw.name.trim() : '';
	if (!paramNameShape.test(name)) {
		return `"${name.slice(0, 40)}" is not a parameter name: a letter or "_", then letters, digits, "_" or "-", at most 32.`;
	}
	const type = raw.type === 'number' || raw.type === 'choice' ? raw.type : 'text';
	const maxLength = type === 'text' && typeof raw.maxLength === 'number' && Number.isInteger(raw.maxLength)
		&& raw.maxLength >= 1 && raw.maxLength <= toolbarLimits.maxLength ? raw.maxLength : undefined;
	const options = type === 'choice'
		? (Array.isArray(raw.options) ? raw.options : [])
			.filter((o): o is string => typeof o === 'string')
			.map(o => o.trim())
			.filter((o, i, all) => o !== '' && o.length <= toolbarLimits.option && all.indexOf(o) === i)
			.slice(0, toolbarLimits.options)
		: undefined;
	if (type === 'choice' && !options?.length) {
		return `The choice "${name}" lists no values.`;
	}
	const preset = text(raw.preset, maxLength ?? toolbarLimits.maxLength);
	if (preset !== undefined) {
		const problem = valueProblem({ name, type, maxLength, options }, preset);
		if (problem) {
			return `The preset of "${name}": ${problem}`;
		}
	}
	return { name, type, maxLength, preset, options };
}

/** Why a value does not fit its parameter, or undefined when it does. */
export function valueProblem(param: ToolbarParam, value: string): string | undefined {
	const v = value.trim();
	if (!v) {
		return 'a value is needed.';
	}
	if (param.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) {
		return 'a number is needed.';
	}
	if (param.type === 'choice' && !param.options?.includes(v)) {
		return `one of ${(param.options ?? []).join(', ')}.`;
	}
	if (param.maxLength !== undefined && Array.from(v).length > param.maxLength) {
		return `at most ${param.maxLength} characters.`;
	}
	return undefined;
}

/** A step of a skill run, filled in: its prompt, and the check made before it, if any. */
export interface FilledStep {
	readonly text: string;
	readonly check?: string;
	/** A workflow's shell step: `text` is the command, unfilled. */
	readonly shell?: true;
	/** A workflow step's name, for `{{steps.<name>.…}}`. */
	readonly name?: string;
	/** Where the run goes next; absent, the defaults (on to the next step; fail). */
	readonly onSuccess?: ToolbarRoute;
	readonly onFailure?: ToolbarRoute;
	/** A decision step's choices; its prompt ends with `withChoices`. */
	readonly choices?: readonly ToolbarChoice[];
}

/**
 * Every step of the skill, the first and its follow-ups in order, with each
 * `{{param}}` in a prompt or a check replaced by its value — or the first
 * problem with a value. A placeholder naming no parameter is left as written.
 */
export function fillPrompt(skill: ToolbarSkill, values: Readonly<Record<string, unknown>>): { steps: FilledStep[] } | { error: string } {
	const filled: Record<string, string> = {};
	for (const param of skill.params) {
		const raw = values[param.name];
		const value = typeof raw === 'string' ? raw : '';
		const problem = valueProblem(param, value);
		if (problem) {
			return { error: `${param.name}: ${problem}` };
		}
		filled[param.name] = value.trim();
	}
	const fill = (text: string) => text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
		(whole, name: string) => Object.prototype.hasOwnProperty.call(filled, name) ? filled[name] : whole);
	// A shell step's command is never filled in: its values reach it as
	// environment variables (`workflowVars.shellEnv`), so nothing a parameter
	// holds is ever read as shell syntax.
	const kinds = skill.workflow;
	const step = (text: string, check: string | undefined, index: number): FilledStep => {
		const kind = kinds?.[index];
		const filledText = kind?.shell ? text : fill(text);
		return {
			text: filledText,
			...(check ? { check: fill(check) } : {}),
			...(kind?.shell ? { shell: true as const } : {}),
			...(kind?.name ? { name: kind.name } : {}),
			...(kind?.onSuccess ? { onSuccess: kind.onSuccess } : {}),
			...(kind?.onFailure ? { onFailure: kind.onFailure } : {}),
			...(kind?.choices ? { choices: kind.choices } : {}),
		};
	};
	return {
		steps: [step(skill.prompt, undefined, 0), ...(skill.followUps ?? []).map((s, i) => step(s.prompt, s.check, i + 1))],
	};
}

/**
 * The prompt with each skill it names written the way the agent it runs on
 * reads one — `/name` for Claude Code, `$name` for Codex — so a toolbar skill
 * offered to every agent works on either. Only a name that agent lists, as a
 * whole word at the start or after white space, is rewritten.
 */
export function adaptSigils(text: string, commands: readonly ChatCommand[]): string {
	const byName = new Map(commands.map(c => [c.name, c.insert]));
	return text.replace(/(^|\s)[/$]([^\s]+)/g, (whole, lead: string, token: string) => {
		const name = token.replace(/[.,;:!?)]+$/, '');
		const insert = byName.get(name);
		return insert ? `${lead}${insert}${token.slice(name.length)}` : whole;
	});
}

export const nextYes = '<<<NEXT:YES>>>';
export const nextNo = '<<<NEXT:NO>>>';

/**
 * A step's prompt when the step after it has a check: the agent is asked to
 * judge it once its work is done and to end with one of two marker lines,
 * which `nextDecision` reads. The check is the user's own words, filled with
 * the skill's parameters like the prompts.
 */
export function withNextDecision(prompt: string, check: string): string {
	return `${prompt}\n\nWhen you have finished the task above, check this: ${check}\nThen end your reply with a line of its own: ${nextYes} if the check passes, ${nextNo} if it does not. Write exactly one of the two, once, as the last line.`;
}

/**
 * The agent's answer to `withNextDecision`: the last marker line of the reply
 * — the last, as with the result markers, since a reply quoting the
 * instruction names both. Undefined when it wrote neither, which the caller
 * treats as "stop": going on was not asked for.
 */
export function nextDecision(reply: string): boolean | undefined {
	const lines = reply.split(/\r?\n/).map(line => line.trim().replace(/^[`*_]+|[`*_]+$/g, ''));
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] === nextYes) {
			return true;
		}
		if (lines[i] === nextNo) {
			return false;
		}
	}
	return undefined;
}

export const choiceMarker = (n: number) => `<<<CHOICE:${n}>>>`;

/**
 * A decision step's prompt: the task, then the options by number, and the
 * marker line to end with. The labels are the user's, checked to hold no
 * marker syntax (`validChoices`).
 */
export function withChoices(prompt: string, labels: readonly string[]): string {
	const options = labels.map((label, i) => `${i + 1}. ${label}`).join('\n');
	return `${prompt}\n\nWhen you have finished the task above, choose exactly one of these options:\n${options}\nThen end your reply with a line of its own: ${choiceMarker(1)} for option 1, ${choiceMarker(2)} for option 2, and so on. Write exactly one such line, once, as the last line.`;
}

/**
 * The option the agent chose, 0-based: the last marker line of the reply that
 * names one of the `count` options. Undefined when it chose none, which the
 * runner treats as the step failing.
 */
export function chosenOption(reply: string, count: number): number | undefined {
	const lines = reply.split(/\r?\n/).map(line => line.trim().replace(/^[`*_]+|[`*_]+$/g, ''));
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = /^<<<CHOICE:(\d{1,2})>>>$/.exec(lines[i]);
		if (match) {
			const n = Number(match[1]);
			return n >= 1 && n <= count ? n - 1 : undefined;
		}
	}
	return undefined;
}

/**
 * Whether the next step runs, once the one before it is over. Without a check,
 * always. With one, only when that step ended without an error — an
 * interrupted or failed step judged nothing — and the agent answered yes. The
 * reason is said when it does not.
 */
export function stepGate(check: string | undefined, error: string | undefined, reply: string): { go: true } | { go: false; why: string } {
	if (!check) {
		return { go: true };
	}
	if (error) {
		return { go: false, why: 'the step before it ended with an error, so the check was not made' };
	}
	const answer = nextDecision(reply);
	return answer === true ? { go: true }
		: answer === false ? { go: false, why: 'the check did not pass' }
			: { go: false, why: 'the agent did not say whether the check passed' };
}

export const resultStart = '<<<RESULT';
export const resultEnd = 'RESULT>>>';

/**
 * A clipboard run's prompt: the instruction before the prompt and again after
 * it. Once, at the end, it lost to the prompt's own wording — a skill named in
 * the prompt brings its own output format — and the model answered without
 * markers, so the whole reply, preamble and closing remarks included, went to
 * the clipboard. Markers rather than a code fence or JSON: a fence closes on
 * any code block inside the result, and JSON makes the model escape every
 * line break and quote of a multi-line text; the markers need neither.
 */
export function withResultMarkers(prompt: string, to: 'clipboard' | 'notification' = 'clipboard'): string {
	const where = to === 'clipboard'
		? { done: 'copied to the clipboard', kept: 'copied' }
		: { done: 'shown to the user in a short notification', kept: 'shown' };
	const rule = `put the final result, and nothing else, between a line ${resultStart} and a line ${resultEnd}, each marker on a line of its own. Everything between them is ${where.done} exactly as it stands, so do not wrap it in a code fence or add any comment inside; anything you say outside the markers is not ${where.kept}.`;
	return `This task runs in the background and its result is ${where.done}. When you are done, ${rule}\n\n${prompt}\n\nRemember: ${rule}`;
}

/** Where a clipboard result was found. */
export type ResultSource = 'markers' | 'fence';

/**
 * The part of a reply to copy: the text between the last pair of result
 * markers — the last, because a model quoting the instruction writes them
 * twice — without the line breaks that frame it and without a code fence
 * wrapping all of it; failing that, the last fenced code block of the reply,
 * which is where a model that ignored the markers usually puts the thing
 * asked for. Undefined when the reply has neither, and the caller copies it
 * whole.
 */
export function extractResult(reply: string): { text: string; source: ResultSource } | undefined {
	// A marker is a line of its own, as the prompt asks: a result that talks
	// about the markers — a commit message for this very feature did — names
	// them inside a sentence, and searching the text for them started the copy
	// there (#414). A pair written inline is still read when no line is one.
	const lines = reply.split(/\r?\n/);
	const endLine = lines.map(line => line.trim()).lastIndexOf(resultEnd);
	const startLine = endLine < 0 ? -1 : lines.slice(0, endLine).map(line => line.trim()).lastIndexOf(resultStart);
	if (startLine >= 0) {
		const inner = lines.slice(startLine + 1, endLine).join('\n');
		return { text: unwrapFence(inner) ?? inner, source: 'markers' };
	}
	const end = reply.lastIndexOf(resultEnd);
	const start = end < 0 ? -1 : reply.lastIndexOf(resultStart, end);
	if (start >= 0) {
		const inner = reply.slice(start + resultStart.length, end).replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
		return { text: unwrapFence(inner) ?? inner, source: 'markers' };
	}
	const blocks = fencedBlocks(reply);
	const last = blocks[blocks.length - 1];
	return last !== undefined && last.trim() ? { text: last, source: 'fence' } : undefined;
}

/** The inside of `text` when all of it is one fenced block, else undefined. */
function unwrapFence(text: string): string | undefined {
	const trimmed = text.trim();
	const blocks = fencedBlocks(trimmed);
	if (blocks.length !== 1) {
		return undefined;
	}
	const lines = trimmed.split(/\r?\n/);
	const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]);
	const close = lines[lines.length - 1].trim();
	return open && lines.length >= 2 && close[0] === open[1][0] && /^(`{3,}|~{3,})$/.test(close) && close.length >= open[1].length
		? blocks[0] : undefined;
}

/**
 * The contents of every fenced code block, in order: a line opening with
 * three or more backticks or tildes, closed by a line of at least as many of
 * the same character — so a shorter fence inside a longer one is content.
 * A block left open runs to the end, as Markdown reads it.
 */
function fencedBlocks(text: string): string[] {
	const out: string[] = [];
	let fence: string | undefined;
	let body: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (fence === undefined) {
			const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
				fence = open[1];
				body = [];
			}
			continue;
		}
		const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
		if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
			out.push(body.join('\n'));
			fence = undefined;
			continue;
		}
		body.push(line);
	}
	if (fence !== undefined) {
		out.push(body.join('\n'));
	}
	return out;
}

function text(value: unknown, limit: number): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.replace(/\s+/g, ' ').trim();
	return trimmed ? Array.from(trimmed).slice(0, limit).join('') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
