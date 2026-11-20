import * as assert from 'node:assert';
import { test } from 'node:test';
import type { ToolbarSkill } from './chatProtocol';
import { skillDescription, skillDocument, skillNotFound, skillOfferedTo, skillSummary } from './skillCatalog.ts';

const base = (over: Partial<ToolbarSkill>): ToolbarSkill => ({
	id: 's1', name: 'review', prompt: '# \nReview the diff\nthen more', agents: 'all', result: 'chat', icon: 'eye', params: [], ...over,
} as ToolbarSkill);

test('description: tooltip, else label, else the first prompt line that is not a bare heading', () => {
	assert.strictEqual(skillDescription(base({ tooltip: 'Look  at\nchanges' })), 'Look at changes');
	assert.strictEqual(skillDescription(base({ label: 'Rev' })), 'Rev');
	assert.strictEqual(skillDescription(base({})), 'Review the diff');
	assert.ok(skillDescription(base({ tooltip: 'x'.repeat(400) })).length <= 300);
});

test('offered: all, unknown agent, or the same agent', () => {
	assert.ok(skillOfferedTo(base({}), 'codex'));
	assert.ok(skillOfferedTo(base({ agents: 'claude' } as Partial<ToolbarSkill>), undefined));
	assert.ok(skillOfferedTo(base({ agents: 'claude' } as Partial<ToolbarSkill>), 'claude'));
	assert.ok(!skillOfferedTo(base({ agents: 'claude' } as Partial<ToolbarSkill>), 'codex'));
});

test('summary names params, steps and shell steps', () => {
	const s = skillSummary(base({
		params: [{ name: 'file', type: 'text', maxLength: 100, preset: '' }],
		followUps: [{ prompt: 'npm test' }],
		workflow: [{}, { shell: true }],
	} as Partial<ToolbarSkill>));
	assert.deepStrictEqual(s, { name: 'review', description: 'Review the diff', params: ['file'], steps: 2, workflow: true, shellSteps: 1 });
});

test('document lists every step with its kind, check and routes', () => {
	const d = skillDocument(base({
		followUps: [{ prompt: 'npm test', check: 'the review found nothing' }],
		workflow: [{ name: 'look' }, { shell: true, onFailure: { to: 'step', step: 0, times: 2, whenSpent: 'fail' } }],
	} as Partial<ToolbarSkill>));
	assert.strictEqual(d.steps.length, 2);
	assert.deepStrictEqual(d.steps[0], { step: 1, name: 'look', kind: 'prompt', prompt: '# \nReview the diff\nthen more', onSuccess: 'go on to the next step', onFailure: 'stop: the skill failed' });
	const second = d.steps[1] as Record<string, unknown>;
	assert.strictEqual(second.kind, 'shell');
	assert.strictEqual(second.command, 'npm test');
	assert.match(String(second.onlyIf), /the review found nothing/);
	assert.match(String(second.onFailure), /go to step 1 \(at most 2 times/);
	assert.match(d.instruction, /your own approvals/);
});

test('decision steps carry their choices', () => {
	const d = skillDocument(base({ workflow: [{ choices: [{ label: 'Yes', route: { to: 'done' } }, { label: 'No', route: { to: 'next' } }] }] } as Partial<ToolbarSkill>));
	const step = d.steps[0] as Record<string, unknown>;
	assert.strictEqual(step.kind, 'decision');
	assert.deepStrictEqual(step.choices, [{ option: 1, label: 'Yes', then: 'stop: the skill is done' }, { option: 2, label: 'No', then: 'go on to the next step' }]);
});

test('an unknown name lists what there is', () => {
	assert.match(skillNotFound('x', ['a', 'b']), /Available skills: a, b/);
	assert.match(skillNotFound('x', []), /saved none/);
});
