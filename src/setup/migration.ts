/*
 * Taking over what AI Browser (`tab-browser-ultimate`) left behind.
 *
 * HoverDeck grew out of AI Browser and was split from it on 2026-11-14: every
 * id, setting and storage key that said `aiBrowser.*` says `hoverdeck.*` now.
 * Three things are moved, each only where HoverDeck has nothing of its own yet,
 * so a value the user has since set in HoverDeck is never overwritten:
 *
 * - **Settings** (`migrateSettings`): every `hoverdeck.<x>` the manifest
 *   declares is filled from `aiBrowser.<x>` in the user's, the workspace's and
 *   each folder's settings. Settings live in `settings.json`, which every
 *   extension reads, so this works whatever AI Browser release is installed, or
 *   none. Once globally and once per workspace.
 * - **HoverDeck's own keys from before the split** (`renameOwnKeys`): a
 *   HoverDeck build from before 2026-11-14 kept its state under `aiBrowser.*`
 *   names in its own `globalState`, `workspaceState` and `SecretStorage`.
 * - **AI Browser's state** (`migrateFromAiBrowser`): `globalState`,
 *   `workspaceState`, `SecretStorage` and `globalStorageUri` belong to each
 *   extension id, so they can only be handed over by AI Browser itself, through
 *   an `exportState` on its `activate` result, read in memory. **No released AI
 *   Browser has it** (1.0.0, the last, does not), so today this answers
 *   `undefined`; it is kept for a release that adds it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { extensionIds } from '../core/flavor';

export interface StateBundle {
	readonly version: 1;
	readonly global: Record<string, unknown>;
	readonly workspace: Record<string, unknown>;
	readonly secrets: Record<string, string>;
	readonly visualizations?: string;
}

export interface MigrationApi {
	exportState?(): Promise<StateBundle>;
}

export interface MigrationReport {
	readonly global: number;
	readonly workspace: number;
	readonly secrets: number;
	readonly settings: number;
}

const oldPrefix = 'aiBrowser.';
const newPrefix = 'hoverdeck.';

const globalMarker = 'hoverdeck.migration.global';
const workspaceMarker = 'hoverdeck.migration.workspace';
const settingsGlobalMarker = 'hoverdeck.migration.settings';
const settingsWorkspaceMarker = 'hoverdeck.migration.settingsWorkspace';
const renameGlobalMarker = 'hoverdeck.migration.rename';
const renameWorkspaceMarker = 'hoverdeck.migration.renameWorkspace';

/** The secrets kept under fixed names; Exchange's are per point and found by prefix. */
const secretNames = ['vault', 'openrouter.apiKey', 'chromeChat.resume'];

/** `aiBrowser.x` → `hoverdeck.x`; anything else unchanged. Leaf, under test. */
export function renamedKey(key: string): string {
	return key.startsWith(oldPrefix) ? newPrefix + key.slice(oldPrefix.length) : key;
}

/** The settings to look for: `hoverdeck.<x>` from the manifest, with the old name beside it. */
export function settingPairs(packageJSON: unknown): Array<{ from: string; to: string }> {
	const contributes = (packageJSON as { contributes?: { configuration?: unknown } } | undefined)?.contributes;
	const sections = Array.isArray(contributes?.configuration) ? contributes.configuration : contributes?.configuration ? [contributes.configuration] : [];
	const out: Array<{ from: string; to: string }> = [];
	for (const section of sections as Array<{ properties?: Record<string, unknown> }>) {
		for (const to of Object.keys(section?.properties ?? {})) {
			if (to.startsWith(newPrefix)) { out.push({ from: oldPrefix + to.slice(newPrefix.length), to }); }
		}
	}
	return out;
}

async function copyMissing(memento: vscode.Memento, from: Record<string, unknown>): Promise<number> {
	const have = new Set(memento.keys());
	let moved = 0;
	for (const [oldKey, value] of Object.entries(from)) {
		const key = renamedKey(oldKey);
		if (value === undefined || have.has(key) || key.startsWith('hoverdeck.migration.')) { continue; }
		await memento.update(key, value);
		have.add(key);
		moved++;
	}
	return moved;
}

function oldEntries(memento: vscode.Memento): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of memento.keys()) {
		if (key.startsWith(oldPrefix)) { out[key] = memento.get(key); }
	}
	return out;
}

async function copySecret(context: vscode.ExtensionContext, from: string, value: string | undefined): Promise<number> {
	if (value === undefined) { return 0; }
	const to = renamedKey(from);
	if (await context.secrets.get(to) !== undefined) { return 0; }
	await context.secrets.store(to, value);
	return 1;
}

/** HoverDeck's own state from before the split, under its old names. Nothing old is deleted. */
async function renameOwnKeys(context: vscode.ExtensionContext): Promise<Omit<MigrationReport, 'settings'>> {
	let global = 0;
	let workspace = 0;
	let secrets = 0;
	if (!context.globalState.get<boolean>(renameGlobalMarker, false)) {
		global = await copyMissing(context.globalState, oldEntries(context.globalState));
		for (const name of secretNames) {
			secrets += await copySecret(context, oldPrefix + name, await Promise.resolve(context.secrets.get(oldPrefix + name)).catch(() => undefined));
		}
		await context.globalState.update(renameGlobalMarker, true);
	}
	if (!context.workspaceState.get<boolean>(renameWorkspaceMarker, false)) {
		const old = oldEntries(context.workspaceState);
		workspace = await copyMissing(context.workspaceState, old);
		const point = (old[`${oldPrefix}exchange.connection`] as { pointId?: unknown } | undefined)?.pointId;
		if (typeof point === 'string') {
			for (const key of [`${oldPrefix}exchange.key.${point}`, `${oldPrefix}exchange.key.password.${point}`]) {
				secrets += await copySecret(context, key, await Promise.resolve(context.secrets.get(key)).catch(() => undefined));
			}
		}
		await context.workspaceState.update(renameWorkspaceMarker, true);
	}
	return { global, workspace, secrets };
}

