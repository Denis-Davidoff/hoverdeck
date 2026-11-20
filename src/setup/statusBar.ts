/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { BrowserController } from '../browser/browserController';
import { inUseMarker, sharedMarker, stripMarker } from '../browser/shareIndicator';
import { plainInLabel } from '../core/notifyText';
import { normalizeAddress } from '../core/webUrl';
import { hasExternalAgents, ownExtensionId, productName } from '../core/flavor';
import { supportsSecondarySidebar } from '../chat/chatView';
import { securityGuardStates } from '../core/securitySettings';
import { pageTitle } from '../translate/translateText';
import {
	browserApiState, integratedBrowserCommand,
	shouldUseIntegratedBrowser,
} from './proposedApi';

export function registerStatusBar(context: vscode.ExtensionContext, controller: BrowserController): void {
	// HoverDeck puts nothing in the status bar (asked for: AI Browser, installed
	// beside it, keeps its own items there). The menu stays reachable as the
	// palette command "HoverDeck: Menu"; the share state and the restart reminder
	// that the items used to carry are in that menu and in the Enable command.
	context.subscriptions.push(vscode.commands.registerCommand(menuCommand,
		() => showMenu(controller)));
}

/**
 * Blinks the item a few times, then leaves it steady — one burst per call. The
 * callers decide how often that is: once per window for the API grant, once per
 * offer or page for the logins item.
 *
 * The API supports exactly two backgrounds — `statusBarItem.errorBackground`
 * and `statusBarItem.warningBackground`, per the `.d.ts` — and no animation at
 * all. The one animation primitive anywhere near this is the `~spin` codicon
 * modifier, and it is the wrong word: a spinner means "working", so a spinning
 * alert reads as a hung extension rather than an invitation.
 *
 * So the animation is the background going on and off. Deliberately slow —
 * three blinks at 700ms a phase, about 0.7Hz — because a status bar is
 * peripheral vision and anything faster is a flashing-content problem rather
 * than a hint. It stops on its own; a permanently blinking button is the kind
 * of thing people disable the extension over.
 *
 * `landOn` says where it settles. A request — enable the API, save this login —
 * stays on the warning background until it is answered. A hint (`false`: a
 * login is saved for this page) settles with no background: it has caught the
 * eye and has nothing left to ask, and a page-by-page hint that stayed yellow
 * would read as something being wrong.
 */
export function pulse(item: vscode.StatusBarItem, landOn = true): vscode.Disposable {
	const warning = new vscode.ThemeColor('statusBarItem.warningBackground');
	const phases = 6;
	let phase = 0;
	const timer = setInterval(() => {
		if (++phase >= phases) {
			// Land on, in one assignment: setting it off and then straight back
			// on within a tick is a flicker the renderer is free to show. A hint
			// rather than a request (`landOn: false`) lands off: it caught the eye
			// and has nothing left to ask.
			clearInterval(timer);
			item.backgroundColor = landOn ? warning : undefined;
			return;
		}
		item.backgroundColor = phase % 2 === 0 ? warning : undefined;
	}, 700);
	return new vscode.Disposable(() => clearInterval(timer));
}

const menuCommand = 'hoverdeck.statusMenu';

interface MenuItem extends vscode.QuickPickItem {
	readonly run?: () => Thenable<unknown>;
}

/**
 * The dropdown behind the permanent item.
 *
 * Built fresh on each click, because half of what belongs in it depends on the
 * grant and on whether a browser tab is open. It deliberately does not mirror
 * the tab's dropdown: the element and screenshot commands are one click away
 * whenever a tab is focused, and a second copy here would be a longer menu
 * saying the same thing.
 */
