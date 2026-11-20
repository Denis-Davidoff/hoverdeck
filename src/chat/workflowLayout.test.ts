import * as assert from 'node:assert';
import { test } from 'node:test';
import { layoutWorkflow, type LayoutStep } from './workflowLayout.ts';

const step = (id: string, extra: Partial<LayoutStep> = {}): LayoutStep => ({
	id, title: id, kind: 'ai', onSuccess: { kind: 'next' }, onFailure: { kind: 'fail' }, ...extra,
});

test('a plain chain is straight lines and nothing else', () => {
	const layout = layoutWorkflow([step('0'), step('1'), step('2')]);
	assert.strictEqual(layout.edges.length, 2);
	assert.ok(layout.edges.every(e => !e.back && e.label === ''));
	assert.deepStrictEqual(layout.nodes.map(n => n.ends), [[], [], []]);
});

test('a route back goes left with its times, a skip goes right', () => {
	const layout = layoutWorkflow([
		step('0'),
		step('1', { kind: 'shell', onFailure: { kind: 'step', step: '0', times: 2 } }),
		step('2', { onSuccess: { kind: 'step', step: '3' } }),
		step('3'), step('4'),
	]);
	const back = layout.edges.find(e => e.back)!;
	assert.strictEqual(back.label, 'exit ≠ 0 ×2');
	assert.strictEqual(back.anchor, 'end');
	const skip = layout.edges.find(e => e.from === 2 && e.to === 3)!;
	assert.strictEqual(skip.label, '');
});

test('overlapping routes get separate lanes', () => {
	const layout = layoutWorkflow([
		step('0'), step('1'),
		step('2', { onFailure: { kind: 'step', step: '0', times: 1 } }),
		step('3', { onFailure: { kind: 'step', step: '1', times: 3 } }),
	]);
	const backs = layout.edges.filter(e => e.back);
	assert.strictEqual(backs.length, 2);
	const laneOf = (p: string) => Number(p.split(' ')[4]);
	assert.notStrictEqual(laneOf(backs[0].path), laneOf(backs[1].path));
});

test('choices: ends written in the node, one going on drawn straight with its label', () => {
	const layout = layoutWorkflow([
		step('0', {
			kind: 'decide', choices: [
				{ label: 'Ship', route: { kind: 'next' } },
				{ label: 'Stop', route: { kind: 'done' } },
				{ label: 'Retry', route: { kind: 'step', step: '0', times: 1 } },
			],
		}),
		step('1'),
	]);
	assert.deepStrictEqual(layout.nodes[0].ends, ['Stop → finish']);
	assert.strictEqual(layout.edges.find(e => !e.back)!.label, 'Ship');
	const self = layout.edges.find(e => e.back)!;
	assert.strictEqual(self.from, 0);
	assert.strictEqual(self.label, 'Retry ×1');
});

test('only non-default ends are written', () => {
	const layout = layoutWorkflow([step('0', { onSuccess: { kind: 'done' }, onFailure: { kind: 'done' } }), step('1')]);
	assert.deepStrictEqual(layout.nodes[0].ends, ['done → finish', 'error → finish']);
	assert.deepStrictEqual(layout.nodes[1].ends, []);
});
