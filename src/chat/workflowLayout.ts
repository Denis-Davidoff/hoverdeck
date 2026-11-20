/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A workflow drawn as a read-only graph: the steps in a column, the main flow
 * straight down between them, and every other route as a line in a lane of its
 * own — routes back on the left, skips forward on the right — so no two lines
 * share a stretch. What ends the run (finish, stop) is written inside the step
 * that ends it rather than drawn, which keeps the lanes for what moves.
 *
 * Only what the user chose is drawn: an error that stops the workflow is the
 * default and goes unsaid.
 *
 * A leaf module with no `vscode` and no relative value imports (the shapes are
 * structural, `RoutedStep` is read by type only), so `npm test` loads it
 * directly and the editor's webview bundles it.
 */

import type { RoutedStep, RouteTarget } from './workflowGraph';

export interface LayoutStep extends RoutedStep {
	/** The step's title as the editor shows it: `1 · lint`. */
	readonly title: string;
}

export type EdgeTone = 'success' | 'failure' | 'choice';

export interface LayoutNode {
	readonly index: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly title: string;
	readonly kind: RoutedStep['kind'];
	/** The outcomes that end the run here, in words: `No → finish`. */
	readonly ends: readonly string[];
}

export interface LayoutEdge {
	readonly from: number;
	readonly to: number;
	readonly tone: EdgeTone;
	readonly label: string;
	readonly back: boolean;
	/** The SVG path, already routed through its lane. */
	readonly path: string;
	readonly labelX: number;
	readonly labelY: number;
	readonly anchor: 'start' | 'end' | 'middle';
}

export interface WorkflowLayout {
	readonly width: number;
	readonly height: number;
	readonly nodes: readonly LayoutNode[];
	readonly edges: readonly LayoutEdge[];
}

export const nodeWidth = 220;
export const nodeHeight = 40;
export const rowGap = 26;
export const laneGap = 16;
/** Room beside the outermost lane for its label. */
const labelRoom = 70;

interface Route {
	from: number;
	to: number;
	tone: EdgeTone;
	label: string;
	back: boolean;
	side: 'left' | 'right';
	/** The main flow: straight down to the next step, no lane. */
	straight: boolean;
	lane: number;
}

/** Where a route goes, as an index; undefined for the run's end. */
function targetIndex(target: RouteTarget, at: number, count: number, ids: readonly string[]): number | 'done' | 'fail' {
	switch (target.kind) {
		case 'next': return at + 1 < count ? at + 1 : 'done';
		case 'done': return 'done';
		case 'fail': return 'fail';
		case 'step': {
			const index = ids.indexOf(target.step);
			return index < 0 ? 'fail' : index;
		}
	}
}

function backLabel(target: RouteTarget): string {
	return target.kind === 'step' && target.times ? ` ×${target.times}` : '';
}

