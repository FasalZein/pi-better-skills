import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	contentText,
	realpathOrResolve,
	resultConfirmsFullSkillBody,
	resultConfirmsSkillBody,
	skillDocument,
	type SkillCatalog,
	type SkillRecord,
} from "./skill-catalog";

/**
 * First-load completeness. Models often load a SKILL.md with a line range
 * (for example offset=1, limit=200) and may never read the rest, so rules at
 * the end of the file never enter context. The first load of each SKILL.md in
 * a session therefore delivers the whole file: a `read` loses its line range
 * and its result becomes the complete file, even past pi's 2000-line/50KB cap;
 * a partial shell load gets the complete file appended. Every later load is
 * left native, so the agent can page through a skill it is editing.
 *
 * "Session" means the active branch since its latest compaction: compaction
 * starts over, and tree navigation or resume rebuilds from the branch.
 */

export const PARTIAL_SKILL_READS_ENV = "PI_BETTER_SKILLS_PARTIAL_SKILL_READS";
const OPT_OUT_OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/** Default-on; PI_BETTER_SKILLS_PARTIAL_SKILL_READS=1 restores pi's native partial reads. */
export function fullFirstSkillReadEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env[PARTIAL_SKILL_READS_ENV];
	return value === undefined || OPT_OUT_OFF_VALUES.has(value.toLowerCase());
}

type ToolCallEvent = { toolName: string; toolCallId: string; input: Record<string, unknown> };
type ToolResultEvent = ToolCallEvent & { content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean };
type Block = ToolResultEvent["content"][number];
/** Replacement content, plus replacement details when the old ones would misdescribe it. */
type Completion = { content: Block[]; details?: Record<string, unknown> };

/**
 * pi's read renderer warns "Truncated: showing N of M lines" from
 * `details.truncation`. The completed result is the whole file, so the record
 * is dropped; other details stay. Pi applies any replacement details that
 * are not undefined, so an empty object clears the record too.
 */
function detailsWithoutTruncation(details: unknown): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object" || !("truncation" in details)) return undefined;
	const { truncation: _dropped, ...rest } = details as Record<string, unknown>;
	return rest;
}

export type SkillFirstRead = ReturnType<typeof createSkillFirstRead>;

export function createSkillFirstRead(catalog: SkillCatalog) {
	/** SKILL.md files (by real path) loaded on this branch since its latest compaction. */
	let loaded = new Set<string>();
	/** First reads whose result has not arrived yet, by tool call id. */
	let inFlight = new Map<string, SkillRecord>();

	const keyOf = (skill: SkillRecord) => realpathOrResolve(skill.filePath);
	const seen = (key: string) => loaded.has(key) || [...inFlight.values()].some((skill) => keyOf(skill) === key);

	function readTarget(input: Record<string, unknown>, cwd: string): SkillRecord | undefined {
		return typeof input.path === "string" ? catalog.findSkillForPath(resolve(cwd, input.path)) : undefined;
	}

	/**
	 * The SKILL.md a successful result loaded. Any `read` of the file counts,
	 * even a ranged one. Other tools count only when their output shows the
	 * body's opening, so a grep or stat that names the file is not a load.
	 */
	function loadedSkill(toolName: string, input: Record<string, unknown>, text: string, cwd: string): SkillRecord | undefined {
		if (toolName === "read") return readTarget(input, cwd);
		if (toolName === "edit" || toolName === "write") return undefined;
		for (const value of Object.values(input ?? {})) {
			if (typeof value !== "string") continue;
			const skill = catalog.findSkillReferencedByCommand(value, cwd);
			if (!skill) continue;
			const body = skillDocument(skill.filePath)?.body;
			return body && resultConfirmsSkillBody(text, body) ? skill : undefined;
		}
		return undefined;
	}

	function readRaw(skill: SkillRecord): string | undefined {
		try {
			return readFileSync(skill.filePath, "utf-8");
		} catch {
			return undefined;
		}
	}

	/** Rebuild from the active branch, counting only entries after its latest compaction. */
	function rebuild(ctx: ExtensionContext): void {
		inFlight = new Map();
		loaded = new Set();
		const branch = ctx.sessionManager.getBranch();
		let start = 0;
		branch.forEach((entry, index) => {
			if (entry.type === "compaction") start = index + 1;
		});
		const calls = new Map<string, Record<string, unknown>>();
		for (const entry of branch.slice(start)) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") calls.set(block.id, block.arguments);
				}
			} else if (message.role === "toolResult" && !message.isError) {
				const skill = loadedSkill(message.toolName, calls.get(message.toolCallId) ?? {}, contentText(message.content), ctx.cwd);
				if (skill) loaded.add(keyOf(skill));
			}
		}
	}

	/** A first `read` of a SKILL.md loses its line range; pi's cap is lifted in `completeResult`. */
	function prepareRead(event: ToolCallEvent, ctx: ExtensionContext): void {
		if (event.toolName !== "read" || !fullFirstSkillReadEnabled()) return;
		const skill = readTarget(event.input, ctx.cwd);
		if (!skill || seen(keyOf(skill))) return;
		inFlight.set(event.toolCallId, skill);
		delete event.input.offset;
		delete event.input.limit;
	}

	/**
	 * Record the load and return a completion when this result is a first
	 * load that is not complete yet. Failed results never count.
	 */
	function completeResult(event: ToolResultEvent, ctx: ExtensionContext): Completion | undefined {
		const firstRead = inFlight.get(event.toolCallId);
		inFlight.delete(event.toolCallId);
		if (event.isError) return undefined;

		if (firstRead) {
			loaded.add(keyOf(firstRead));
			const raw = readRaw(firstRead);
			if (raw === undefined || contentText(event.content) === raw) return undefined;
			// Keep non-text blocks; the whole file replaces pi's (possibly capped) text.
			return {
				content: [{ type: "text", text: raw }, ...event.content.filter((block) => block.type !== "text")],
				details: detailsWithoutTruncation(event.details),
			};
		}

		const text = contentText(event.content);
		const skill = loadedSkill(event.toolName, event.input, text, ctx.cwd);
		if (!skill) return undefined;
		const key = keyOf(skill);
		const first = !loaded.has(key);
		loaded.add(key);
		if (!first || event.toolName === "read" || !fullFirstSkillReadEnabled()) return undefined;
		const body = skillDocument(skill.filePath)?.body;
		const raw = readRaw(skill);
		if (!body || raw === undefined || resultConfirmsFullSkillBody(text, body)) return undefined;
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: `[pi-better-skills: the output above is part of ${skill.filePath}. This is the first load of this skill in the session, so the complete file follows.]\n\n${raw}`,
				},
			],
		};
	}

	/** Calls that were blocked before running never produce a result; drop them at turn end. */
	function settle(): void {
		inFlight = new Map();
	}

	function clear(): void {
		loaded = new Set();
		inFlight = new Map();
	}

	return { rebuild, prepareRead, completeResult, settle, clear };
}
