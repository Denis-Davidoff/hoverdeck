import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { SkillAgents } from './skillAgents.ts';
import * as text from './toolbarText.ts';
import { codexEvents } from './agentProtocol.ts';
import * as vars from './workflowVars.ts';
import * as graph from './workflowGraph.ts';
import type { AgentEvent } from './agentProtocol.ts';
import type { ToolbarRuns as Runs } from './toolbarRun.ts';
import type { AgentBackend } from './agents.ts';
import type { ToolbarSkill } from './chatProtocol.ts';

function fixture(check?: string, custom?: { skill: Partial<ToolbarSkill>; steps: text.FilledStep[] }) {
	const timers = new Map<number, () => void>();
	let timerId = 0;
	let listener: (event: AgentEvent) => void = () => {};
	const sent: string[] = [];
	const session = {
		running: false, disposed: false, ref: undefined,
		onEvent(fn: typeof listener) { listener = fn; return { dispose() {} }; },
		send(input: { text: string }) { sent.push(input.text); this.running = true; return Promise.resolve(true); },
		stop() {}, answer() {}, dispose() { this.disposed = true; this.running = false; },
	};
	const exports: { ToolbarRuns?: typeof Runs } = {};
	const require = (name: string): unknown => {
		switch (name) {
			case 'vscode': return { l10n: { t: (s: string) => s }, env: { clipboard: { writeText: async () => {} } } };
			case './skillAgents': return { SkillAgents };
			case './toolbarText': return text;
			case './workflowVars': return vars;
			case './workflowGraph': return graph;
			case './shellStep': return { ShellStepSession: class { } };
			case './chatTab': return { approvalKey: () => 'terminal' };
			case '../core/notify': return { confirm() {} };
			case '../core/notifyText': return { capAt: (s: string, n: number) => s.slice(0, n) };
			default: throw new Error(name);
		}
	};
	const source = readFileSync(resolve('src/chat/toolbarRun.ts'), 'utf8');
	runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
		exports, require, setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
	});
	const ended: { status: string; message?: string }[] = [];
	const runs = new exports.ToolbarRuns!({ approvalMode: () => 'auto', noteServer() {}, changed() {}, ended(_skill: unknown, end: { status: string; message?: string }) { ended.push(end); } });
	const skill = { id: 'test', name: 'test', prompt: 'one', result: 'silent', agents: 'all', icon: 'play', params: [], ...custom?.skill } as ToolbarSkill;
	runs.start(skill, custom?.steps ?? [{ text: 'one' }, { text: 'two', check }], {}, 'chat', { id: 'codex', openSession: () => session } as unknown as AgentBackend, 'model', 'low', '/tmp', undefined);
	return {
		runs, session, sent, ended,
		emit(event: AgentEvent) {
			if (event.type === 'turnEnd') { session.running = false; }
			if (event.type === 'autoTurn') { session.running = true; }
			listener(event);
		},
		tick() { const pending = [...timers]; for (const [id, fn] of pending) { if (timers.delete(id)) { fn(); } } },
	};
}

const child = (id: string): AgentEvent => ({ type: 'tool', id, tool: { kind: 'agent', name: 'Agent', agent: { background: true, threadId: id } } });

test('next prompt waits for every child and the parent automatic follow-up', () => {
	const f = fixture('passed');
	f.emit(child('one')); f.emit(child('two'));
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.equal(f.sent.length, 1);
	f.emit({ type: 'toolUpdate', id: 'one', update: { status: 'done' } }); f.tick();
	assert.equal(f.sent.length, 1);
	f.emit({ type: 'agentStates', states: [{ threadId: 'two', status: 'done' }] });
	f.emit({ type: 'autoTurn' }); f.tick();
	assert.equal(f.sent.length, 1);
	f.emit({ type: 'text', text: text.nextYes });
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.equal(f.sent.length, 2);
	assert.equal(f.sent[1], 'two');
	f.runs.dispose();
});

test('stopping while waiting cancels the pending next prompt', () => {
	const f = fixture();
	f.emit(child('one')); f.emit({ type: 'turnEnd' }); f.tick();
	f.runs.dispose();
	f.emit({ type: 'toolUpdate', id: 'one', update: { status: 'done' } }); f.tick();
	assert.equal(f.sent.length, 1);
	assert.equal(f.session.disposed, true);
});

test('failure does not start another prompt; ordinary success still advances', () => {
	const failed = fixture();
	failed.emit(child('one')); failed.emit({ type: 'turnEnd', error: 'Failed' }); failed.tick();
	assert.equal(failed.sent.length, 1);
	assert.equal(failed.session.disposed, true);
	failed.runs.dispose();
	const success = fixture();
	success.emit({ type: 'turnEnd' }); success.tick();
	assert.equal(success.sent.length, 2);
	success.runs.dispose();
});