/** The graph's geometry for the given steps. */
export function layoutWorkflow(steps: readonly LayoutStep[]): WorkflowLayout {
	const count = steps.length;
	const ids = steps.map(s => s.id);
	const routes: Route[] = [];
	const ends: string[][] = steps.map(() => []);
	steps.forEach((step, at) => {
		const outs: { target: RouteTarget; tone: EdgeTone; label: string; isDefault: boolean }[] = [];
		if (step.choices) {
			for (const choice of step.choices) {
				outs.push({ target: choice.route, tone: 'choice', label: choice.label, isDefault: false });
			}
		} else {
			outs.push({ target: step.onSuccess, tone: 'success', label: step.kind === 'shell' ? 'exit 0' : 'done', isDefault: step.onSuccess.kind === 'next' });
		}
		outs.push({ target: step.onFailure, tone: 'failure', label: step.kind === 'shell' ? 'exit ≠ 0' : step.choices ? 'error / none' : 'error', isDefault: step.onFailure.kind === 'fail' });
		for (const out of outs) {
			const to = targetIndex(out.target, at, count, ids);
			if (to === 'done' || to === 'fail') {
				// The default ends say nothing: the last step finishing, an error stopping the run.
				if (!out.isDefault) {
					ends[at].push(`${out.label} → ${to === 'done' ? 'finish' : 'stop'}`);
				}
				continue;
			}
			const back = to <= at;
			const straight = !back && to === at + 1 && out.tone !== 'failure';
			routes.push({
				from: at, to, tone: out.tone, back, straight, lane: 0,
				label: `${out.tone === 'success' && straight ? '' : out.label}${back ? backLabel(out.target) : ''}`,
				side: back ? 'left' : 'right',
			});
		}
	});

	// Lanes: shortest spans first, each in the innermost lane its span does not share.
	const laned = routes.filter(r => !r.straight).sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from) || a.from - b.from);
	const taken: Record<'left' | 'right', [number, number][][]> = { left: [], right: [] };
	for (const route of laned) {
		const span: [number, number] = [Math.min(route.from, route.to), Math.max(route.from, route.to)];
		const lanes = taken[route.side];
		let lane = 0;
		while (lanes[lane]?.some(([a, b]) => span[0] <= b && a <= span[1])) {
			lane++;
		}
		(lanes[lane] ??= []).push(span);
		route.lane = lane;
	}
	const leftLanes = taken.left.length;
	const rightLanes = taken.right.length;
	const nodeX = (leftLanes ? leftLanes * laneGap + labelRoom : 8);
	const width = nodeX + nodeWidth + (rightLanes ? rightLanes * laneGap + labelRoom : 8);
	const rowY = (i: number) => 8 + i * (nodeHeight + rowGap);
	const nodes: LayoutNode[] = steps.map((step, i) => ({
		index: i, x: nodeX, y: rowY(i), width: nodeWidth, height: nodeHeight, title: step.title, kind: step.kind, ends: ends[i],
	}));

	// Several lines leave or reach one side of a node: spread their ports over its height,
	// outgoing above incoming, so a route back to the step itself has two ends.
	const portY = (node: number, side: 'left' | 'right', which: 'out' | 'in', route: Route): number => {
		const all: [Route, 'out' | 'in'][] = [];
		for (const r of laned) {
			if (r.side !== side) { continue; }
			if (r.from === node) { all.push([r, 'out']); }
		}
		for (const r of laned) {
			if (r.side !== side) { continue; }
			if (r.to === node) { all.push([r, 'in']); }
		}
		const k = all.findIndex(([r, w]) => r === route && w === which);
		return rowY(node) + (nodeHeight / (all.length + 1)) * (k + 1);
	};

	const edges: LayoutEdge[] = [];
	// The main flow, one segment per pair of steps, its labels joined (two choices may both go on).
	const straight = new Map<number, Route[]>();
	for (const route of routes.filter(r => r.straight)) {
		(straight.get(route.from) ?? straight.set(route.from, []).get(route.from)!).push(route);
	}
	for (const [from, group] of straight) {
		const cx = nodeX + nodeWidth / 2;
		const y1 = rowY(from) + nodeHeight;
		const y2 = rowY(from + 1);
		const label = group.map(r => r.label).filter(Boolean).join(', ');
		edges.push({
			from, to: from + 1, tone: group[0].tone, label, back: false,
			path: `M ${cx} ${y1} L ${cx} ${y2 - 1}`, labelX: cx + 8, labelY: (y1 + y2) / 2 + 4, anchor: 'start',
		});
	}
	for (const route of laned) {
		const left = route.side === 'left';
		const sideX = left ? nodeX : nodeX + nodeWidth;
		const laneX = left ? nodeX - (route.lane + 1) * laneGap : nodeX + nodeWidth + (route.lane + 1) * laneGap;
		const y1 = portY(route.from, route.side, 'out', route);
		const y2 = portY(route.to, route.side, 'in', route);
		const tip = left ? sideX - 1 : sideX + 1;
		edges.push({
			from: route.from, to: route.to, tone: route.tone, label: route.label, back: route.back,
			path: `M ${sideX} ${y1} L ${laneX} ${y1} L ${laneX} ${y2} L ${tip} ${y2}`,
			labelX: left ? laneX - 4 : laneX + 4,
			labelY: (y1 + y2) / 2 + 4,
			anchor: left ? 'end' : 'start',
		});
	}
	return { width, height: rowY(count) - rowGap + 8, nodes, edges };
}
