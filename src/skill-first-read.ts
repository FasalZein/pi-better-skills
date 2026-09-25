import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	contentText,
	realpathOrResolve,
	resultConfirmsFullSkillBody,
	skillDocument,
	type SkillCatalog,
	type SkillDocument,
	type SkillRecord,
} from "./skill-catalog";
import { skillContextBlock } from "./skill-delivery";
import { outputViews, skillLoadEvidence } from "./skill-load-evidence";

/**
 * First-load completeness. Models often load a SKILL.md with a line range
 * (for example offset=1, limit=200) and may never read the rest, so rules at
 * the end of the file never enter context. The first load of each SKILL.md in
 * a session therefore delivers the whole file: a `read` loses its line range
 * and its result becomes the complete file, even past pi's 2000-line/50KB cap;
 * any other tool whose output shows part of the file gets the complete body
 * appended, whatever the tool is called and however it names the file. Every later load is
 * left native, so the agent can page through a skill it is editing.
 *
 * "Session" means the active branch since its latest compaction: compaction
 * starts over, and tree navigation or resume rebuilds from the branch.
 */

export const PARTIAL_SKILL_READS_ENV = "PI_BETTER_SKILLS_PARTIAL_SKILL_READS";
const OPT_OUT_OFF_VALUES = new Set(["", "0", "false", "no", "off"]);
/** Same shape insertSkillContext recognizes. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

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
 * A first load may need completing; a later load names its skill so delivery
 * leaves the result exactly as the tool returned it.
 */
export type LoadOutcome = { completion?: Completion; laterLoad?: SkillRecord };

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

/**
 * One line telling the model what the appended copy is and when to read the
 * file itself. It appears once per skill per session, so it stays short.
 */
function firstLoadNote(bodyLine: number | undefined): string {
	const frontmatter = bodyLine === undefined ? "" : `; frontmatter omitted, body line 1 = file line ${bodyLine}`;
	return `First load: complete body${frontmatter}. Read the file only for exact contents, e.g. to edit this skill.`;
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
	 * The SKILL.md a successful result loaded, and whether the result already
	 * holds all of it. Any `read` of the file counts, even a ranged one. Any
	 * other tool counts when its output shows a run of consecutive file lines
	 * (skill-load-evidence.ts), so a grep hit or a stat that names the file is
	 * not a load. Candidates are the catalog plus a SKILL.md the input names,
	 * which covers files outside the catalog. The strongest run wins; a tie
	 * (identical text in two skills) names no skill.
	 */
	function loadedSkill(
		toolName: string,
		input: Record<string, unknown>,
		text: string,
		cwd: string,
	): { skill: SkillRecord; complete: boolean } | undefined {
		if (toolName === "read") {
			const skill = readTarget(input, cwd);
			return skill ? { skill, complete: false } : undefined;
		}
		if (toolName === "edit" || toolName === "write") return undefined;

		const candidates = new Map<string, SkillRecord>();
		for (const skill of catalog.skills.values()) candidates.set(skill.filePath, skill);
		for (const value of Object.values(input ?? {})) {
			const named = typeof value === "string" ? catalog.findSkillReferencedByCommand(value, cwd) : undefined;
			if (named && !candidates.has(named.filePath)) candidates.set(named.filePath, named);
		}

		const views = outputViews(text);
		let best: { skill: SkillRecord; complete: boolean; lines: number } | undefined;
		let tied = false;
		for (const skill of candidates.values()) {
			const doc = skillDocument(skill.filePath);
			const evidence = doc ? skillLoadEvidence(doc, views) : undefined;
			if (!doc || !evidence) continue;
			if (best && evidence.lines === best.lines) tied = true;
			if (!best || evidence.lines > best.lines) {
				const complete = evidence.complete || resultConfirmsFullSkillBody(text, doc.body);
				best = { skill, complete, lines: evidence.lines };
				tied = false;
			}
		}
		return best && !tied ? { skill: best.skill, complete: best.complete } : undefined;
	}

	/**
	 * The body, not the file: loading a skill to use it needs the
	 * instructions, as skill injectors deliver them. It rides in the same
	 * <skill name location> tag as pi's own skill blocks, which names the file
	 * even when the tool call did not, and lets residency see the body. The
	 * block carries its own directory context: a tool whose input never names
	 * the file is invisible to delivery.
	 */
	function completeBodyBlock(skill: SkillRecord, doc: SkillDocument, cwd: string): string {
		const hasFrontmatter = FRONTMATTER.test(doc.raw);
		// 1-based file line of the body's first line, so line-based edits made
		// from this copy can be mapped back to the file.
		const bodyLine = doc.raw.slice(0, doc.raw.indexOf(doc.body)).split("\n").length;
		return [
			`<skill name="${skill.name}" location="${skill.filePath}">`,
			firstLoadNote(hasFrontmatter ? bodyLine : undefined),
			"",
			skillContextBlock(skill, cwd),
			"",
			doc.body,
			"</skill>",
		].join("\n");
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
				const load = loadedSkill(message.toolName, calls.get(message.toolCallId) ?? {}, contentText(message.content), ctx.cwd);
				if (load) loaded.add(keyOf(load.skill));
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
	 * Record the load. A first load that is not complete yet gets a
	 * completion; a later load is reported so it stays native. Failed results
	 * never count.
	 */
	function completeResult(event: ToolResultEvent, ctx: ExtensionContext): LoadOutcome {
		const firstRead = inFlight.get(event.toolCallId);
		inFlight.delete(event.toolCallId);
		if (event.isError) return {};

		if (firstRead) {
			loaded.add(keyOf(firstRead));
			const raw = readRaw(firstRead);
			if (raw === undefined || contentText(event.content) === raw) return {};
			// Keep non-text blocks; the whole file replaces pi's (possibly capped) text.
			return {
				completion: {
					content: [{ type: "text", text: raw }, ...event.content.filter((block) => block.type !== "text")],
					details: detailsWithoutTruncation(event.details),
				},
			};
		}

		const text = contentText(event.content);
		const load = loadedSkill(event.toolName, event.input, text, ctx.cwd);
		if (!load) return {};
		const { skill, complete } = load;
		const key = keyOf(skill);
		// A parallel first read still in flight makes this one a later load.
		const first = !seen(key);
		loaded.add(key);
		if (!first) return { laterLoad: skill };
		if (complete || event.toolName === "read" || !fullFirstSkillReadEnabled()) return {};
		const doc = skillDocument(skill.filePath);
		if (!doc) return {};
		return { completion: { content: [...event.content, { type: "text", text: completeBodyBlock(skill, doc, ctx.cwd) }] } };
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