test('chat queue stays blocked while child agents are running', () => {
	const source = readFileSync(resolve('src/chat/chatTab.ts'), 'utf8');
	const getter = /public get readyForQueued\(\): boolean \{[\s\S]*?\n\t\}/.exec(source)?.[0];
	assert.ok(getter);
	const prototype = runInNewContext(transpileModule(`({ ${getter.replace('public ', '')} })`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText, { ChatTab: { _due: (q: { at?: number }, now: number) => q.at === undefined || q.at <= now }, Date });
	const ready = Object.getOwnPropertyDescriptor(prototype, 'readyForQueued')!.get!;
	const state = { _queued: [{}], running: false, _pending: [], _waiting: [], waiting: false, agentsRunning: 1,
		get busy() { return this.running || this._pending.length > 0 || this.agentsRunning > 0; } };
	assert.equal(ready.call(state), false);
	state.agentsRunning = 0;
	assert.equal(ready.call(state), true);
});

for (const legacy of [false, true]) {
	test(`next prompt waits for ${legacy ? 'legacy spawnAgent' : 'restarted agent thread'}`, () => {
		const f = fixture();
		const report = (kind: string) => {
			for (const event of codexEvents('item/started', { item: { type: 'subAgentActivity', id: 'report', kind, agentThreadId: 'thread', agentPath: '/root/worker' } })) { f.emit(event); }
		};
		if (legacy) {
			for (const event of codexEvents('item/started', { item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['thread'] } })) { f.emit(event); }
		} else {
			report('started'); report('completed'); report('started');
		}
		f.emit({ type: 'turnEnd' }); f.tick();
		assert.equal(f.sent.length, 1);
		if (legacy) { f.emit({ type: 'agentStates', states: [{ threadId: 'thread', status: 'done' }] }); }
		else { report('completed'); }
		f.tick();
		assert.equal(f.sent.length, 2);
		f.runs.dispose();
	});
}

test('a route back re-runs an earlier step at most its times, then fails', async () => {
	const f = fixture(undefined, {
		skill: { workflow: [{}, { onFailure: { to: 'step', step: 0, times: 2 } }] },
		steps: [{ text: 'build' }, { text: 'test', onFailure: { to: 'step', step: 0, times: 2 } }],
	});
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.deepEqual(f.sent, ['build', 'test']);
	for (let round = 0; round < 2; round++) {
		f.emit({ type: 'turnEnd', error: 'tests failed' }); f.tick();
		f.emit({ type: 'turnEnd' }); f.tick();
	}
	assert.deepEqual(f.sent, ['build', 'test', 'build', 'test', 'build', 'test']);
	f.emit({ type: 'turnEnd', error: 'tests failed' }); f.tick(); await Promise.resolve();
	assert.equal(f.sent.length, 6);
	assert.equal(f.ended[0]?.status, 'failed');
	assert.match(f.ended[0]?.message ?? '', /Went back/);
	f.runs.dispose();
});

test('a route to done ends the run early, and a forward route skips steps', async () => {
	const f = fixture(undefined, {
		skill: { workflow: [{ onSuccess: { to: 'step', step: 2 } }, {}, { onSuccess: { to: 'done' } }, {}] },
		steps: [{ text: 'a', onSuccess: { to: 'step', step: 2 } }, { text: 'b' }, { text: 'c', onSuccess: { to: 'done' } }, { text: 'd' }],
	});
	f.emit({ type: 'turnEnd' }); f.tick();
	f.emit({ type: 'turnEnd' }); f.tick(); await Promise.resolve();
	assert.deepEqual(f.sent, ['a', 'c']);
	assert.equal(f.ended[0]?.status, 'done');
	f.runs.dispose();
});

test('a routed failure that goes on keeps the run going', () => {
	const f = fixture(undefined, {
		skill: { workflow: [{ onFailure: { to: 'next' } }, {}] },
		steps: [{ text: 'lint', onFailure: { to: 'next' } }, { text: 'report' }],
	});
	f.emit({ type: 'turnEnd', error: 'lint failed' }); f.tick();
	assert.deepEqual(f.sent, ['lint', 'report']);
	f.runs.dispose();
});

test('the user\'s Stop is never routed', () => {
	const f = fixture(undefined, {
		skill: { workflow: [{ onFailure: { to: 'next' } }, {}] },
		steps: [{ text: 'lint', onFailure: { to: 'next' } }, { text: 'report' }],
	});
	f.emit({ type: 'turnEnd', error: 'Stopped.', interrupted: true }); f.tick();
	assert.deepEqual(f.sent, ['lint']);
	f.runs.dispose();
});

