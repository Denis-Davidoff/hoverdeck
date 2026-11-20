/**
 * The toolbar's skills as the `skill_list` / `skill_get` MCP tools give them to
 * an agent: a short catalogue to choose from, then one skill whole, to follow.
 * Modelled on VS Code Copilot's `skill` tool (1.147): the model sees names and
 * descriptions, picks one, and loads its instructions before it does the task.
 *
 * Read-only on purpose. Nothing here runs a skill: the agent follows the steps
 * itself, in its own conversation, so every command and edit goes through its
 * own approvals. A tool that *ran* a workflow would run its shell steps with no
 * card at all.
 *
 * Leaf module, under test: type imports only.
 */

import type { AgentId, ToolbarParam, ToolbarRoute, ToolbarSkill } from './chatProtocol';

/** Bounds on what goes into a tool result. */
const descriptionChars = 300;

/** One line of the skill's own words, for the catalogue: its tooltip, else its label, else its prompt's first line. */
export function skillDescription(skill: ToolbarSkill): string {
	const own = skill.tooltip?.trim() || skill.label?.trim() || skill.prompt.split('\n').map(l => l.trim()).find(l => l && !/^#+\s*$/.test(l)) || '';
	const line = own.replace(/\s+/g, ' ').replace(/^#+\s*/, '');
	return line.length > descriptionChars ? `${line.slice(0, descriptionChars - 1)}…` : line;
}

/** Whether a skill is offered to an agent; with no agent known, every skill is. */
export function skillOfferedTo(skill: ToolbarSkill, agent: AgentId | undefined): boolean {
	return skill.agents === 'all' || agent === undefined || skill.agents === agent;
}

function stepsOf(skill: ToolbarSkill): number {
	return 1 + (skill.followUps?.length ?? 0);
}

function paramOf(p: ToolbarParam) {
	return {
		name: p.name,
		type: p.type,
		...(p.options ? { options: p.options } : {}),
		...(p.maxLength ? { maxLength: p.maxLength } : {}),
		...(p.preset ? { preset: p.preset } : {}),
	};
}

/** One row of `skill_list`. */
export function skillSummary(skill: ToolbarSkill) {
	const shellSteps = skill.workflow?.filter(s => s?.shell).length ?? 0;
	return {
		name: skill.name,
		description: skillDescription(skill),
		...(skill.agents !== 'all' ? { agent: skill.agents } : {}),
		...(skill.params.length ? { params: skill.params.map(p => p.name) } : {}),
		...(stepsOf(skill) > 1 ? { steps: stepsOf(skill) } : {}),
		...(skill.workflow ? { workflow: true } : {}),
		...(shellSteps ? { shellSteps } : {}),
	};
}

function routeText(route: ToolbarRoute | undefined, fallback: string): string {
	if (!route) { return fallback; }
	if (route.to !== 'step') { return route.to === 'next' ? 'go on to the next step' : route.to === 'done' ? 'stop: the skill is done' : 'stop: the skill failed'; }
	const again = route.times ? ` (at most ${route.times} time${route.times === 1 ? '' : 's'}, then ${route.whenSpent === 'next' ? 'go on to the next step' : 'stop: the skill failed'})` : '';
	return `go to step ${route.step + 1}${again}`;
}

/** How the agent is to use what `skill_get` returns. */
export const skillInstruction = 'These are the user\'s own instructions, saved as a toolbar skill. Follow them yourself, in this conversation, '
	+ 'as if the user had written them in their message: run every command and make every edit with your own tools, under your '
	+ 'own approvals. Fill each {{param}} from the user\'s request; when a value is not there, ask the user rather than guessing. '
	+ 'In a workflow, {{steps.<name or number>.<field>}} means what an earlier step produced (its reply, or a command\'s stdout, '
	+ 'stderr and exitCode), and a shell step\'s "$STEP_…" and "$PARAM_…" variables are those values. Do the steps in order and '
	+ 'take the routes as written. Do not call skill_get again for this skill.';

/** `skill_get`: the skill whole, every step in order. */
export function skillDocument(skill: ToolbarSkill) {
	const prompts = [skill.prompt, ...(skill.followUps ?? []).map(f => f.prompt)];
	const workflow = skill.workflow;
	const steps = prompts.map((text, i) => {
		const kind = workflow?.[i];
		const check = i > 0 ? skill.followUps?.[i - 1]?.check : undefined;
		const last = i === prompts.length - 1;
		return {
			step: i + 1,
			...(kind?.name ? { name: kind.name } : {}),
			kind: kind?.shell ? 'shell' : kind?.choices ? 'decision' : 'prompt',
			...(kind?.shell ? { command: text } : { prompt: text }),
			...(check ? { onlyIf: `Do this step only if this holds after the step before: ${check}` } : {}),
			...(kind?.choices ? {
				choices: kind.choices.map((c, n) => ({ option: n + 1, label: c.label, then: routeText(c.route, 'go on to the next step') })),
				ifNoChoice: routeText(kind.onFailure, 'stop: the skill failed'),
			} : workflow ? {
				onSuccess: routeText(kind?.onSuccess, last ? 'stop: the skill is done' : 'go on to the next step'),
				onFailure: routeText(kind?.onFailure, 'stop: the skill failed'),
			} : {}),
		};
	});
	return {
		name: skill.name,
		description: skillDescription(skill),
		...(skill.agents !== 'all' ? { agent: skill.agents } : {}),
		...(skill.params.length ? { params: skill.params.map(paramOf) } : {}),
		...(workflow ? { workflow: true } : {}),
		steps,
		instruction: skillInstruction,
	};
}

/** The sentence for a name that is not a skill: the names there are, so the model can correct itself. */
export function skillNotFound(name: string, available: readonly string[]): string {
	return available.length
		? `No toolbar skill is named "${name}". Available skills: ${available.join(', ')}. Call skill_list for their descriptions.`
		: `No toolbar skill is named "${name}": the user has saved none for this agent.`;
}
