import type { SkillDocument } from "./skill-catalog";

/**
 * Tool-agnostic evidence that a tool result shows part of a SKILL.md. Tools
 * differ in how they name files (plain paths, notebook code, computed paths)
 * and in which part of long output they keep (head, a window, or only the
 * tail). Output content is the one signal every tool shares, so evidence is
 * a run of consecutive file lines found in the output, wherever it starts.
 *
 * Lines are compared trimmed; blank lines are skipped on both sides. A leading
 * line-number prefix (cat -n, nl, grep -n, numbered read tools) is also
 * tolerated. Output that serializes text as escaped string literals (JSON,
 * nested JSON, single-quoted reprs) is also matched after decoding. Hash-
 * anchored or otherwise reformatted lines are not recognized.
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

function outputLines(text: string): OutputLines {
	return text
		.split("\n")
		.map(outputLineKeys)
		.filter((keys) => keys.length > 0);
}

/** One decode per nesting level: JSON inside a JSON string needs two. */
const MAX_DECODE_DEPTH = 2;
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "0": "\0" };

function unescapeLiteral(body: string): string {
	return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_match, code: string) => {
		if (code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
		return SIMPLE_ESCAPES[code] ?? code;
	});
}

/**
 * Contents of every double- or single-quoted literal that holds at least one
 * escape (the outer literal of double-encoded JSON holds only \\n and \").
 * A literal ends at its closing quote or, unterminated, at the line end.
 * Linear: an unterminated quote kind cannot close later on the same line,
 * so that kind is skipped until the next line (a regex here backtracks).
 */
function decodeLiterals(text: string): string | undefined {
	const decoded: string[] = [];
	let skipDouble = false;
	let skipSingle = false;
	let i = 0;
	while (i < text.length) {
		const char = text[i]!;
		if (char === "\n") {
			skipDouble = skipSingle = false;
			i++;
			continue;
		}
		if ((char !== '"' || skipDouble) && (char !== "'" || skipSingle)) {
			i++;
			continue;
		}
		let j = i + 1;
		let escaped = false;
		while (j < text.length && text[j] !== char && text[j] !== "\n") {
			if (text[j] === "\\") {
				escaped = true;
				j++;
			}
			j++;
		}
		if (j < text.length && text[j] === char) {
			if (escaped) decoded.push(unescapeLiteral(text.slice(i + 1, j)));
			i = j + 1;
		} else {
			if (char === '"') skipDouble = true;
			else skipSingle = true;
			i++;
		}
	}
	return decoded.length > 0 ? decoded.join("\n") : undefined;
}

/**
 * The output as match views: the text as printed, then the decoded contents
 * of escaped string literals, once per nesting level. Each view is matched on
 * its own, so a run never joins raw and decoded lines.
 */
export function outputViews(text: string): OutputLines[] {
	const views = [outputLines(text)];
	let current = text;
	for (let depth = 0; depth < MAX_DECODE_DEPTH && current.includes("\\"); depth++) {
		const decoded = decodeLiterals(current);
		if (decoded === undefined) break;
		views.push(outputLines(decoded));
		current = decoded;
	}
	return views;
}

/**
 * The longest run of consecutive file lines in any output view, and whether
 * one run covers the whole body through the file's last line. Undefined when
 * the longest run is too weak to count as a load.
 */
export function skillLoadEvidence(doc: SkillDocument, views: OutputLines[]): LoadEvidence | undefined {
	let best: Run | undefined;
	let complete = false;
	for (const view of views) {
		const found = longestRun(lineIndex(doc), view);
		if (found.best && (!best || found.best.length > best.length)) best = found.best;
		complete ||= found.complete;
	}
	if (!best || best.length < MIN_RUN_LINES || best.chars < MIN_RUN_CHARS) return undefined;
	return { lines: best.length, complete };
}

function longestRun(index: LineIndex, output: OutputLines): { best: Run | undefined; complete: boolean } {
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
	return { best, complete };
}
