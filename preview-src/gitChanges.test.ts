import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { WorkdirGitStatus } from '../src/chat/chatProtocol.ts';
import { featureAgent } from '../src/chat/featureAi.ts';

class Node {
	children: (Node | string)[] = [];
	attrs: Record<string, string> = {};
	dataset: Record<string, string> = {};
	className = '';
	disabled = false;
	hidden = false;
	title = '';
	private text = '';
	private clickHandler: (() => void) | undefined;
	classList = { contains: (_name: string) => false, toggle: (_name: string, _on: boolean) => {} };
	set textContent(value: string) { this.text = value; this.children = []; }
	get textContent(): string { return this.text + this.children.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
	append(...nodes: (Node | string)[]): void { this.children.push(...nodes); }
	replaceChildren(...nodes: (Node | string)[]): void { this.children = nodes; this.text = ''; }
	setAttribute(name: string, value: string): void { this.attrs[name] = value; }
	addEventListener(event: string, handler: () => void): void { if (event === 'click') { this.clickHandler = handler; } }
	click(): void { if (!this.disabled) { this.clickHandler?.(); } }
}
function el(_tag: string, props: { class?: string; title?: string } = {}, ...children: (Node | string)[]): Node {
	const node = new Node(); node.className = props.class ?? ''; node.title = props.title ?? ''; node.append(...children); return node;
}
const button = (children: (Node | string)[], props: { class?: string; title?: string } = {}) => el('button', props, ...children);
function production(name: string, context: Record<string, unknown>): (...args: any[]) => void {
	const source = readFileSync(resolve('preview-src/chat.ts'), 'utf8');
	const body = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)?.[0];
	assert.ok(body, name);
	return runInNewContext(transpileModule(`${body}\n${name};`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, context);
}
function panel(staged: string[], unstaged: string[], available = true, manual?: string) {
	const actions: { kind: string; path?: string; staged?: boolean }[] = [];
	const files: WorkdirGitStatus = { staged: staged.map(path => ({ path, status: 'M' })), unstaged: unstaged.map(path => ({ path, status: 'M' })), changed: new Set([...staged, ...unstaged]).size, deleted: 0 };
	const list = new Node(), footer = new Node();
	const popup = new Node(); popup.classList.contains = () => true;
	const context = {
		gitFiles: files, gitStagedCount: new Node(), gitUnstagedCount: new Node(), gitChanged: new Node(), gitDeleted: new Node(),
		commitButton: new Node(), gitPopup: popup, gitPopupPressed: false, gitPopupShape: '', gitError: '', gitIndexPending: false, branchBusy: false,
		state: { activeTab: 'chat', workdir: {}, selection: { agent: 'codex', model: 'selected' }, agents: [{ id: 'codex', available, models: available ? [{ id: 'selected' }] : [] }], running: false },
		gitFolder: '/repo', gitPopupPinned: false,
		post: (message: { type: string; path: string; staged: boolean }) => actions.push({ kind: message.type, path: message.path, staged: message.staged }),
		readFeatureAiSettings: () => ({ commitMessage: { agent: 'auto', effort: 'medium' } }),
		featureAgent,
		gitFileIcon: () => new Node(),
		gitPopupError: new Node(), gitPopupList: list, gitPopupActions: footer, el, button, icon: () => new Node(),
		commitGitFiles: (scope: string, push?: boolean) => actions.push({ kind: push ? `${scope}+push` : scope }),
		changeGitFiles: (kind: string, path?: string) => actions.push({ kind, path }),
		gitMessage: Object.assign(new Node(), { value: manual ?? '' }), gitMessageBox: new Node(), gitManual: manual !== undefined,
		setGitManual: (on: boolean) => actions.push({ kind: on ? 'manual' : 'agent' }),
	};
	production('renderGitChanges', context)();
	return { context, actions, list, footer };
}
function nodes(node: Node, className: string): Node[] {
	return node.children.filter((child): child is Node => child instanceof Node && child.className === className);
}
/** Every button of the footer, row by row: each row is a commit and its Push. */
function footerButtons(footer: Node): Node[] {
	return nodes(footer, 'git-changes-row').flatMap(row => row.children.filter((child): child is Node => child instanceof Node));
}

test('mixed changes offer Commit staged and Commit all, each with a Push on its right', () => {
	const { footer, actions } = panel(['staged.txt'], ['unstaged.txt']);
	const choices = footerButtons(footer);
	assert.deepEqual(choices.map(c => c.textContent), ['Commit staged1', 'Push', 'Commit all2', 'Push']);
	for (const choice of choices) { choice.click(); }
	assert.deepEqual(actions, [{ kind: 'staged' }, { kind: 'staged+push' }, { kind: 'all' }, { kind: 'all+push' }]);
});

test('only staged changes offer Commit staged and its Push', () => {
	const { footer } = panel(['staged.txt'], []);
	assert.deepEqual(footerButtons(footer).map(c => c.textContent), ['Commit staged1', 'Push']);
});

test('an empty index offers staging all first and does not start a commit', () => {
	const { footer, actions } = panel([], ['unstaged.txt']);
	assert.match(footer.textContent, /Nothing staged/);
	const choices = footerButtons(footer);
	assert.equal(choices.length, 1); assert.equal(choices[0].textContent, 'Stage all files');
	choices[0].click();
	assert.deepEqual(actions, [{ kind: 'stage', path: undefined }]);
});

test('each group and each file has the correct stage or unstage action', () => {
	const { list, actions } = panel(['staged.txt'], ['unstaged.txt']);
	for (const group of nodes(list, 'git-changes-group')) { (group.children[1] as Node).click(); }
	for (const row of nodes(list, 'git-changes-file')) { (row.children.at(-1) as Node).click(); }
	assert.deepEqual(actions, [
		{ kind: 'unstage', path: undefined }, { kind: 'stage', path: undefined },
		{ kind: 'unstage', path: 'staged.txt' }, { kind: 'stage', path: 'unstaged.txt' },
	]);
});

test('clicking the file opens the correct diff without staging or unstaging', () => {
	const { list, actions } = panel(['same.txt'], ['same.txt']);
	for (const row of nodes(list, 'git-changes-file')) { (row.children[1] as Node).click(); }
	assert.deepEqual(actions, [
		{ kind: 'openGitDiff', path: 'same.txt', staged: true },
		{ kind: 'openGitDiff', path: 'same.txt', staged: false },
	]);
});

test('model unavailability explains commit restrictions while staging remains usable', () => {
	const { footer, list, actions } = panel(['staged.txt'], ['unstaged.txt'], false);
	assert.match(footer.textContent, /Choose an available agent/);
	assert.equal(footerButtons(footer).every(choice => choice.disabled), true);
	const unstaged = nodes(list, 'git-changes-file')[1];
	(unstaged.children.at(-1) as Node).click();
	assert.deepEqual(actions, [{ kind: 'stage', path: 'unstaged.txt' }]);
});

test('the combined trigger remains accessible with staged files while the chat is running or a model is unavailable', () => {
	const context: Record<string, any> = {
		gitFolder: '/repo', gitStatus: new Node(), commitButton: new Node(), commitIcon: new Node(), branchButton: new Node(),
		renderGitChanges() {}, workdirButton: new Node(), workdirMode: new Node(), workdirLocationText: new Node(),
		workdirLocation: new Node(), workdirSummary: new Node(), workdirFooter: new Node(), workdirPopup: new Node(),
		commitNotice: new Node(), commitNoticeText: new Node(), commitFix: new Node(),
		gitManualSent: undefined, gitManual: false, gitMessage: { value: '' },
	};
	context.commitButton.disabled = true;
	production('renderWorkdir', context)({
		workdir: { current: { path: '/repo' }, workspace: [{ path: '/repo' }], references: [] },
		agents: [], selection: {}, running: true,
	});
	assert.equal(context.commitButton.disabled, false);
	assert.equal(context.commitButton.title, 'Git changes and commit');
	const render = production('renderWorkdir', context);
	for (const phase of ['done', 'error']) {
		render({
			workdir: { current: { path: '/repo' }, workspace: [{ path: '/repo' }], references: [], commit: { id: 'job', phase, message: 'Commit result' } },
			agents: [], selection: {}, running: false,
		});
		assert.equal(context.commitNotice.hidden, phase !== 'error');
	}
});

test('a message written by hand needs no agent, only text, and the footer switches between the two', () => {
	// The agent's message: the footer offers "Write message".
	const agent = panel(['a.txt'], []);
	const toggle = (footer: Node) => footer.children.flatMap(c => c instanceof Node ? c.children : []).find((c): c is Node => c instanceof Node && c.className.includes('git-message-toggle'));
	assert.equal(toggle(agent.footer)?.textContent, 'Write message');
	toggle(agent.footer)!.click();
	assert.deepEqual(agent.actions, [{ kind: 'manual' }]);
	// No agent available, an empty message: Commit waits for text.
	const empty = panel(['a.txt'], [], false, '  ');
	assert.ok(footerButtons(empty.footer).every(b => b.disabled));
	assert.equal(footerButtons(empty.footer)[0].title, 'Write a commit message first');
	assert.equal(empty.context.gitMessageBox.hidden, false);
	// With text, Commit and Push work although no agent is available.
	const written = panel(['a.txt'], [], false, 'fix: typo');
	assert.ok(footerButtons(written.footer).every(b => !b.disabled));
	assert.match(footerButtons(written.footer)[0].title, /your message/);
	assert.ok(!written.footer.textContent.includes('Choose model'));
	toggle(written.footer)!.click();
	assert.deepEqual(written.actions, [{ kind: 'agent' }]);
});
