import { describe, expect, test } from "bun:test";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";

const { filterAllowedToolCatalog, getToolInputSchema, getToolSlug, isAllowedToolSlug, supportedToolSlugs } = await import(
  "../src/lib/tool-catalog"
);

describe("tool-catalog helpers", () => {
  test("rejects meta tools and toolkit mismatches", () => {
    expect(isAllowedToolSlug("COMPOSIO_SEARCH")).toBe(false);
    expect(isAllowedToolSlug("GOOGLESUPER_SEND_EMAIL", "github")).toBe(false);
    expect(isAllowedToolSlug("GITHUB_LIST_REPOSITORY_ISSUES", "github")).toBe(true);
    expect(isAllowedToolSlug("GOOGLESUPER_FETCH_EMAILS", "googlesuper")).toBe(true);
  });

  test("rejects configured-toolkit tools outside Mini Rube's supported surface", () => {
    expect(isAllowedToolSlug("GOOGLESUPER_DELETE_EMAIL", "googlesuper")).toBe(false);
    expect(isAllowedToolSlug("GITHUB_CREATE_AN_ISSUE", "github")).toBe(false);
    expect(isAllowedToolSlug("GOOGLESUPER_GET_BATCH_VALUES", "googlesuper")).toBe(true);
  });

  test("filters live catalogs down to the supported allowlist", () => {
    const filtered = filterAllowedToolCatalog([
      { slug: "GOOGLESUPER_FETCH_EMAILS", description: "Fetch emails", toolkit: "googlesuper" },
      { slug: "GOOGLESUPER_DELETE_EMAIL", description: "Delete emails", toolkit: "googlesuper" },
      { slug: "GITHUB_CREATE_AN_ISSUE", description: "Create issue", toolkit: "github" },
    ]);

    expect(filtered.map((tool) => tool.slug)).toEqual(["GOOGLESUPER_FETCH_EMAILS"]);
    expect(supportedToolSlugs()).toContain("GOOGLESUPER_GET_BATCH_VALUES");
  });

  test("documents the exact Mini Rube supported tool surface", () => {
    expect(supportedToolSlugs()).toEqual([
      "GITHUB_GET_AN_ISSUE",
      "GITHUB_LIST_REPOSITORY_ISSUES",
      "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
      "GOOGLESUPER_CREATE_EVENT",
      "GOOGLESUPER_CREATE_GOOGLE_SHEET1",
      "GOOGLESUPER_DOWNLOAD_FILE",
      "GOOGLESUPER_DOWNLOAD_FILE_OPERATION",
      "GOOGLESUPER_EVENTS_LIST",
      "GOOGLESUPER_FETCH_EMAILS",
      "GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GOOGLESUPER_FIND_FILE",
      "GOOGLESUPER_FIND_FOLDER",
      "GOOGLESUPER_FIND_FREE_SLOTS",
      "GOOGLESUPER_GET_ATTACHMENT",
      "GOOGLESUPER_GET_BATCH_VALUES",
      "GOOGLESUPER_GET_CONTACTS",
      "GOOGLESUPER_GET_CURRENT_DATE_TIME",
      "GOOGLESUPER_LIST_CHILDREN_V2",
      "GOOGLESUPER_PARSE_FILE",
      "GOOGLESUPER_SEARCH_PEOPLE",
      "GOOGLESUPER_SEND_EMAIL",
      "GOOGLESUPER_SHEET_FROM_JSON",
      "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
    ]);
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
