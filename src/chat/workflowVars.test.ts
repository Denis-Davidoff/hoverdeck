/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { capTail, envValueLimit, fillVars, shellEnv, type StepRecord } from './workflowVars.ts';
import { fillPrompt, validToolbarSkill } from './toolbarText.ts';
import type { ToolbarSkill } from './chatProtocol';

const records: StepRecord[] = [
	{ number: 1, name: 'test', output: { stdout: 'FAIL a.ts', stderr: 'oops', exitCode: 1 } },
	{ number: 2, name: 'fix', output: { reply: 'Fixed it.' } },
];

test('a prompt reads a step by name, number and prev, and a parameter', () => {
	assert.strictEqual(fillVars('{{steps.test.stdout}} / {{steps.1.exitCode}} / {{steps.prev.reply}} / {{params.branch}}', { branch: 'main' }, records),
		'FAIL a.ts / 1 / Fixed it. / main');
	assert.strictEqual(fillVars('{{steps.fix.output}} {{steps.test.output}}', {}, records), 'Fixed it. FAIL a.ts');
});

test('a reference to a step not run, or a field it lacks, is left as written', () => {
	assert.strictEqual(fillVars('{{steps.commit.stdout}} {{steps.fix.stdout}} {{steps.9.reply}} {{params.nope}}', {}, records),
		'{{steps.commit.stdout}} {{steps.fix.stdout}} {{steps.9.reply}} {{params.nope}}');
});

test('the latest run of a step that ran twice is read', () => {
	const again = [...records, { number: 1, name: 'test', output: { stdout: 'ok', exitCode: 0 } }];
	assert.strictEqual(fillVars('{{steps.test.stdout}}', {}, again), 'ok');
	assert.strictEqual(shellEnv({}, again).STEP_TEST_STDOUT, 'ok');
});

test('a shell step gets values as environment variables only', () => {
	const env = shellEnv({ 'my-param': '$(rm -rf ~)' }, records);
	assert.strictEqual(env.PARAM_MY_PARAM, '$(rm -rf ~)');
	assert.strictEqual(env.STEP_1_STDOUT, 'FAIL a.ts');
	assert.strictEqual(env.STEP_TEST_EXITCODE, '1');
	assert.strictEqual(env.STEP_FIX_REPLY, 'Fixed it.');
	assert.strictEqual(env.STEP_PREV_OUTPUT, 'Fixed it.');
	assert.strictEqual(env.STEP_FIX_STDOUT, undefined);
});

test('values are cut to their tail, never inside a surrogate pair', () => {
	const long = 'x'.repeat(envValueLimit) + 'END';
	const cut = shellEnv({ p: long }, []).PARAM_P;
	assert.ok(cut.endsWith('END') && cut.startsWith('[… 3 characters cut]'));
	const emoji = 'a' + '😀'.repeat(5);
	assert.ok(!/^[\udc00-\udfff]/.test(capTail(emoji, 3).split('\n')[1]));
});

const base = { id: 'w1', name: 'ship', prompt: 'npm test', followUps: [{ prompt: 'Fix: {{steps.test.stdout}} for {{branch}}' }], result: 'silent', params: [{ name: 'branch', type: 'text' }] };

test('a workflow keeps its kinds and names, aligned past a dropped blank step', () => {
	const skill = validToolbarSkill({ ...base, followUps: [{ prompt: '' }, { prompt: 'git push' }], workflow: [{ shell: true, name: 'test' }, {}, { shell: true, name: 'push' }] });
	assert.ok(typeof skill !== 'string');
	assert.deepStrictEqual(skill.workflow, [{ shell: true, name: 'test' }, { shell: true, name: 'push' }]);
});

test('a workflow is refused where it cannot run', () => {
	assert.match(validToolbarSkill({ ...base, result: 'chat', workflow: [{ shell: true }] }) as string, /background/);
	assert.match(validToolbarSkill({ ...base, workflow: [{ name: 'a' }, { name: 'a' }] }) as string, /Two steps/);
	assert.match(validToolbarSkill({ ...base, workflow: [{ name: 'Bad' }] }) as string, /name/);
	assert.match(validToolbarSkill({ ...base, workflow: [{ name: 'prev' }] }) as string, /prev/);
	assert.match(validToolbarSkill({ ...base, followUps: [{ prompt: 'x', check: 'tests pass' }], workflow: [{ shell: true }] }) as string, /check/);
	// No shell and no name: an ordinary skill.
	assert.strictEqual((validToolbarSkill({ ...base, workflow: [{}, {}] }) as ToolbarSkill).workflow, undefined);
});

test('a shell command is never filled in; a prompt is', () => {
	const skill = validToolbarSkill({ ...base, prompt: 'git checkout {{branch}}', workflow: [{ shell: true, name: 'test' }] }) as ToolbarSkill;
	const filled = fillPrompt(skill, { branch: 'x; rm -rf ~' });
	assert.ok('steps' in filled);
	assert.deepStrictEqual(filled.steps[0], { text: 'git checkout {{branch}}', shell: true, name: 'test' });
	assert.strictEqual(filled.steps[1].text, 'Fix: {{steps.test.stdout}} for x; rm -rf ~');
});

const decide = { id: 'w2', name: 'triage', prompt: 'Is it a bug?', followUps: [{ prompt: 'Fix it.' }, { prompt: 'Explain.' }], result: 'silent' };
const choices = [{ label: 'Bug', route: { to: 'next' } }, { label: 'Not a bug', route: { to: 'step', step: 2 } }];

test('a workflow with routes and choices reads back as it was saved', () => {
	const saved = validToolbarSkill({ ...decide, workflow: [{ name: 'ask', choices, onFailure: { to: 'done' } }, { onSuccess: { to: 'done' } }, {}] }) as ToolbarSkill;
	assert.ok(typeof saved !== 'string');
	assert.deepStrictEqual(saved.workflow?.[0].choices?.map(c => c.route), [{ to: 'next' }, { to: 'step', step: 2 }]);
	assert.deepStrictEqual(saved.workflow?.[1].onSuccess, { to: 'done' });
	// Reading it back runs the same check over what was stored.
	assert.deepStrictEqual(validToolbarSkill(saved), saved);
});

test('a decision cannot put its result in the chat, nor be followed by a check', () => {
	assert.match(validToolbarSkill({ ...decide, result: 'chat', workflow: [{ choices }, {}, {}] }) as string, /chat|background/);
	assert.match(validToolbarSkill({ ...decide, followUps: [{ prompt: 'Fix it.', check: 'is it fixed' }, { prompt: 'Explain.' }], workflow: [{ choices }, {}, {}] }) as string, /decision/);
});
