/*
 * Where a ready-made prompt goes. AI Browser copies it for an agent outside
 * the chat; HoverDeck has none of those, so it goes into the message box of the
 * chat in front, unsent, for the user to read and send.
 */

import * as vscode from 'vscode';
import { hasExternalAgents } from '../core/flavor';
import { confirm } from '../core/notify';

/** True when the prompt went to the chat; false means the caller copies it as before. */
export async function handToChat(prompt: string, confirmation: string): Promise<boolean> {
	if (hasExternalAgents()) { return false; }
	const done = await vscode.commands.executeCommand<boolean>('hoverdeck.chat.draftPrompt', prompt).then(ok => ok === true, () => false);
	if (done) { confirm(confirmation); }
	return done;
}
