import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';

type Memento = { keys(): string[]; get(k: string, d?: unknown): unknown; update(k: string, v: unknown): Promise<void> };

function memento(init: Record<string, unknown> = {}): Memento & { data: Record<string, unknown> } {
	const data = { ...init };
	return { data, keys: () => Object.keys(data), get: (k, d) => (k in data ? data[k] : d), update: async (k, v) => { data[k] = v; } };
}

const Target = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

function load(settings: Record<string, Record<string, unknown>>, folders: unknown[] = []) {
	const output = transpileModule(readFileSync('src/setup/migration.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
	const writes: Array<[string, unknown, number]> = [];
	const config = {
		inspect: (key: string) => settings[key],
		update: async (key: string, value: unknown, target: number) => { writes.push([key, value, target]); },
	};
	const exports: Record<string, unknown> = {};
	const modules: Record<string, unknown> = {
		vscode: {
			extensions: { getExtension: () => undefined },
			workspace: { getConfiguration: () => config, workspaceFolders: folders },
			ConfigurationTarget: Target,
		},
		'fs/promises': {}, path: {},
		'../core/flavor': { extensionIds: { aibrowser: 'DenysDavydov.tab-browser-ultimate', hoverdeck: 'DenysDavydov.hoverdeck' } },
	};
	runInNewContext(output, { exports, module: { exports }, require: (name: string) => modules[name] });
	return { m: exports as {
		renamedKey(k: string): string;
		settingPairs(p: unknown): Array<{ from: string; to: string }>;
		migrateFromAiBrowser(c: unknown): Promise<{ settings: number; global: number; workspace: number; secrets: number }>;
	}, writes };
}

const manifest = { contributes: { configuration: { properties: { 'hoverdeck.mcp.port': {}, 'hoverdeck.chat.tabLimit': {} } } } };

function context(globalState = memento(), workspaceState = memento(), secrets: Record<string, string> = {}) {
	return {
		extension: { packageJSON: manifest },
		globalState, workspaceState,
		secrets: { get: async (k: string) => secrets[k], store: async (k: string, v: string) => { secrets[k] = v; } },
		secretData: secrets,
	};
}

test('keys and setting names map from aiBrowser to hoverdeck', () => {
	const { m } = load({});
	assert.equal(m.renamedKey('aiBrowser.chat.history'), 'hoverdeck.chat.history');
	assert.equal(m.renamedKey('mcp.token:file:///x'), 'mcp.token:file:///x');
	assert.deepEqual(JSON.parse(JSON.stringify(m.settingPairs(manifest))), [
		{ from: 'aiBrowser.mcp.port', to: 'hoverdeck.mcp.port' },
		{ from: 'aiBrowser.chat.tabLimit', to: 'hoverdeck.chat.tabLimit' },
	]);
});

test('an aiBrowser setting fills the unset hoverdeck one, once', async () => {
	const { m, writes } = load({
		'aiBrowser.mcp.port': { globalValue: 43200, workspaceValue: 43300 },
		'hoverdeck.mcp.port': {},
		'aiBrowser.chat.tabLimit': { globalValue: 20 },
		'hoverdeck.chat.tabLimit': { globalValue: 12 },
	}, [{ uri: 'file:///w' }]);
	const ctx = context();
	const report = await m.migrateFromAiBrowser(ctx);
	assert.deepEqual(JSON.parse(JSON.stringify(writes)), [['hoverdeck.mcp.port', 43200, Target.Global], ['hoverdeck.mcp.port', 43300, Target.Workspace]]);
	assert.equal(report.settings, 2);
	writes.length = 0;
	await m.migrateFromAiBrowser(ctx);
	assert.deepEqual(writes, []);
});

test("HoverDeck's own pre-split keys and secrets get the new names; present ones win", async () => {
	const { m } = load({});
	const g = memento({ 'aiBrowser.chat.toolbar': ['a'], 'aiBrowser.chat.selection': 'old', 'hoverdeck.chat.selection': 'new', 'mcp.token:x': 't' });
	const w = memento({ 'aiBrowser.chat.history': [1], 'aiBrowser.exchange.connection': { pointId: 'p1' } });
	const ctx = context(g, w, { 'aiBrowser.vault': 'v', 'aiBrowser.exchange.key.p1': 'k' });
	await m.migrateFromAiBrowser(ctx);
	assert.deepEqual(g.data['hoverdeck.chat.toolbar'], ['a']);
	assert.equal(g.data['hoverdeck.chat.selection'], 'new');
	assert.deepEqual(w.data['hoverdeck.chat.history'], [1]);
	assert.equal(ctx.secretData['hoverdeck.vault'], 'v');
	assert.equal(ctx.secretData['hoverdeck.exchange.key.p1'], 'k');
});
