import * as assert from 'node:assert';
import { test } from 'node:test';
import { executionBound, maxBackTimes, nextStep, RouteCounters, routeCanEnd, routeProblems, successLeads, type RoutedStep, type RouteTarget, type StepOutcome } from './workflowGraph.ts';

const next: RouteTarget = { kind: 'next' };
const fail: RouteTarget = { kind: 'fail' };
const to = (step: string, times?: number, whenSpent?: 'fail' | 'next'): RouteTarget => ({ kind: 'step', step, times, whenSpent });
const step = (id: string, onSuccess: RouteTarget = next, onFailure: RouteTarget = fail, kind: RoutedStep['kind'] = 'shell'): RoutedStep => ({ id, kind, onSuccess, onFailure });

/** test → fix → test, at most three times. */
const testFix: RoutedStep[] = [
	step('test', to('commit'), to('fix')),
	step('fix', to('test', 3), fail, 'ai'),
	step('commit'),
];

const ok: StepOutcome = { kind: 'success' };
const bad: StepOutcome = { kind: 'failure' };

test('a route back needs a limit of 1 to 3', () => {
	assert.deepStrictEqual(routeProblems(testFix), []);
	assert.match(routeProblems([step('a'), step('b', to('a'))]).join(), /how many times/);
	assert.match(routeProblems([step('a'), step('b', to('a', 4))]).join(), /1 to 3/);
	assert.match(routeProblems([step('a'), step('b', to('a', 1.5))]).join(), /1 to 3/);
	assert.deepStrictEqual(routeProblems([step('a', next, to('a', 2))]), [], 'retrying a step itself is a route back');
});

test('a route forward takes no limit, and unknown steps and duplicates are refused', () => {
	assert.match(routeProblems([step('a', to('b', 2)), step('b')]).join(), /cannot repeat/);
	assert.match(routeProblems([step('a', to('nope'))]).join(), /not a step/);
	assert.match(routeProblems([step('a'), step('a')]).join(), /Two steps/);
	assert.match(routeProblems([{ id: 'd', kind: 'decide', onSuccess: next, onFailure: fail, choices: [{ label: 'x', route: next }] }]).join(), /fewer than two/);
});

test('fix is tried three times, then the run fails saying why', () => {
	const c = new RouteCounters();
	assert.deepStrictEqual(nextStep(testFix, 0, bad, c), { kind: 'step', index: 1, back: false });
	for (let n = 1; n <= 3; n++) {
		assert.deepStrictEqual(nextStep(testFix, 1, ok, c), { kind: 'step', index: 0, back: true, taken: n, times: 3 });
		assert.strictEqual(nextStep(testFix, 0, bad, c).kind, 'step');
	}
	const end = nextStep(testFix, 1, ok, c);
	assert.strictEqual(end.kind, 'fail');
	assert.match((end as { why: string }).why, /3 times already/);
});

test('a spent route back can go on instead of failing', () => {
	const steps = [step('a'), step('b', to('a', 1, 'next')), step('c')];
	const c = new RouteCounters();
	assert.strictEqual(nextStep(steps, 1, ok, c).kind, 'step');
	assert.deepStrictEqual(nextStep(steps, 1, ok, c), { kind: 'step', index: 2, back: false });
});

test('next after the last step and done end the run', () => {
	assert.deepStrictEqual(nextStep(testFix, 2, ok, new RouteCounters()), { kind: 'done' });
	assert.deepStrictEqual(nextStep([step('a', { kind: 'done' })], 0, ok, new RouteCounters()), { kind: 'done' });
});

test('a decision step routes by its choice', () => {
	const steps: RoutedStep[] = [
		step('fix', next, fail, 'ai'),
		{ id: 'review', kind: 'decide', onSuccess: next, onFailure: fail, choices: [{ label: 'ready', route: next }, { label: 'needs work', route: to('fix', 2) }] },
		step('commit'),
	];
	assert.deepStrictEqual(routeProblems(steps), []);
	const c = new RouteCounters();
	assert.deepStrictEqual(nextStep(steps, 1, { kind: 'choice', index: 1 }, c), { kind: 'step', index: 0, back: true, taken: 1, times: 2 });
	assert.deepStrictEqual(nextStep(steps, 1, { kind: 'choice', index: 0 }, c), { kind: 'step', index: 2, back: false });
	assert.strictEqual(nextStep(steps, 1, { kind: 'choice', index: 5 }, c).kind, 'fail');
});

test('the bound is steps × (1 + Σ times)', () => {
	assert.strictEqual(executionBound(testFix), 3 * (1 + 3));
	assert.strictEqual(executionBound([step('a'), step('b')]), 2);
});

