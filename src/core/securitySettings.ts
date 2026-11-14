/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The prompt-injection protections, each with a switch. All are on unless the
 * user turns one off, and every one is `application`-scoped in the manifest: a
 * cloned repository's `.vscode/settings.json` must not be able to switch a
 * guard off for the agent its own pages are trying to mislead (#248's rule).
 *
 * Read with `inspect` and only the user's (global) value counts, for the same
 * reason — a workspace value is ignored even if VS Code would accept one.
 * Read on every decision, so a change applies at once.
 */

import * as vscode from 'vscode';

export type SecurityGuard =
	| 'confirmNewSites'
	| 'hideOtherChromeTabs'
	| 'protectSecretFields'
	| 'markPageContent'
	| 'confirmCookies';

/** In the order the settings panel and the status bar list them. */
export const securityGuards: readonly SecurityGuard[] = ['confirmNewSites', 'protectSecretFields', 'hideOtherChromeTabs', 'confirmCookies', 'markPageContent'];

export function isSecurityGuard(value: unknown): value is SecurityGuard {
	return typeof value === 'string' && (securityGuards as readonly string[]).includes(value);
}

/** Every guard and whether it is on. */
export function securityGuardStates(): Record<SecurityGuard, boolean> {
	return Object.fromEntries(securityGuards.map(g => [g, guardEnabled(g)])) as Record<SecurityGuard, boolean>;
}

/**
 * Turns a guard on or off in the user's settings. On is written as removing the
 * value, so the setting goes back to its default rather than pinning `true`.
 */
export async function setGuard(guard: SecurityGuard, on: boolean): Promise<void> {
	await vscode.workspace.getConfiguration('hoverdeck.security').update(guard, on ? undefined : false, vscode.ConfigurationTarget.Global);
}

export function guardEnabled(guard: SecurityGuard): boolean {
	const value = vscode.workspace.getConfiguration('hoverdeck.security').inspect<boolean>(guard)?.globalValue;
	return value !== false;
}
