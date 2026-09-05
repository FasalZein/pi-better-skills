import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { extractPathCandidates } from "../tool-paths";

describe("extractPathCandidates (structured keys)", () => {
	it("resolves a relative path key against the base dir", () => {
		expect(extractPathCandidates({ path: "src/components/Button.widget" }, "/repo")).toEqual([
			resolve("/repo/src/components/Button.widget"),
		]);
	});

	it("keeps absolute paths and dedupes repeated candidates", () => {
		expect(extractPathCandidates({ path: "/repo/a.ts", file_path: "/repo/a.ts" }, "/repo")).toEqual(["/repo/a.ts"]);
	});

	it("ignores non-string and empty values", () => {
		expect(extractPathCandidates({ path: 7, filePath: "", nested: { path: null } }, "/repo")).toEqual([]);
	});
});

describe("extractPathCandidates (command string tokens)", () => {
	it("extracts path-looking tokens from arbitrary string values", () => {
		expect(extractPathCandidates({ cmd: "cat src/components/Button.widget" }, "/repo")).toEqual([
			resolve("/repo/src/components/Button.widget"),
		]);
	});

	it("resolves tokens against a workdir base key in the same record", () => {
		expect(extractPathCandidates({ cmd: "sed -n 1,5p tests/helper.ts", workdir: "/repo/src" }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/tests/helper.ts"),
		]);
	});

	it("skips flags, plain words, URLs, and line-range suffixes", () => {
		expect(
			extractPathCandidates(
				{ cmd: "rg -n --hidden foo tests/a.ts:10 https://example.com/x.md plain", workdir: "/repo" },
				"/repo",
			),
		).toEqual([resolve("/repo"), resolve("/repo/tests/a.ts")]);
	});

	it("ignores blank command tokens and blank base keys", () => {
		expect(extractPathCandidates({ command: "   ", workdir: "  " }, "/repo")).toEqual([]);
	});

	it("does not re-emit a relative workdir as its own child path", () => {
		expect(extractPathCandidates({ workdir: "src", cmd: "cat helper.ts" }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/helper.ts"),
		]);
	});

	it("walks nested records with their base and stops at the depth limit", () => {
		expect(
			extractPathCandidates(
				{
					details: {
						cwd: "/repo/src",
						command: "cat helper.ts",
						deeper: { ignored: { path: "not-reached.ts" } },
					},
				},
				"/repo",
			),
		).toEqual([resolve("/repo/src"), resolve("/repo/src/helper.ts")]);
	});

	it("includes candidates at the maximum nested-record depth", () => {
		expect(extractPathCandidates({ level1: { level2: { path: "files/depth-two.ts" } } }, "/repo")).toEqual([
			resolve("/repo/files/depth-two.ts"),
		]);
	});

	it("enforces the candidate and string-scan budgets", () => {
		const tokens = Array.from({ length: 20 }, (_, index) => `files/${index}.ts`).join(" ");
		expect(extractPathCandidates({ command: tokens }, "/repo")).toHaveLength(16);
		expect(extractPathCandidates({ command: `${"x".repeat(16 * 1024)} files/late.ts` }, "/repo")).toEqual([]);

		const exactPath = "files/exact-limit.ts";
		const exactLengthCommand = `${"x".repeat(16 * 1024 - exactPath.length - 1)} ${exactPath}`;
		expect(exactLengthCommand).toHaveLength(16 * 1024);
		expect(extractPathCandidates({ command: exactLengthCommand }, "/repo")).toEqual([
			resolve("/repo/files/exact-limit.ts"),
		]);
	});
});
