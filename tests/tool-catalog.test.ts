import { describe, expect, test } from "bun:test";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";

const { getToolInputSchema, getToolSlug, isAllowedToolSlug } = await import(
  "../src/lib/tool-catalog"
);

describe("tool-catalog helpers", () => {
  test("rejects meta tools and toolkit mismatches", () => {
    expect(isAllowedToolSlug("COMPOSIO_SEARCH")).toBe(false);
    expect(isAllowedToolSlug("GOOGLESUPER_SEND_EMAIL", "github")).toBe(false);
    expect(isAllowedToolSlug("GITHUB_LIST_REPOSITORY_ISSUES", "github")).toBe(true);
    expect(isAllowedToolSlug("GOOGLESUPER_FETCH_EMAILS", "googlesuper")).toBe(true);
  });

  test("normalizes parameter maps into JSON schema objects", () => {
    const schema = getToolInputSchema({
      slug: "GOOGLESUPER_SEND_EMAIL",
      inputParameters: {
        to: { type: "string", description: "Recipient", required: true },
        body: { type: "string" },
      },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient" },
        body: { type: "string" },
      },
      required: ["to"],
      additionalProperties: true,
    });
  });

  test("uses existing JSON schema objects unchanged", () => {
    const rawSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };

    expect(getToolInputSchema({ inputParameters: rawSchema })).toBe(rawSchema);
  });

  test("falls back from slug to name when resolving tool slugs", () => {
    expect(getToolSlug({ name: "GITHUB_GET_AN_ISSUE" })).toBe("GITHUB_GET_AN_ISSUE");
  });
});
