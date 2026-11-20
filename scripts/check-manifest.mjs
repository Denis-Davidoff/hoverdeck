/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Checks the parts of package.json that nothing else validates.
 *
 * None of this produces a compile error: a menu item pointing at a command that
 * does not exist, a command with no activation event, an icon path with a typo,
 * an icon file nobody references — every one of them is silent, and shows up as
 * a button that is missing or does nothing. Run with `npm run check-manifest`.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const contributes = manifest.contributes;

const problems = [];
for (const left of JSON.stringify(manifest).match(/\baiBrowser\.[\w.]+/g) ?? []) {
	problems.push(`${left} still carries AI Browser's id, so it collides with that extension installed beside HoverDeck`);
}
const commands = new Map(contributes.commands.map(c => [c.command, c]));
const submenus = new Map((contributes.submenus ?? []).map(s => [s.id, s]));

/* every menu item must reference something that exists */
for (const [menu, items] of Object.entries(contributes.menus ?? {})) {
	for (const item of items) {
		if (item.command && !commands.has(item.command)) {
			problems.push(`${menu}: unknown command ${item.command}`);
		}
		if (item.submenu && !submenus.has(item.submenu)) {
			problems.push(`${menu}: unknown submenu ${item.submenu}`);
		}
	}
}

/* a submenu with no items renders as an empty dropdown */
for (const id of submenus.keys()) {
	if (!contributes.menus?.[id]?.length) {
		problems.push(`submenu ${id} has no items`);
	}
}

/*
 * Commands need an explicit activation event: `contributes.menus` renders before
 * the extension activates, so without one the button silently does nothing until
 * something else wakes the extension.
 */
const activation = new Set(manifest.activationEvents ?? []);
for (const id of commands.keys()) {
	if (!activation.has(`onCommand:${id}`)) {
		problems.push(`command ${id} has no onCommand activation event`);
	}
}

/*
 * Every command carries the `AI Browser` category: without it the palette lists
 * a bare "Record Video" or "Balanced · 1080p" with nothing saying whose it is.
 * Commands that only make sense in a menu are hidden with `commandPalette` and
 * `when: false`, not left uncategorised.
 */
for (const [id, command] of commands) {
	if (!command.category) {
		problems.push(`command ${id} has no category`);
	}
}

/* icon paths must resolve, and every icon file must be referenced */
const referenced = new Set();
/*
 * A `$(id)` the extension contributes itself (`contributes.icons`) must be declared, and its
 * font must be there: an unknown id draws nothing, with no error anywhere.
 */
const ownIcons = contributes.icons ?? {};
for (const [id, icon] of Object.entries(ownIcons)) {
	const font = icon?.default?.fontPath;
	if (typeof font === 'string' && !existsSync(join(root, font))) {
		problems.push(`icon ${id}: font not found — ${font}`);
	}
}
const collectIcon = (icon, owner) => {
	if (typeof icon === 'string') {
		const id = /^\$\(([^)~]+)/.exec(icon)?.[1];
		if (id?.startsWith('ai-browser-') && !ownIcons[id]) {
			problems.push(`${owner}: icon $(${id}) is not in contributes.icons`);
		}
		return;
	}
	if (!icon) {
		return;
	}
	for (const path of Object.values(icon)) {
		referenced.add(path);
		if (!existsSync(join(root, path))) {
			problems.push(`${owner}: icon not found — ${path}`);
		}
	}
};
for (const command of commands.values()) {
	collectIcon(command.icon, command.command);
}
for (const submenu of submenus.values()) {
	collectIcon(submenu.icon, submenu.id);
}
/* a view container's icon is a plain path, which `collectIcon` skips as a codicon */
for (const [location, containers] of Object.entries(contributes.viewsContainers ?? {})) {
	for (const container of containers) {
		if (typeof container.icon === 'string' && !container.icon.startsWith('$(') && !existsSync(join(root, container.icon))) {
			problems.push(`viewsContainers.${location}.${container.id}: icon not found — ${container.icon}`);
		}
		if (!contributes.views?.[container.id]?.length) {
			problems.push(`viewsContainers.${location}.${container.id} has no views`);
		}
	}
}
for (const [container, views] of Object.entries(contributes.views ?? {})) {
	for (const view of views) {
		if (!activation.has(`onView:${view.id}`)) {
			problems.push(`view ${view.id} (${container}) has no onView activation event`);
		}
	}
}

for (const file of readdirSync(join(root, 'media', 'icons'))) {
	const path = `media/icons/${file}`;
	if (!referenced.has(path)) {
		problems.push(`orphaned icon file — ${path}`);
	}
}

/*
 * The element commands carry one crosshair per kind, whatever the destination:
 * the centre dot says *what* is copied (element, CSS path, CSS path + location,
 * XPath), and Copy, Claude Code, Codex and the chat share it. So the same kind
 * must share one icon across destinations, and no two kinds may share a dot.
 */