async function showMenu(controller: BrowserController): Promise<void> {
	const state = await browserApiState();
	const items: MenuItem[] = [];

	// Resolve before showing the menu, including the Chrome tab opened by the user.
	const focused = controller.userTab;
	// **Two different facts, and the menu used only one of them.** "Nothing is
	// focused" is the ordinary state while somebody reads a file, and it is
	// what the entries below check; "no browser tab exists" is the state where
	// every sentence about giving *this* tab or *a* tab away is nonsense, and
	// the menu was still offering them.
	const anyTab = controller.hasOpenTabs;

	// Every agent the plugin supports; Pi and OpenRouter live in the chat only.
	const agents = [
		{ who: 'claude', name: 'Claude Code', connect: 'hoverdeck.connectClaudeCode' },
		{ who: 'codex', name: 'Codex', connect: 'hoverdeck.connectCodex' },
		{ who: 'gemini', name: 'Gemini CLI', connect: 'hoverdeck.connectGemini' },
		{ who: 'opencode', name: 'OpenCode', connect: 'hoverdeck.connectOpenCode' },
		{ who: 'pi', name: 'Pi', connect: 'hoverdeck.connectChatAgent' },
		{ who: 'openrouter', name: 'OpenRouter', connect: 'hoverdeck.connectChatAgent' },
	] as const;
	const availableAgents = agents.filter(agent => supportsSecondarySidebar(vscode.version) || (agent.who !== 'pi' && agent.who !== 'openrouter'));

	items.push({ label: vscode.l10n.t("Open"), kind: vscode.QuickPickItemKind.Separator });
	items.push({
		label: vscode.l10n.t("$(link) Open URL in VS Code Tab…"),
		detail: vscode.l10n.t("Type or paste an address"),
		run: () => openUrl(),
	});
	// Right under Open URL, asked for: the other way to open a page, for an agent.
	// HoverDeck has no agents outside the chat to hand a prompt to: the row opens
	// Chrome, and the chat's own agents find it with `browser_tabs`.
	if (!hasExternalAgents()) {
		items.push({
			label: vscode.l10n.t("$(globe) Open Google Chrome"),
			detail: vscode.l10n.t("A Chrome tab the chat's agents can work on"),
			run: () => vscode.commands.executeCommand('hoverdeck.openInChrome'),
		});
	} else items.push({
		label: vscode.l10n.t("$(globe) Open Google Chrome for your agent"),
		description: availableAgents.map(agent => agent.name).join(', '),
		detail: vscode.l10n.t("Opens a Chrome tab and copies a prompt that hands it to the agent"),
		run: async () => {
			const agent = (await vscode.window.showQuickPick(availableAgents.map(agent => ({
				label: agent.name, agent,
				description: agent.connect === 'hoverdeck.connectChatAgent' ? vscode.l10n.t("Opens a {0} chat with it", productName()) : undefined,
			})), {
				title: vscode.l10n.t("Open Google Chrome for which agent?"), ignoreFocusOut: true,
			}))?.agent;
			if (agent) { await vscode.commands.executeCommand('hoverdeck.openChromeForAssistant', agent.who); }
		},
	});
	if (await shouldUseIntegratedBrowser()) {
		// Only offered when the built-in browser will take it. The webview panel
		// cannot show a local file at all — its `localResourceRoots` is `media/`
		// and the page lives in a cross-origin iframe, so a `file:` URL there is
		// a blank panel with no error.
		items.push({
			label: vscode.l10n.t("$(file) Open File in VS Code Tab…"),
			detail: vscode.l10n.t("Preview a local HTML file"),
			run: () => openFile(),
		});
	}

	// The same three places the chat's own New Chat offers. Below VS Code 1.106
	// there is no chat view to reveal, so the section is left out there.
	if (supportsSecondarySidebar(vscode.version)) {
		items.push({ label: vscode.l10n.t("{0} Chat", productName()), kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: vscode.l10n.t("$(comment-discussion) New chat"),
			detail: vscode.l10n.t("A new tab in the {0} chat, shown in the side bar", productName()),
			run: () => vscode.commands.executeCommand('hoverdeck.chat.newChat', 'here'),
		});
		items.push({
			label: vscode.l10n.t("$(files) Chat in a new tab"),
			detail: vscode.l10n.t("An editor tab of its own"),
			run: () => vscode.commands.executeCommand('hoverdeck.chat.newChat', 'tab'),
		});
		items.push({
			label: vscode.l10n.t("$(link-external) Chat in a new window"),
			detail: vscode.l10n.t("A separate window holding only the chat"),
			run: () => vscode.commands.executeCommand('hoverdeck.chat.newChat', 'window'),
		});
	}

	// Only while a page exists to translate. Not gated on focus: the command
	// takes the tab last in front of the user, and asks only when none can be
	// told apart — so the row names the page it will take, when there is one.
	if (anyTab) {
		const tab = controller.userTab;
		items.push({ label: vscode.l10n.t("Page"), kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: vscode.l10n.t("$(whole-word) Translate page…"),
			description: tab ? plainInLabel(pageTitle(tab.title, tab.url) || tab.url) : undefined,
			detail: vscode.l10n.t("Pick a language, then paste the copied prompt into your assistant"),
			run: () => vscode.commands.executeCommand('hoverdeck.translatePage'),
		});
	}

	if (state !== 'granted') {
		items.push({ label: vscode.l10n.t("Setup"), kind: vscode.QuickPickItemKind.Separator });
		items.push({
			label: state === 'grantMissing'
				? vscode.l10n.t("$(browser) Enable native browser")
				: state === 'awaitingRestart'
					? vscode.l10n.t("$(debug-restart) Restart to finish enabling the API")
					: vscode.l10n.t("$(circle-slash) Native browser availability"),
			detail: vscode.l10n.t("This setup is for native editor tabs. Google Chrome and agents work without it"),
			run: () => vscode.commands.executeCommand('hoverdeck.enableBrowserApi'),
		});
	}

	if (hasExternalAgents()) {
	items.push({ label: vscode.l10n.t("Agents — browser tools and connection prompts"), kind: vscode.QuickPickItemKind.Separator });
	// The label says "and share this tab" only when there *is* a tab to share:
	// the command shares whatever is focused and shares nothing otherwise, so
	// with no browser tab open the longer label promised something it could not
	// do.
	// One row per action; choose the agent afterwards.
	const pickAgent = async (title: string) => (await vscode.window.showQuickPick(
		availableAgents
			.map(agent => ({ label: agent.name, agent, description: agent.connect === 'hoverdeck.connectChatAgent'
				? vscode.l10n.t("{0} Chat · tools connected automatically", productName())
				: agent.who === 'opencode' ? vscode.l10n.t("Opens a terminal with browser tools") : undefined })), { title, ignoreFocusOut: true }))?.agent;
	items.push({
		label: focused
			? vscode.l10n.t("$(comment-discussion) Connect your agent and share this tab")
			: vscode.l10n.t("$(comment-discussion) Connect your agent"),
		description: availableAgents.map(agent => agent.name).join(', '),
		detail: focused
			? vscode.l10n.t("Connects the agent, copies its check prompt, and shares this tab")
			: vscode.l10n.t("Connects the agent and copies its check prompt"),
		run: async () => {
			const agent = await pickAgent(vscode.l10n.t("Connect which agent?"));
			if (agent) { await vscode.commands.executeCommand(agent.connect, agent.who); }
		},
	});
	items.push({
		label: vscode.l10n.t("$(pulse) Check Connection"),
		run: () => vscode.commands.executeCommand('hoverdeck.checkMcpConnection'),
	});
	}

	// Saved logins sit between the assistants and the shared tabs. The
	// assignments stay last in both menus — that order was asked for, see below.
	items.push({ label: vscode.l10n.t("Logins and passkeys"), kind: vscode.QuickPickItemKind.Separator });
	if (focused) {
		items.push({
			label: vscode.l10n.t("$(key) Fill a saved login"),
			description: plainInLabel(stripMarker(focused.title) || focused.url),
			run: () => vscode.commands.executeCommand('hoverdeck.logins.fill'),
		});
		items.push({
			label: vscode.l10n.t("$(symbol-key) Paste cookies into this page…"),
			detail: vscode.l10n.t("For a site that will not sign in here: copy its cookies from a browser where you are signed in"),
			run: () => vscode.commands.executeCommand('hoverdeck.pasteCookies'),
		});
	}
	items.push({
		label: vscode.l10n.t("$(lock) Manage saved logins and passkeys…"),
		detail: vscode.l10n.t("Kept in VS Code's secret storage — import, export, edit, delete"),
		run: () => vscode.commands.executeCommand('hoverdeck.logins.manage'),
	});

	// The assignments come *after* the connect entries, in both menus, and the
	// order is asked for rather than derived: connecting is the thing done once
	// per project, while an assignment is what changes from page to page, so it
	// reads better at the end of a list than at the top of one. The tab
	// dropdown says the same thing with its group prefixes — `2_mcp@2` inside
	// each assistant's submenu, and `4_share` at the top level.
	const shares = controller.shares;
	if (shares.assignments.length > 0 || shares.paused.length > 0 || focused || anyTab) {
		items.push({ label: vscode.l10n.t("Shared tabs"), kind: vscode.QuickPickItemKind.Separator });
	}

	// **This row is now the only place either fact is stated.** The two states
	// used to be a 🔗/🤖 suffix on the page title, visible on the editor tab;
	// writing into someone else's document to say something about our own state
	// is gone (see `shareIndicator.ts`), so the distinction it carried has to be
	// carried here instead — the same glyphs, so this and the status bar item
	// read as one indicator rather than two that happen to agree.
	//
	// The unused state is the one that needs words. Neither assistant re-reads
	// its MCP config, so one that was never restarted has no browser tools at
	// all — and from the outside that is indistinguishable from an assistant
	// that simply has not got round to the page yet. The detail says which it
	// is and what to do, because the alternative is the report this whole
	// feature keeps producing: "I gave it a tab and nothing happened."
	for (const assignment of shares.assignments) {
		const pickedUp = assignment.usedBy.length > 0;
		items.push({
			label: vscode.l10n.t("$(circle-slash) Stop sharing with {0}", assignment.label),
			description: plainInLabel(assignment.title || assignment.url),
			detail: pickedUp
				? vscode.l10n.t("{0} Working on this tab and no other", inUseMarker)
				: vscode.l10n.t(
					"{0} Has this tab but has not called yet. It does not re-read its MCP config,"
					+ " so if it reports no browser tools, restart its session — the config is"
					+ " already correct.", sharedMarker),
			run: () => vscode.commands.executeCommand('hoverdeck.stopSharingTab', assignment.target),
		});
	}

	for (const entry of shares.paused) {
		items.push({
			label: vscode.l10n.t("$(debug-pause) {0} is paused — its tab was closed", entry.label),
			detail: vscode.l10n.t("Pick this to let it follow whichever tab is in front of you again"),
			run: () => vscode.commands.executeCommand('hoverdeck.stopSharingTab', entry.target),
		});
	}

	if (focused) {
		// Stripped defensively: nothing writes a marker into a page any more,
		// but a page an earlier build reached can still be open with the
		// observer that re-applies one.
		// Page-chosen: a description renders `$(icon)` syntax, see `plainInLabel`.
		const page = plainInLabel(stripMarker(focused.title) || focused.url);
		const alreadyShared = controller.isShared(focused);
		// One agent at a time is for agents outside the chat; HoverDeck's own
		// agents get a tab by opening it, or by the share with all of them below.
		if (hasExternalAgents()) {
		items.push({
			label: vscode.l10n.t("$(link) Give this tab to Claude Code"),
			description: page,
			run: () => vscode.commands.executeCommand('hoverdeck.shareTabWithClaudeCode'),
		});
		items.push({
			label: vscode.l10n.t("$(link) Give this tab to Codex"),
			description: page,
			run: () => vscode.commands.executeCommand('hoverdeck.shareTabWithCodex'),
		});
		items.push({
			label: vscode.l10n.t("$(link) Give this tab to Gemini CLI"),
			description: page,
			run: () => vscode.commands.executeCommand('hoverdeck.shareTabWithGemini'),
		});
		items.push({
			label: vscode.l10n.t("$(link) Give this tab to OpenCode"),
			description: page,
			run: () => vscode.commands.executeCommand('hoverdeck.shareTabWithOpenCode'),
		});
		if (supportsSecondarySidebar(vscode.version)) {
			items.push({
				label: vscode.l10n.t("$(link) Give this tab to Pi"),
				description: page,
				run: () => vscode.commands.executeCommand('hoverdeck.shareTabWithPi'),
			});
			items.push({
				label: vscode.l10n.t("$(link) Give this tab to OpenRouter"),
				description: page,
				run: () => vscode.commands.executeCommand('hoverdeck.shareTabWithOpenRouter'),
			});
		}
		}
		items.push({
			label: alreadyShared
				? vscode.l10n.t("$(link) Give this tab to every assistant")
				: vscode.l10n.t("$(link) Share this tab with assistants"),
			description: page,
			detail: vscode.l10n.t("Assistants with no tab of their own then work on this one"),
			run: () => vscode.commands.executeCommand('hoverdeck.shareTab'),
		});
	} else if (anyTab && shares.assignments.length === 0 && shares.paused.length === 0) {
		// Offered while a browser tab exists but is not focused, because the
		// alternative is a feature nobody finds: hidden whenever a tab was not
		// focused, this entry was invisible exactly when someone went looking
		// for it — and "Connect" took the blame for the tools following the
		// active tab. **But only while there is a tab at all**: with none open
		// it was an entry about giving away something that does not exist.
		items.push({
			label: vscode.l10n.t("$(link) Give a tab to an assistant"),
			detail: vscode.l10n.t("Click the browser tab you mean, then run this from it — until then the browser tools follow whichever tab you are looking at"),
			run: () => vscode.commands.executeCommand('hoverdeck.shareTab'),
		});
	}

	if (shares.assignments.length > 1) {
		items.push({
			label: vscode.l10n.t("$(circle-slash) Stop sharing everything"),
			run: () => vscode.commands.executeCommand('hoverdeck.stopSharingTab'),
		});
	}

	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	const guardsOff = Object.values(securityGuardStates()).filter(on => !on).length;
	items.push({
		label: guardsOff ? vscode.l10n.t("$(warning) Security") : vscode.l10n.t("$(shield) Security"),
		description: guardsOff
			? (guardsOff === 1 ? vscode.l10n.t("1 protection is off") : vscode.l10n.t("{0} protections are off", guardsOff))
			: vscode.l10n.t("All protections on"),
		detail: vscode.l10n.t("What agents may do on pages: new sites, password fields, your Chrome tabs, cookies"),
		run: () => vscode.commands.executeCommand('hoverdeck.securitySettings'),
	});
	items.push({
		label: vscode.l10n.t("$(gear) Settings"),
		run: () => vscode.commands.executeCommand(
			'workbench.action.openSettings', `@ext:${ownExtensionId()}`),
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: productName(),
		placeHolder: vscode.l10n.t("Pick an action"),
	});
	await picked?.run?.();
}

