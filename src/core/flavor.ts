/*
 * Who this extension is.
 *
 * This repository builds HoverDeck alone (`DenysDavydov.hoverdeck`). AI Browser
 * (`DenysDavydov.tab-browser-ultimate`), the build it grew out of, lives on
 * frozen in `github.com/Denis-Davidoff/vs-code-tab-browser-ultimate`; it is
 * named here only so HoverDeck can take its settings and state over
 * (src/setup/migration.ts) and recognise what its Connect commands wrote.
 *
 * Leaf module: no `vscode`, no relative value imports.
 */

export const extensionIds = {
	hoverdeck: 'DenysDavydov.hoverdeck',
	aibrowser: 'DenysDavydov.tab-browser-ultimate',
} as const;

/**
 * Whether the features for agents outside our chat (Connect, Add to Claude
 * Code, …) exist. They stayed with AI Browser; the answer is always no.
 */
export function hasExternalAgents(): boolean {
	return false;
}

/**
 * The name the chat registers its own MCP server under with every agent it
 * starts. The leaf readers of tool names (`isBrowserServer` and its siblings)
 * accept AI Browser's `ai-browser` as well: a migrated chat may still call it.
 */
export function mcpServerName(): 'hoverdeck' {
	return 'hoverdeck';
}

/** The product's name as users read it. */
export function productName(): string {
	return 'HoverDeck';
}

/** This extension's id (`publisher.name`). */
export function ownExtensionId(): string {
	return extensionIds.hoverdeck;
}

/** AI Browser's extension id, the build HoverDeck replaces. */
export function otherExtensionId(): string {
	return extensionIds.aibrowser;
}

/** Kept for the call sites that build a contributed id at runtime: ids are written as they are. */
export function contributionId(id: string): string {
	return id;
}
