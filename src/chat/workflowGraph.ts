/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How a workflow moves from step to step, and why it always ends.
 *
 * A workflow is a list of steps. After a step, its outcome (success, failure,
 * or the choice a decision step made) names a route: on to the next step,
 * forward to a later one, back to an earlier one (or to itself), or the end —
 * done or failed.
 *
 * **Only a route back can make a loop, so only a route back carries a limit**
 * (`times`, 1 to {@link maxBackTimes}). A route forward cannot repeat
 * anything. Each route back is counted per run and the counters are never
 * reset, not even when an outer loop comes round again: a route taken its
 * `times` times is spent for the rest of the run, and the step then ends the
 * run as failed (or goes on, if `whenSpent` says so). That is what makes the
 * bound provable — between two routes back the run only moves forward, so it
 * runs at most `steps × (1 + Σ times)` steps ({@link executionBound}), and
 * the runner checks that number as well, in case a future route kind forgets.
 *
 * A leaf module with no `vscode` and no relative value imports, so `npm test`
 * loads it directly.
 */

/** A route back may be taken at most this many times in a run. Asked for: "3 раза максимум". */
export const maxBackTimes = 3;

export type WorkflowStepKind = 'ai' | 'shell' | 'decide';

export type RouteTarget =
	| { kind: 'next' }
	| { kind: 'done' }
	| { kind: 'fail' }
	/** Another step by id, before or after this one, or this one again. */
	| { kind: 'step'; step: string; times?: number; whenSpent?: 'fail' | 'next' };

export interface RoutedStep {
	readonly id: string;
	readonly kind: WorkflowStepKind;
	readonly onSuccess: RouteTarget;
	readonly onFailure: RouteTarget;
	/** A decision step's choices, each with its own route. */
	readonly choices?: readonly { readonly label: string; readonly route: RouteTarget }[];
}

/** Which way a step went. A decision step reports the index of the choice. */
export type StepOutcome = { kind: 'success' } | { kind: 'failure' } | { kind: 'choice'; index: number };

export type RouteResult =
	| { kind: 'step'; index: number; back: boolean; taken?: number; times?: number }
	| { kind: 'done' }
	| { kind: 'fail'; why: string };

/** What a run remembers between steps: how often each route back has been taken. */
export class RouteCounters {
	private readonly _taken = new Map<string, number>();
	private _executed = 0;

	taken(key: string): number {
		return this._taken.get(key) ?? 0;
	}

	take(key: string): number {
		const n = this.taken(key) + 1;
		this._taken.set(key, n);
		return n;
	}

	/** Counts one step about to run; false past the bound. */
	execute(bound: number): boolean {
		this._executed++;
		return this._executed <= bound;
	}

	get executed(): number {
		return this._executed;
	}
}

function routeOf(step: RoutedStep, outcome: StepOutcome): { route: RouteTarget; key: string } | undefined {
	switch (outcome.kind) {
		case 'success': return { route: step.onSuccess, key: `${step.id}:ok` };
		case 'failure': return { route: step.onFailure, key: `${step.id}:fail` };
		case 'choice': {
			const choice = step.choices?.[outcome.index];
			return choice && { route: choice.route, key: `${step.id}:choice:${outcome.index}` };
		}
	}
}

/** Every route of a step, labelled for messages. */
function routesOf(step: RoutedStep): { route: RouteTarget; label: string }[] {
	if (step.kind === 'decide') {
		// A reply with no valid choice is a failure and takes `onFailure`
		// (`nextStep`), so that route is checked and counted like the choices.
		return [
			...(step.choices ?? []).map(choice => ({ route: choice.route, label: `choice "${choice.label}"` })),
			{ route: step.onFailure, label: 'on failure' },
		];
	}
	return [{ route: step.onSuccess, label: 'on success' }, { route: step.onFailure, label: 'on failure' }];
}

/**
 * The problems of a workflow's routing, empty when it can run. A route to an
 * unknown step, a route back with no limit or a limit over
 * {@link maxBackTimes}, and a decision step with fewer than two choices are
 * refused; a limit on a route forward is meaningless and refused too, so that
 * what the editor shows is what runs.
 */
export function routeProblems(steps: readonly RoutedStep[]): string[] {
	const problems: string[] = [];
	const index = new Map<string, number>();
	steps.forEach((step, i) => {
		if (index.has(step.id)) {
			problems.push(`Two steps are called "${step.id}".`);
		}
		index.set(step.id, i);
	});
	steps.forEach((step, i) => {
		if (step.kind === 'decide' && (step.choices?.length ?? 0) < 2) {
			problems.push(`Step "${step.id}" decides between fewer than two choices.`);
		}
		for (const { route, label } of routesOf(step)) {
			if (route.kind !== 'step') {
				continue;
			}
			const target = index.get(route.step);
			if (target === undefined) {
				problems.push(`Step "${step.id}" ${label} goes to "${route.step}", which is not a step.`);
				continue;
			}
			if (target <= i) {
				if (!isTimes(route.times)) {
					problems.push(`Step "${step.id}" ${label} goes back to "${route.step}": say how many times, 1 to ${maxBackTimes}.`);
				}
			} else if (route.times !== undefined || route.whenSpent !== undefined) {
				problems.push(`Step "${step.id}" ${label} goes forward to "${route.step}", which cannot repeat: it takes no limit.`);
			}
		}
	});
	return problems;
}

