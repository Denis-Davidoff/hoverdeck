/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A workflow's variables: what each finished step left behind, written into a
 * later prompt as `{{steps.<name|number|prev>.<field>}}` and `{{params.<name>}}`,
 * and handed to a later shell step as environment variables.
 *
 * A shell command is never filled in. Its text is what the user wrote, and
 * every value — a parameter, a model's reply, another command's output —
 * reaches it only as an environment variable (`shellEnv`), so nothing a value
 * holds can be read as shell syntax. The command quotes them itself
 * (`"$STEP_TEST_STDOUT"`).
 *
 * A leaf module with no `vscode` and no relative value imports, so `npm test`
 * loads it directly.
 */

/** What one finished step left: a shell step's streams and exit code, an agent step's reply. */
export interface StepOutput {
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
	readonly reply?: string;
	/** A decision step's chosen option, as its label. */
	readonly choice?: string;
}

/** A finished step, in run order: its 1-based number in the skill, its name if it has one. */
export interface StepRecord {
	readonly number: number;
	readonly name?: string;
	readonly output: StepOutput;
}

/** The fields a step offers, in the order the editor lists them. */
export const shellFields = ['stdout', 'stderr', 'exitCode', 'output'] as const;
export const agentFields = ['reply', 'output'] as const;
/** A decision step's: what it chose, beside its reply. */
export const decideFields = ['choice', 'reply', 'output'] as const;
export type StepField = 'stdout' | 'stderr' | 'exitCode' | 'reply' | 'output' | 'choice';

/** The longest value written into a prompt, in characters; the tail is kept, where a log's error usually is. */
export const promptValueLimit = 100_000;
/**
 * The longest value in one environment variable. Lower than in a prompt: the
 * environment and the arguments share one limit (1 MB on macOS), and ten
 * steps carry three streams each.
 */
export const envValueLimit = 16_000;

/** A step's value for a field, or undefined where it has none. `output` is the stdout of a command and the reply of an agent. */
export function stepValue(output: StepOutput, field: StepField): string | undefined {
	switch (field) {
		case 'stdout': return output.stdout;
		case 'stderr': return output.stderr;
		case 'exitCode': return output.exitCode === undefined ? undefined : String(output.exitCode);
		case 'reply': return output.reply;
		case 'output': return output.stdout ?? output.reply;
		case 'choice': return output.choice;
	}
}

/** The step a reference names: `prev`, a 1-based number, or a name; only steps that have run. */
export function findStep(records: readonly StepRecord[], ref: string): StepRecord | undefined {
	if (ref === 'prev') {
		return records[records.length - 1];
	}
	// The latest run of it: a step can run again after a jump back.
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (/^\d+$/.test(ref) ? record.number === Number(ref) : record.name === ref) {
			return record;
		}
	}
	return undefined;
}

/**
 * The text with each `{{steps.X.field}}` and `{{params.name}}` replaced. A
 * reference to a step that has not run, or a field it does not have, is left
 * as written, so the reader sees what was meant rather than a gap.
 */
export function fillVars(text: string, params: Readonly<Record<string, string>>, records: readonly StepRecord[]): string {
	return text.replace(/\{\{\s*(steps|params)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z]+))?\s*\}\}/g, (whole, scope: string, ref: string, field: string | undefined) => {
		if (scope === 'params') {
			return field === undefined && Object.prototype.hasOwnProperty.call(params, ref) ? params[ref] : whole;
		}
		const record = findStep(records, ref);
		if (!record || !field || !isField(field)) {
			return whole;
		}
		const value = stepValue(record.output, field);
		return value === undefined ? whole : capTail(value, promptValueLimit);
	});
}

/**
 * The environment a shell step adds: `PARAM_<NAME>` for each parameter, and
 * `STEP_<N>_<FIELD>`, `STEP_<NAME>_<FIELD>` and `STEP_PREV_<FIELD>` for each
 * finished step. Each value is cut to `envValueLimit`, keeping its tail.
 */
export function shellEnv(params: Readonly<Record<string, string>>, records: readonly StepRecord[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(params)) {
		env[`PARAM_${envName(name)}`] = capTail(value, envValueLimit);
	}
	const put = (key: string, output: StepOutput) => {
		for (const field of ['stdout', 'stderr', 'exitCode', 'reply', 'output', 'choice'] as const) {
			const value = stepValue(output, field);
			if (value !== undefined) {
				env[`STEP_${key}_${field.toUpperCase()}`] = capTail(value, envValueLimit);
			}
		}
	};
	// In run order, so a step that ran twice leaves its latest values.
	for (const record of records) {
		put(String(record.number), record.output);
		if (record.name) {
			put(envName(record.name), record.output);
		}
	}
	const last = records[records.length - 1];
	if (last) {
		put('PREV', last.output);
	}
	return env;
}

/** A name as an environment variable part: upper case, anything else than a letter, digit or `_` as `_`. */
export function envName(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

/**
 * The value's last `limit` characters, with a line saying how much was cut —
 * never inside a surrogate pair, whose lone half a strict JSON reader refuses.
 */
export function capTail(value: string, limit: number): string {
	if (value.length <= limit) {
		return value;
	}
	let start = value.length - limit;
	const code = value.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) {
		start++;
	}
	return `[… ${start} characters cut]\n${value.slice(start)}`;
}

function isField(field: string): field is StepField {
	return field === 'stdout' || field === 'stderr' || field === 'exitCode' || field === 'reply' || field === 'output' || field === 'choice';
}