const grid = {
	element: ['hoverdeck.copyElement', 'hoverdeck.addElementToClaudeCode', 'hoverdeck.addElementToCodex', 'hoverdeck.chat.addElement'],
	cssPath: ['hoverdeck.copyElementCssPath', 'hoverdeck.addCssPathToClaudeCode', 'hoverdeck.addCssPathToCodex', 'hoverdeck.chat.addCssPath'],
	cssLocation: ['hoverdeck.copyElementCssLocation', 'hoverdeck.addCssLocationToClaudeCode', 'hoverdeck.addCssLocationToCodex', 'hoverdeck.chat.addCssLocation'],
	xpath: ['hoverdeck.copyElementXPath', 'hoverdeck.addXPathToClaudeCode', 'hoverdeck.addXPathToCodex', 'hoverdeck.chat.addXPath'],
};
const stem = id => {
	const icon = commands.get(id)?.icon;
	const match = /crosshair-(\w+?)(?:-(claude|codex|chat))?-dark\.svg$/.exec(icon?.dark ?? '');
	return match ? { dot: match[1], dest: match[2] ?? 'copy' } : undefined;
};
// The Claude Code and Codex columns stayed with AI Browser; only what is contributed is checked.
const shipped = id => !/(ClaudeCode|Codex)$|\.(claude|codex)\./.test(id);
for (const [kind, all] of Object.entries(grid)) {
	const stems = all.filter(shipped).map(stem);
	if (stems.some(s => !s)) {
		problems.push(`${kind}: a command has no crosshair icon`);
		continue;
	}
	if (new Set(stems.map(s => s.dot)).size !== 1) {
		problems.push(`${kind}: the centre dot differs across destinations`);
	}
	if (stems.some(s => s.dest !== 'copy')) {
		problems.push(`${kind}: a destination has an icon of its own; every destination uses the kind's crosshair`);
	}
}

const dots = Object.entries(grid)
	.map(([kind, ids]) => [kind, stem(ids[0])?.dot])
	.filter(([, dot]) => dot);
if (new Set(dots.map(([, dot]) => dot)).size !== dots.length) {
	problems.push(`two kinds share a centre dot: ${dots.map(([k, d]) => `${k}=${d}`).join(', ')}`);
}

/*
 * HoverDeck puts exactly one button on the browser tab: the dropdown. The repeat
 * button beside it (navigation@2) was removed so that, with AI Browser installed
 * too, the tab carries one button per extension. The last action still repeats
 * on the chord, through the `repeat.*` delegates below. The favorites star is the
 * one exception: it is off unless `hoverdeck.favorites.showButton` is on.
 */
const browserButtons = (contributes.menus['editor/title'] ?? [])
	.filter(m => (m.when ?? '').includes("activeEditor == 'workbench.editor.browser'") && !String(m.command ?? '').startsWith('hoverdeck.recording.') && !String(m.command ?? '').startsWith('hoverdeck.favorites.'));
if (browserButtons.length !== 1 || browserButtons[0].submenu !== 'hoverdeck.elementMenu') {
	problems.push(`the browser tab must carry exactly one HoverDeck button (the dropdown); found ${browserButtons.map(m => m.submenu ?? m.command).join(', ')}`);
}

/*
 * One chord drives the right-hand icon: one binding per action, same key, and
 * the same mutually exclusive `when` set as the buttons. If a `when` drifted,
 * the key would either fire nothing or fire two tools at once.
 *
 * Scoped to the `repeat.*` delegates: other commands may have chords of their
 * own (Fill Saved Login does), and those must simply not reuse this one.
 */
const keybindings = contributes.keybindings ?? [];
/*
 * A binding's chord on each platform, modifiers in a fixed order.
 *
 * Compared per platform, not as the `key|mac` pair: a binding of `ctrl+alt+c`
 * with a different `mac` is a different pair and the same chord on Windows and
 * Linux, where it would fire alongside the repeat button's.
 */
const normalise = chord => {
	const parts = String(chord ?? '').toLowerCase().split('+').map(part => part.trim()).filter(Boolean);
	const key = parts.pop() ?? '';
	return [...parts.sort(), key].join('+');
};
const platformChords = k => ({
	win: normalise(k.win ?? k.key),
	linux: normalise(k.linux ?? k.key),
	mac: normalise(k.mac ?? k.key),
});
const chordOf = k => JSON.stringify(platformChords(k));
const sharesChord = (k, chords) => Object.entries(platformChords(k)).some(([os, chord]) => chord && chords?.[os] === chord);
const repeatBindings = keybindings.filter(k => k.command.startsWith('hoverdeck.repeat.'));
let repeatChord;
if (repeatBindings.length) {
	const keys = new Set(repeatBindings.map(chordOf));
	if (keys.size !== 1) {
		problems.push(`repeat keybindings use ${keys.size} different chords; expected one`);
	}
	repeatChord = platformChords(repeatBindings[0]);
	const boundActions = repeatBindings.map(k => /lastElementAction == '([^']+)'/.exec(k.when ?? '')?.[1]);
	if (boundActions.some(a => !a)) {
		problems.push('a repeat keybinding has no lastElementAction condition');
	}
	if (new Set(boundActions).size !== boundActions.length) {
		problems.push('two repeat keybindings share a lastElementAction value');
	}
}
for (const binding of keybindings) {
	if (!commands.has(binding.command)) {
		problems.push(`keybinding for unknown command ${binding.command}`);
	}
	if (!binding.command.startsWith('hoverdeck.repeat.') && sharesChord(binding, repeatChord)) {
		problems.push(`${binding.command} takes the repeat chord on some platform, which repeats the last element action`);
	}
}

