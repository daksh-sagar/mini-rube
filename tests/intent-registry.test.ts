import { describe, expect, test } from "bun:test";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";

const { ASSIGNMENT_CRITICAL_INTENT_IDS, ROUTER_INTENTS } = await import("../src/lib/intent-registry");
const { isAllowedToolSlug } = await import("../src/lib/tool-catalog");

describe("ROUTER_INTENTS", () => {
  test("covers assignment-critical workflows", () => {
    const ids = new Set(ROUTER_INTENTS.map((intent) => intent.id));

    for (const intentId of ASSIGNMENT_CRITICAL_INTENT_IDS) {
      expect(ids.has(intentId)).toBe(true);
    }
  });

  test("every intent has scoring metadata and allowed tool slugs", () => {
    for (const intent of ROUTER_INTENTS) {
      expect(intent.id).toBeTruthy();
      expect(intent.description.length).toBeGreaterThan(20);
      expect(intent.toolSlugs.length).toBeGreaterThan(0);
      expect(intent.keywords.length).toBeGreaterThan(0);
      expect(intent.examplePrompts.length).toBeGreaterThan(0);
      expect(intent.requiredToolkits.length).toBeGreaterThan(0);

      for (const slug of intent.toolSlugs) {
        expect(isAllowedToolSlug(slug)).toBe(true);
      }
    }
  });

  test("mutating intents are explicitly marked", () => {
    const mutatingIntents = ROUTER_INTENTS.filter((intent) =>
      intent.toolSlugs.some((slug) => /SEND|CREATE|APPEND|UPDATE|DELETE|SHEET_FROM_JSON/.test(slug))
    );

    for (const intent of mutatingIntents) {
      expect(intent.mutating).toBe(true);
    }
  });
});