test('every valid workflow ends within its bound, whatever the outcomes', () => {
	let seed = 7;
	const rnd = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed % n;
	};
	let checked = 0;
	for (let w = 0; w < 3000; w++) {
		const n = 1 + rnd(6);
		const ids = Array.from({ length: n }, (_, i) => `s${i}`);
		const route = (i: number): RouteTarget => {
			switch (rnd(5)) {
				case 0: return next;
				case 1: return fail;
				case 2: return { kind: 'done' };
				default: {
					const t = rnd(n);
					return t <= i ? to(ids[t], 1 + rnd(maxBackTimes), rnd(2) ? 'next' : 'fail') : to(ids[t]);
				}
			}
		};
		const steps: RoutedStep[] = ids.map((id, i) => rnd(4) === 0
			? { id, kind: 'decide', onSuccess: next, onFailure: route(i), choices: [{ label: 'a', route: route(i) }, { label: 'b', route: route(i) }] }
			: step(id, route(i), route(i)));
		if (routeProblems(steps).length) {
			continue;
		}
		checked++;
		const bound = executionBound(steps);
		const c = new RouteCounters();
		let at = 0;
		for (;;) {
			assert.ok(c.execute(bound), `ran past its bound of ${bound}`);
			const s = steps[at];
			const outcome: StepOutcome = s.kind === 'decide' ? (rnd(3) ? { kind: 'choice', index: rnd(2) } : bad) : rnd(2) ? ok : bad;
			const r = nextStep(steps, at, outcome, c);
			if (r.kind !== 'step') {
				break;
			}
			at = r.index;
		}
	}
	assert.ok(checked > 1000, `only ${checked} workflows were valid`);
});

test('a decision step\'s failure route is checked and counted', () => {
	const done: RouteTarget = { kind: 'done' };
	const decide = (onFailure: RouteTarget): RoutedStep => ({ id: 'd', kind: 'decide', onSuccess: { kind: 'next' }, onFailure, choices: [{ label: 'yes', route: done }, { label: 'no', route: done }] });
	const first: RoutedStep = { id: 'a', kind: 'ai', onSuccess: { kind: 'next' }, onFailure: { kind: 'fail' } };
	assert.match(routeProblems([first, decide({ kind: 'step', step: 'a' })]).join(), /on failure goes back/);
	const steps = [first, decide({ kind: 'step', step: 'a', times: 3 })];
	assert.deepStrictEqual(routeProblems(steps), []);
	const bound = executionBound(steps);
	assert.strictEqual(bound, 8);
	const c = new RouteCounters();
	let at = 0;
	for (;;) {
		assert.ok(c.execute(bound), `ran past its bound of ${bound}`);
		const r = nextStep(steps, at, steps[at].kind === 'decide' ? { kind: 'failure' } : { kind: 'success' }, c);
		if (r.kind !== 'step') {
			assert.strictEqual(r.kind, 'fail');
			break;
		}
		at = r.index;
	}
	assert.strictEqual(c.executed, 8);
});

test('successLeads: where a success would go, without counting', () => {
	const ok = (id: string, onSuccess: RouteTarget): RoutedStep => ({ id, kind: 'ai', onSuccess, onFailure: { kind: 'fail' } });
	const steps = [
		ok('a', { kind: 'next' }),
		ok('b', { kind: 'step', step: 'd' }),
		ok('c', { kind: 'step', step: 'a', times: 1, whenSpent: 'next' }),
		ok('d', { kind: 'done' }),
	];
	const counters = new RouteCounters();
	assert.equal(successLeads(steps, 0, counters), 'next');
	assert.equal(successLeads(steps, 1, counters), 'elsewhere');
	assert.equal(successLeads(steps, 2, counters), 'elsewhere');
	assert.equal(counters.taken('c:ok'), 0);
	counters.take('c:ok');
	assert.equal(successLeads(steps, 2, counters), 'next');
	assert.equal(successLeads(steps, 3, counters), 'end');
	assert.equal(successLeads([ok('x', { kind: 'step', step: 'y' }), ok('y', { kind: 'next' })], 0, new RouteCounters()), 'next');
});

test('routeCanEnd: done anywhere, next or a spendable route back only from the last step', () => {
	assert.equal(routeCanEnd({ kind: 'done' }, false), true);
	assert.equal(routeCanEnd({ kind: 'next' }, false), false);
	assert.equal(routeCanEnd({ kind: 'next' }, true), true);
	assert.equal(routeCanEnd({ kind: 'fail' }, true), false);
	assert.equal(routeCanEnd({ kind: 'step', step: 'a', times: 1, whenSpent: 'next' }, true), true);
	assert.equal(routeCanEnd({ kind: 'step', step: 'a', times: 1 }, true), false);
});
