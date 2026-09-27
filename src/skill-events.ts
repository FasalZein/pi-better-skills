import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillSuggestions, type SkillAutocompleteSkill } from "./skill-autocomplete";

export const SKILL_API_CHANNEL = "pi-better-skills/v1/request";
export const SKILL_API_VERSION = 1;

export type SkillDeliveryOutcome = { name: string; status: "delivered" | "already-resident" | "unknown" };
export type SkillApiReply =
	| { version: 1; operation: "probe"; available: true }
	| { version: 1; operation: "suggest"; items: Array<{ value: string; label: string }> }
	| { version: 1; operation: "deliver"; outcomes: SkillDeliveryOutcome[] };

export type SkillApiRequest =
	| { version: 1; operation: "probe"; reply: (result: SkillApiReply) => void }
	| { version: 1; operation: "suggest"; query: string; reply: (result: SkillApiReply) => void }
	| { version: 1; operation: "deliver"; names: string[]; reply: (result: SkillApiReply) => void };

function isRequest(value: unknown): value is SkillApiRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	if (request.version !== SKILL_API_VERSION || typeof request.reply !== "function") return false;
	switch (request.operation) {
		case "probe": return true;
		case "suggest": return typeof request.query === "string";
		case "deliver": return Array.isArray(request.names) && request.names.every((name: unknown) => typeof name === "string");
		default: return false;
	}
}

/** EventBus callbacks run synchronously until their first await; probe is an immediate capability check. */
export function registerSkillApi(
	pi: ExtensionAPI,
	getSkills: () => SkillAutocompleteSkill[],
	deliver: (names: string[]) => SkillDeliveryOutcome[],
): void {
	pi.events.on(SKILL_API_CHANNEL, (value: unknown) => {
		if (!isRequest(value)) return;
		switch (value.operation) {
			case "probe":
				value.reply({ version: 1, operation: "probe", available: true });
				break;
			case "suggest":
				value.reply({ version: 1, operation: "suggest", items: skillSuggestions(value.query, getSkills()) });
				break;
			case "deliver":
				value.reply({ version: 1, operation: "deliver", outcomes: deliver(value.names) });
				break;
		}
	});
}
