import { describe, expect, test } from "bun:test";
import type { ToolCatalogEntry } from "../src/lib/types";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";
process.env.OPENROUTER_API_KEY ??= "test";

const { filterAllowedToolCatalog } = await import("../src/lib/tool-catalog");
const { rankCatalogByPrompt, routeToolsForPrompt } = await import("../src/lib/router");

// A catalog that includes tools outside Mini Rube's supported surface. Pure
// lexical ranking can rank them, but routeToolsForPrompt filters them out before
// the LLM or deterministic router can select them.
const extendedCatalog: ToolCatalogEntry[] = [
  tool("GOOGLESUPER_FETCH_EMAILS", "Fetch emails from Gmail", "googlesuper"),
  tool("GOOGLESUPER_SEND_EMAIL", "Send an email", "googlesuper"),
  tool("GITHUB_LIST_REPOSITORY_ISSUES", "List repository issues", "github"),
  tool("SLACK_SEND_MESSAGE", "Send a message to a Slack channel", "slack"),
  tool("SLACK_FETCH_CONVERSATION_HISTORY", "Read recent messages from a Slack channel", "slack"),
  tool("LINEAR_CREATE_ISSUE", "Create a new issue in Linear", "linear"),
  tool("LINEAR_LIST_ISSUES", "List issues from a Linear team", "linear"),
];

describe("rankCatalogByPrompt (toolkit-agnostic discovery)", () => {
  test("ranks a never-registered Slack tool top for a Slack prompt", () => {
    const ranked = rankCatalogByPrompt(
      "post a message to the slack channel for the team",
      extendedCatalog
    );

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].tool.slug).toBe("SLACK_SEND_MESSAGE");
    expect(ranked.some((entry) => entry.tool.toolkit === "slack")).toBe(true);
  });

  test("ranks a Linear tool for a Linear prompt", () => {
    const ranked = rankCatalogByPrompt("create a linear issue for this bug", extendedCatalog);
    expect(ranked[0].tool.slug).toBe("LINEAR_CREATE_ISSUE");
  });

  test("returns nothing for a prompt with no usable signal", () => {
    expect(rankCatalogByPrompt("ok thanks", extendedCatalog)).toEqual([]);
  });
});

describe("routeToolsForPrompt allowlist gating", () => {
  test("filters unsupported toolkit tools before routing", async () => {
    const filtered = filterAllowedToolCatalog(extendedCatalog);

    expect(filtered.some((tool) => /^(SLACK|LINEAR)_/.test(tool.slug))).toBe(false);
    expect(filtered.map((tool) => tool.slug)).toContain("GOOGLESUPER_FETCH_EMAILS");
  });

  test("cannot reach unsupported toolkit tools through routing", async () => {
    const result = await routeToolsForPrompt("send a slack message to the team", {
      catalog: extendedCatalog,
      useLLM: false,
      discovery: false,
    });

    expect(result.slugs.every((slug) => !/^(SLACK|LINEAR)_/.test(slug))).toBe(true);
    expect(result.routingMode).not.toBe("catalog_llm");
    expect(result.routingMode).not.toBe("catalog_lexical");
  });

  test("still routes a known Gmail prompt deterministically with discovery off", async () => {
    const result = await routeToolsForPrompt("read my latest emails", {
      catalog: extendedCatalog,
      useLLM: false,
      discovery: false,
    });

    expect(result.intentIds).toContain("email.read_summary");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.routingMode).toBe("deterministic");
  });
});

function tool(slug: string, description: string, toolkit: string): ToolCatalogEntry {
  return { slug, description, toolkit };
}