/**
 * Asks for an address, then opens it.
 *
 * The prompt is ours rather than `hoverdeck.show`'s own: that command only
 * prompts on the panel path, and hands `undefined` straight to
 * `workbench.action.browser.open` on the integrated one. Asking here is what
 * makes the menu entry mean the same thing on every host.
 */
async function openUrl(): Promise<void> {
	const url = await vscode.window.showInputBox({
		title: productName(),
		placeHolder: vscode.l10n.t("https://example.com"),
		prompt: vscode.l10n.t("Enter url to visit"),
		// Without this the box closes the instant it loses focus and resolves
		// `undefined`, which this function then reads as "cancelled" and does
		// nothing — indistinguishable from Enter not working.
		//
		// It matters on this path in particular. The box is opened from the
		// status bar menu, so the quick pick hides first and restores focus to
		// `previousFocusElement`; when that element no longer has an
		// `offsetParent` — which is what happens to a status bar entry VS Code
		// has re-rendered, and this item re-renders on every share change and on
		// every tick of `pulse` — the controller falls back to `returnFocus()`
		// into the editor group. That focus can land after our box is already
		// up, and takes it away.
		//
		// It is also simply the right setting for a prompt someone may have to
		// leave to go and copy the address they are being asked for.
		ignoreFocusOut: true,
		// The other route to "Enter did nothing": an empty box resolves `''`,
		// which is falsy, so the function returned silently. With a placeholder
		// that looks like a value, pressing Enter on an untouched box is an easy
		// thing to do. Refusing it keeps the box up and says why — and the same
		// check covers input no scheme can rescue, which would otherwise open a
		// broken tab rather than report anything.
		validateInput: value => normalizeAddress(value)
			? undefined
			: vscode.l10n.t("Enter an address, for example localhost:3000"),
	});
	const address = url === undefined ? undefined : normalizeAddress(url);
	if (address) {
		await vscode.commands.executeCommand('hoverdeck.show', address);
	}
}

/**
 * Opens a local file in the built-in browser.
 *
 * Reached only when `shouldUseIntegratedBrowser()` said yes, so the browser is
 * there to take it. Its own picker is preferred — it knows how it wants to
 * serve a `file:` page — and our dialog covers a host that has the browser but
 * not that particular command.
 *
 * There is deliberately **no panel fallback**. Handing a `file:` URI to the
 * panel produced a blank page and no error, which is worse than the entry not
 * being in the menu.
 */
async function openFile(): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes('workbench.action.browser.openFile')) {
		await vscode.commands.executeCommand('workbench.action.browser.openFile');
		return;
	}
	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: vscode.l10n.t("Open in {0}", productName()),
		filters: { [vscode.l10n.t("Web pages")]: ['html', 'htm', 'svg', 'pdf'] },
	});
	const file = picked?.[0];
	if (file) {
		await vscode.commands.executeCommand(
			integratedBrowserCommand, file.toString(true));
	}
}
