/**
 * The parts of the MCP server a user can switch off (Chat Settings → MCP,
 * `hoverdeck.mcp.disabledFeatures`). Only conveniences: the browser, the editor
 * reads and the terminal tools that the rest of the extension is built on are not
 * offered here. A feature that is off is left out of `tools/list` and its tools
 * refuse a call, saying where it is switched back on.
 *
 * Leaf module, under test. `McpFeatureId` in `chatProtocol.ts` repeats the ids
 * for the webview; `mcpFeatures.test.ts` holds the two equal.
 */

export const mcpFeatures = ['sounds', 'alerts', 'cards', 'keepAwake', 'chatControl', 'recording', 'annotations', 'cookies', 'editor'] as const;
export type McpFeature = typeof mcpFeatures[number];

/** Which tools each feature covers: whole names, or a prefix ending in `_`. */
const featureTools: Readonly<Record<McpFeature, readonly string[]>> = {
	sounds: ['chat_play_sound'],
	alerts: ['chat_alert'],
	cards: ['chat_notify', 'chat_progress', 'chat_update_plan', 'chat_present_result', 'chat_present_json', 'chat_cite'],
	keepAwake: ['chat_keep_awake'],
	chatControl: ['chat_pause', 'chat_resume', 'chat_stop_agent'],
	recording: ['browser_recording_'],
	annotations: ['browser_annotations_'],
	cookies: ['browser_get_cookies', 'browser_set_cookies'],
	editor: ['editor_'],
};

export function isMcpFeature(value: unknown): value is McpFeature {
	return typeof value === 'string' && (mcpFeatures as readonly string[]).includes(value);
}

/** The feature a tool belongs to, if it is one that can be switched off. */
export function featureOfTool(name: string): McpFeature | undefined {
	return mcpFeatures.find(f => featureTools[f].some(t => t.endsWith('_') ? name.startsWith(t) : name === t));
}

/** The features switched off, from the setting's raw value: unknown entries and other types are ignored. */
export function readDisabledFeatures(value: unknown): ReadonlySet<McpFeature> {
	return new Set(Array.isArray(value) ? value.filter(isMcpFeature) : []);
}

/** The sentence a tool of a switched-off feature answers with. */
export function featureOffMessage(name: string): string {
	return `The user turned off ${name} in Chat Settings → MCP. Do not try again; do without it, or ask the user to turn it back on.`;
}
