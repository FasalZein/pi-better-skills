import type { SkillDocument } from "./skill-catalog";

/**
 * Tool-agnostic evidence that a tool result shows part of a SKILL.md. Tools
 * differ in how they name files (plain paths, notebook code, computed paths)
 * and in which part of long output they keep (head, a window, or only the
 * tail, as pi-codex-conversion's exec_command does). Output content is the
 * one signal every tool shares, so evidence is a run of consecutive file
 * lines found in the output, wherever the run starts.
 *
 * Lines are compared trimmed; blank lines are skipped on both sides. A leading
 * line-number prefix (cat -n, nl, grep -n, numbered read tools) is also
 * tolerated. Hash-anchored or otherwise reformatted lines are not recognized.
 */

/** A run shorter than this is too weak to call a load (a grep hit, a quoted rule). */
const MIN_RUN_LINES = 3;
/** Runs of short structural lines (---, ```, }) are not evidence. */
const MIN_RUN_CHARS = 40;
const LINE_NUMBER_PREFIX = /^\d+(?:[\t:|→]|\s{2,})\s*/;
/** A bare number: a numbered blank line (cat -n) or a real line holding only a number. */
const BARE_NUMBER = /^\d+$/;

type LineIndex = { lines: string[]; positions: Map<string, number[]>; bodyStart: number };
export type LoadEvidence = { lines: number; complete: boolean };

const indexCache = new WeakMap<SkillDocument, LineIndex>();

function nonBlankLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Cached per parsed document, which skillDocument re-creates when the file changes. */
function lineIndex(doc: SkillDocument): LineIndex {
	const cached = indexCache.get(doc);
	if (cached) return cached;
	const lines = nonBlankLines(doc.raw);
	const positions = new Map<string, number[]>();
	lines.forEach((line, index) => {
		const list = positions.get(line);
		if (list) list.push(index);
		else positions.set(line, [index]);
	});
	// The body is the file's suffix after the frontmatter.
	const index = { lines, positions, bodyStart: lines.length - nonBlankLines(doc.body).length };
	indexCache.set(doc, index);
	return index;
}

function outputLineKeys(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed) return [];
	const unnumbered = trimmed.replace(LINE_NUMBER_PREFIX, "");
	return unnumbered && unnumbered !== trimmed ? [trimmed, unnumbered] : [trimmed];
}

type Run = { length: number; chars: number; start: number };

/** Output lines as match keys; blank lines dropped. Split once, then test every skill. */
export type OutputLines = string[][];

export function outputLines(text: string): OutputLines {
	return text
		.split("\n")
		.map(outputLineKeys)
		.filter((keys) => keys.length > 0);
}

/**
 * The longest run of consecutive file lines in the output, and whether one run
 * covers the whole body through the file's last line. Undefined when the
 * longest run is too weak to count as a load.
 */
export function skillLoadEvidence(doc: SkillDocument, output: OutputLines): LoadEvidence | undefined {
	const index = lineIndex(doc);
	const last = index.lines.length - 1;
	let previous = new Map<number, Run>();
	let best: Run | undefined;
	let complete = false;

	for (const keys of output) {
		const current = new Map<number, Run>();
		for (const key of keys) {
			for (const position of index.positions.get(key) ?? []) {
				if (current.has(position)) continue;
				const before = previous.get(position - 1);
				const chars = index.lines[position]!.length;
				const run = before
					? { length: before.length + 1, chars: before.chars + chars, start: before.start }
					: { length: 1, chars, start: position };
				current.set(position, run);
				if (!best || run.length > best.length) best = run;
				if (position === last && run.start <= index.bodyStart) complete = true;
			}
		}
		// A bare number may be a numbered blank line (cat -n), which must not
		// break a run, or a real file line, which may extend one: keep both.
		if (BARE_NUMBER.test(keys[0]!)) {
			for (const [position, run] of previous) if (!current.has(position)) current.set(position, run);
		}
		previous = current;
	}

	if (!best || best.length < MIN_RUN_LINES || best.chars < MIN_RUN_CHARS) return undefined;
	return { lines: best.length, complete };
}