/*
 * The chord lives on the `repeat.*` delegates, never on the commands that appear
 * in the dropdown. VS Code prints a command's keybinding beside every menu item
 * that invokes it with no way to opt out, so a keybinding on a dropdown command
 * puts the chord on every row of the menu.
 *
 * Swept across *every* submenu we declare, not just the top-level one. It used
 * to read `menus['hoverdeck.elementMenu']` alone, and the moment the assistant
 * entries moved down into `hoverdeck.claudeMenu` / `codexMenu` that guard went
 * blind to eight of the twelve commands it exists for — silently, because a
 * check that inspects nothing still passes.
 *
 * Only the repeat chord is meant: a command with a chord of its own — Fill
 * Saved Login — *wants* it printed beside its menu row, since that is where
 * people learn it.
 */
const bound = new Set(repeatBindings.map(k => k.command));
const repeatChordCommands = new Set(keybindings.filter(k => sharesChord(k, repeatChord)).map(k => k.command));
for (const id of submenus.keys()) {
	for (const item of contributes.menus[id] ?? []) {
		if (repeatChordCommands.has(item.command)) {
			problems.push(`${item.command} is in submenu ${id} and has a keybinding; the chord belongs on its repeat.* twin`);
		}
	}
}

/* each delegate must mirror its twin's icon, and stay out of the palette */
const hiddenFromPalette = new Set(
	(contributes.menus.commandPalette ?? []).filter(m => m.when === 'false').map(m => m.command));
const twins = {
	'hoverdeck.repeat.element': 'hoverdeck.copyElement',
	'hoverdeck.repeat.cssPath': 'hoverdeck.copyElementCssPath',
	'hoverdeck.repeat.cssLocation': 'hoverdeck.copyElementCssLocation',
	'hoverdeck.repeat.xpath': 'hoverdeck.copyElementXPath',
	'hoverdeck.repeat.claude.element': 'hoverdeck.addElementToClaudeCode',
	'hoverdeck.repeat.claude.cssPath': 'hoverdeck.addCssPathToClaudeCode',
	'hoverdeck.repeat.claude.cssLocation': 'hoverdeck.addCssLocationToClaudeCode',
	'hoverdeck.repeat.claude.xpath': 'hoverdeck.addXPathToClaudeCode',
	'hoverdeck.repeat.codex.element': 'hoverdeck.addElementToCodex',
	'hoverdeck.repeat.codex.cssPath': 'hoverdeck.addCssPathToCodex',
	'hoverdeck.repeat.codex.cssLocation': 'hoverdeck.addCssLocationToCodex',
	'hoverdeck.repeat.codex.xpath': 'hoverdeck.addXPathToCodex',
	'hoverdeck.repeat.chat.element': 'hoverdeck.chat.addElement',
	'hoverdeck.repeat.chat.cssPath': 'hoverdeck.chat.addCssPath',
	'hoverdeck.repeat.chat.cssLocation': 'hoverdeck.chat.addCssLocation',
	'hoverdeck.repeat.chat.xpath': 'hoverdeck.chat.addXPath',
	'hoverdeck.repeat.annotate': 'hoverdeck.annotatePage',
	'hoverdeck.repeat.annotateAnywhere': 'hoverdeck.annotateAnywhere',
};
for (const [delegate, twin] of Object.entries(twins)) {
	if (!shipped(delegate)) { continue; }
	if (!commands.has(delegate)) {
		problems.push(`missing repeat delegate ${delegate}`);
		continue;
	}
	if (JSON.stringify(commands.get(delegate).icon) !== JSON.stringify(commands.get(twin)?.icon)) {
		problems.push(`${delegate} does not share the icon of ${twin}`);
	}
	if (!hiddenFromPalette.has(delegate)) {
		problems.push(`${delegate} is not hidden from the command palette`);
	}
	if (!bound.has(delegate)) {
		problems.push(`${delegate} has no keybinding`);
	}
}

if (problems.length) {
	console.error(`check-manifest: ${problems.length} problem(s)`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	process.exit(1);
}

console.log(`check-manifest: ok — ${commands.size} commands, ${submenus.size} submenu(s), `
	+ `${referenced.size} icon files, ${repeatBindings.length} repeat chords, `
	+ `${keybindings.length} keybindings, ${Object.keys(twins).length} repeat delegates`);