function isTimes(n: unknown): n is number {
	return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= maxBackTimes;
}

/**
 * The most steps a run of this workflow can execute: between two routes back
 * a run only moves forward, so `steps × (1 + Σ times)`. Shown in the editor
 * ("runs at most N steps") and enforced by the runner.
 */
export function executionBound(steps: readonly RoutedStep[]): number {
	let back = 0;
	steps.forEach((step, i) => {
		for (const { route } of routesOf(step)) {
			if (route.kind === 'step' && isTimes(route.times) && steps.findIndex(s => s.id === route.step) <= i) {
				back += route.times;
			}
		}
	});
	return steps.length * (1 + back);
}

/**
 * Where step `from`'s success would take the run now, without counting anything:
 * `'next'` when it arrives at the step after it in order (so that step's check is
 * asked of this one), `'end'` when the run ends done, `'elsewhere'` otherwise.
 * The same rule as {@link nextStep}, which the runner calls after the step.
 */
export function successLeads(steps: readonly RoutedStep[], from: number, counters: RouteCounters): 'next' | 'end' | 'elsewhere' {
	const step = steps[from];
	if (!step || step.choices) { return 'elsewhere'; }
	const inOrder = () => from + 1 < steps.length ? 'next' as const : 'end' as const;
	const route = step.onSuccess;
	switch (route.kind) {
		case 'next': return inOrder();
		case 'done': return 'end';
		case 'fail': return 'elsewhere';
		case 'step': {
			const target = steps.findIndex(s => s.id === route.step);
			if (target < 0) { return 'elsewhere'; }
			if (target > from) { return target === from + 1 ? 'next' : 'elsewhere'; }
			if (!isTimes(route.times)) { return 'elsewhere'; }
			return counters.taken(`${step.id}:ok`) >= route.times && route.whenSpent === 'next' ? inOrder() : 'elsewhere';
		}
	}
}

/** Whether `route`, taken from the last step, can end the run done (directly or once a route back is spent). */
export function routeCanEnd(route: RouteTarget, last: boolean): boolean {
	return route.kind === 'done' || (last && (route.kind === 'next' || (route.kind === 'step' && route.whenSpent === 'next')));
}

/**
 * Where a run goes after step `from` ended with `outcome`. Counts a route
 * back in `counters`; a route back that is spent ends the run as failed, or
 * goes on to the next step when it says `whenSpent: 'next'`. Assumes
 * {@link routeProblems} found nothing, and refuses rather than guesses when
 * that was not so.
 */
export function nextStep(steps: readonly RoutedStep[], from: number, outcome: StepOutcome, counters: RouteCounters): RouteResult {
	const step = steps[from];
	const found = step && routeOf(step, outcome);
	if (!found) {
		return { kind: 'fail', why: 'The step ended with an outcome it has no route for.' };
	}
	const { route, key } = found;
	switch (route.kind) {
		case 'next':
			return from + 1 < steps.length ? { kind: 'step', index: from + 1, back: false } : { kind: 'done' };
		case 'done':
			return { kind: 'done' };
		case 'fail':
			return { kind: 'fail', why: outcome.kind === 'failure' ? `Step "${step.id}" failed.` : `Step "${step.id}" ended the workflow.` };
		case 'step': {
			const target = steps.findIndex(s => s.id === route.step);
			if (target < 0) {
				return { kind: 'fail', why: `Step "${route.step}" does not exist.` };
			}
			if (target > from) {
				return { kind: 'step', index: target, back: false };
			}
			if (!isTimes(route.times)) {
				return { kind: 'fail', why: `The route back to "${route.step}" has no limit.` };
			}
			if (counters.taken(key) >= route.times) {
				if (route.whenSpent === 'next') {
					return from + 1 < steps.length ? { kind: 'step', index: from + 1, back: false } : { kind: 'done' };
				}
				return { kind: 'fail', why: `Went back to "${route.step}" ${route.times} ${route.times === 1 ? 'time' : 'times'} already, and step "${step.id}" still ${outcome.kind === 'failure' ? 'fails' : 'asks for it'}.` };
			}
			const taken = counters.take(key);
			return { kind: 'step', index: target, back: true, taken, times: route.times };
		}
	}
}
