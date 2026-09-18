import { resolve } from "node:path";

/**
 * Generic, tool-agnostic extraction of filesystem path candidates from
 * arbitrary tool input. Only structured path-naming keys count: a tool that
 * opens a file names it in a dedicated key (`path`, `file_path`, ...), so
 * keying on those instead of tool identity keeps globs auto-injection working
 * under any tool replacement (MCP file tools, wrapped editors, ...).
 *
 * Free-form strings such as shell commands are deliberately not scanned. A
 * command line mentions paths it never opens (`ls`, `git log -- file`, `rm`),
 * and treating a mention as a file visit made auto-injection fire on commands
 * that put no file content in context.
 */

const PATH_KEYS = new Set([
	"path",
	"file",
	"filepath",
	"file_path",
	"workdir",
	"cwd",
	"directory",
	"dir",
	"notebookpath",
	"notebook_path",
]);

const BASE_KEYS = new Set(["workdir", "cwd", "directory", "dir"]);

const MAX_DEPTH = 2;
const MAX_CANDIDATES = 16;

type CandidateAdder = (raw: string, base: string) => void;

function cleanValue(raw: string) {
	return raw
		.trim()
		.replace(/^['"`]|['"`]$/g, "")
		.replace(/[,;:]+$/, "")
		.trim();
}

function resolveRecordBase(entries: Array<[string, unknown]>, base: string, addCandidate: CandidateAdder) {
	let recordBase = base;
	for (const [key, child] of entries) {
		const normalizedKey = key.toLowerCase();
		if (typeof child === "string" && BASE_KEYS.has(normalizedKey)) {
			const cleaned = cleanValue(child);
			if (cleaned) {
				recordBase = resolve(base, cleaned);
				addCandidate(recordBase, base);
			}
		}
	}
	return recordBase;
}

function walkEntries(entries: Array<[string, unknown]>, depth: number, recordBase: string, addCandidate: CandidateAdder) {
	for (const [key, child] of entries) {
		const normalizedKey = key.toLowerCase();
		if (typeof child === "string") {
			// BASE_KEYS values were already added as candidates while resolving recordBase.
			if (PATH_KEYS.has(normalizedKey) && !BASE_KEYS.has(normalizedKey)) addCandidate(child, recordBase);
		} else {
			walkValue(child, depth + 1, recordBase, addCandidate);
		}
	}
}

function walkValue(value: unknown, depth: number, base: string, addCandidate: CandidateAdder) {
	if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;

	const entries = Object.entries(value as Record<string, unknown>);
	const recordBase = resolveRecordBase(entries, base, addCandidate);
	walkEntries(entries, depth, recordBase, addCandidate);
}

/**
 * Extract filesystem-looking candidates from arbitrary tool input.
 *
 * @param input - Structured or free-form tool input to inspect.
 * @param baseDir - Directory used to resolve relative candidates.
 * @returns Deduplicated absolute path candidates in discovery order.
 */
export function extractPathCandidates(input: unknown, baseDir: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const addRelativeTo = (raw: string, base: string) => {
		if (candidates.length >= MAX_CANDIDATES) return;
		const cleaned = cleanValue(raw);
		if (!cleaned) return;
		const resolved = resolve(base, cleaned);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			candidates.push(resolved);
		}
	};

	walkValue(input, 0, baseDir, addRelativeTo);
	return candidates;
}