test('validToolbarSkill keeps routes, remaps their targets and refuses bad ones', () => {
	const base = { id: 'w', name: 'w', prompt: 'a', result: 'silent', agents: 'all', icon: 'play', params: [] };
	const ok = text.validToolbarSkill({ ...base, followUps: [{ prompt: '' }, { prompt: 'c' }],
		workflow: [{}, {}, { onFailure: { to: 'step', step: 0, times: 3, whenSpent: 'next' } }] });
	assert.ok(typeof ok !== 'string');
	assert.deepEqual(ok.workflow?.[1], { onFailure: { to: 'step', step: 0, times: 3, whenSpent: 'next' } });
	const forwardDefault = text.validToolbarSkill({ ...base, followUps: [{ prompt: 'b' }], workflow: [{ onSuccess: { to: 'step', step: 1 } }, {}] });
	assert.ok(typeof forwardDefault !== 'string');
	assert.equal(forwardDefault.workflow, undefined);
	assert.match(String(text.validToolbarSkill({ ...base, followUps: [{ prompt: 'b' }], workflow: [{}, { onFailure: { to: 'step', step: 0, times: 4 } }] })), /1 to 3/);
	assert.match(String(text.validToolbarSkill({ ...base, followUps: [{ prompt: '' }], workflow: [{ onFailure: { to: 'step', step: 1 } }, {}] })), /empty or gone/);
	assert.match(String(text.validToolbarSkill({ ...base, result: 'chat', workflow: [{ onSuccess: { to: 'step', step: 0, times: 1 } }] })), /background/);
});

test('a decision step routes by the option the agent chose', async () => {
	const choices = [{ label: 'Fix', route: { to: 'step' as const, step: 0, times: 1 } }, { label: 'Ship', route: { to: 'step' as const, step: 2 } }];
	const f = fixture(undefined, {
		skill: { workflow: [{}, { choices }, {}] },
		steps: [{ text: 'build' }, { text: 'review {{steps.1.reply}}', choices }, { text: 'publish {{steps.2.choice}}' }],
	});
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.match(f.sent[1], /1\. Fix\n2\. Ship/);
	assert.match(f.sent[1], /<<<CHOICE:1>>>/);
	f.emit({ type: 'text', text: 'needs work\n**<<<CHOICE:1>>>**' });
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.equal(f.sent[2], 'build');
	f.emit({ type: 'turnEnd' }); f.tick();
	f.emit({ type: 'text', text: 'good\n<<<CHOICE:2>>>' });
	f.emit({ type: 'turnEnd' }); f.tick();
	assert.equal(f.sent[4], 'publish Ship');
	f.runs.dispose();
});

test('a decision step that chooses nothing takes its failure route', async () => {
	const choices = [{ label: 'A', route: { to: 'done' as const } }, { label: 'B', route: { to: 'done' as const } }];
	const f = fixture(undefined, { skill: { workflow: [{ choices }] }, steps: [{ text: 'pick', choices }] });
	f.emit({ type: 'text', text: 'I pick <<<CHOICE:3>>>' });
	f.emit({ type: 'turnEnd' }); f.tick(); await Promise.resolve();
	assert.equal(f.ended[0]?.status, 'failed');
	assert.match(f.ended[0]?.message ?? '', /failed/);
	f.runs.dispose();
});

test('validToolbarSkill keeps choices and refuses bad ones', () => {
	const base = { id: 'w', name: 'w', prompt: 'a', result: 'silent', agents: 'all', icon: 'play', params: [], followUps: [{ prompt: 'b' }] };
	const ok = text.validToolbarSkill({ ...base, workflow: [{ choices: [{ label: ' Yes ', route: { to: 'next' } }, { label: 'No', route: { to: 'done' } }] }, {}] });
	assert.ok(typeof ok !== 'string');
	assert.deepEqual(ok.workflow?.[0].choices, [{ label: 'Yes', route: { to: 'next' } }, { label: 'No', route: { to: 'done' } }]);
	assert.match(String(text.validToolbarSkill({ ...base, workflow: [{ choices: [{ label: 'a', route: { to: 'next' } }] }, {}] })), /between 2/);
	assert.match(String(text.validToolbarSkill({ ...base, workflow: [{ choices: [{ label: 'a' }, { label: 'A' }] }, {}] })), /twice/);
	assert.match(String(text.validToolbarSkill({ ...base, workflow: [{ shell: true, choices: [{ label: 'a' }, { label: 'b' }] }, {}] })), /cannot decide/);
	assert.match(String(text.validToolbarSkill({ ...base, workflow: [{ choices: [{ label: 'a<b' }, { label: 'b' }] }, {}] })), /without/);
	assert.equal(text.chosenOption('x\n<<<CHOICE:2>>>', 2), 1);
	assert.equal(text.chosenOption('<<<CHOICE:1>>> inline', 2), undefined);
});