type Inspected = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined;

async function copySetting(config: vscode.WorkspaceConfiguration, from: string, to: string, scopes: Array<[keyof NonNullable<Inspected>, vscode.ConfigurationTarget]>): Promise<number> {
	const old = config.inspect(from) as Inspected;
	const now = config.inspect(to) as Inspected;
	let moved = 0;
	for (const [field, target] of scopes) {
		const value = old?.[field];
		if (value === undefined || now?.[field] !== undefined) { continue; }
		await Promise.resolve(config.update(to, value, target)).then(() => { moved++; }, () => { /* a scope the setting refuses: left as it is */ });
	}
	return moved;
}

/**
 * The user's `aiBrowser.*` settings, copied to `hoverdeck.*` where unset. The
 * old values stay in `settings.json`, untouched: AI Browser may still be
 * installed and reading them.
 */
async function migrateSettings(context: vscode.ExtensionContext): Promise<number> {
	const pairs = settingPairs(context.extension.packageJSON);
	let moved = 0;
	if (!context.globalState.get<boolean>(settingsGlobalMarker, false)) {
		const config = vscode.workspace.getConfiguration();
		for (const { from, to } of pairs) {
			moved += await copySetting(config, from, to, [['globalValue', vscode.ConfigurationTarget.Global]]);
		}
		await context.globalState.update(settingsGlobalMarker, true);
	}
	if (vscode.workspace.workspaceFolders?.length && !context.workspaceState.get<boolean>(settingsWorkspaceMarker, false)) {
		const config = vscode.workspace.getConfiguration();
		for (const { from, to } of pairs) {
			moved += await copySetting(config, from, to, [['workspaceValue', vscode.ConfigurationTarget.Workspace]]);
		}
		for (const folder of vscode.workspace.workspaceFolders) {
			const scoped = vscode.workspace.getConfiguration(undefined, folder.uri);
			for (const { from, to } of pairs) {
				moved += await copySetting(scoped, from, to, [['workspaceFolderValue', vscode.ConfigurationTarget.WorkspaceFolder]]);
			}
		}
		await context.workspaceState.update(settingsWorkspaceMarker, true);
	}
	return moved;
}

/** AI Browser's state, from an AI Browser that offers `exportState` (none released yet). */
async function importFromAiBrowser(context: vscode.ExtensionContext): Promise<Omit<MigrationReport, 'settings'> | undefined> {
	const globalDone = context.globalState.get<boolean>(globalMarker, false);
	const workspaceDone = context.workspaceState.get<boolean>(workspaceMarker, false);
	if (globalDone && workspaceDone) { return undefined; }
	const old = vscode.extensions.getExtension<MigrationApi | undefined>(extensionIds.aibrowser);
	if (!old) { return undefined; }
	const api = old.isActive ? old.exports : await old.activate();
	if (typeof api?.exportState !== 'function') { return undefined; }
	const bundle = await api.exportState();
	if (bundle?.version !== 1) { return undefined; }

	let global = 0;
	let secrets = 0;
	if (!globalDone) {
		global = await copyMissing(context.globalState, bundle.global ?? {});
		if (bundle.visualizations) {
			const target = path.join(context.globalStorageUri.fsPath, 'visualizations');
			await fs.cp(bundle.visualizations, target, { recursive: true, force: false, errorOnExist: false }).catch(() => { /* none yet, or unreadable */ });
		}
	}
	// Exchange's keys are named by the workspace's own connection, so they are
	// taken in the workspace pass; the rest once.
	for (const [key, value] of Object.entries(bundle.secrets ?? {})) {
		const perWorkspace = renamedKey(key).startsWith(`${newPrefix}exchange.key.`);
		if (perWorkspace ? workspaceDone : globalDone) { continue; }
		secrets += await copySecret(context, key, value);
	}
	if (!globalDone) { await context.globalState.update(globalMarker, true); }
	const workspace = workspaceDone ? 0 : await copyMissing(context.workspaceState, bundle.workspace ?? {});
	await context.workspaceState.update(workspaceMarker, true);
	return { global, workspace, secrets };
}

/**
 * Run first in `activate`, before anything reads the state. Each part fails on
 * its own: a refused setting must not keep the chat history from moving.
 */
export async function migrateFromAiBrowser(context: vscode.ExtensionContext): Promise<MigrationReport> {
	const settings = await migrateSettings(context).catch(() => 0);
	const own = await renameOwnKeys(context).catch(() => ({ global: 0, workspace: 0, secrets: 0 }));
	const theirs = await importFromAiBrowser(context).catch(() => undefined);
	return {
		settings,
		global: own.global + (theirs?.global ?? 0),
		workspace: own.workspace + (theirs?.workspace ?? 0),
		secrets: own.secrets + (theirs?.secrets ?? 0),
	};
}
