import { describe, expect, test } from "bun:test";
import type { ToolCatalogEntry } from "../src/lib/types";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";
process.env.OPENROUTER_API_KEY ??= "test";

const { rankCatalogByPrompt, routeToolsForPrompt } = await import("../src/lib/router");

// A catalog that includes toolkits the hand-written intent registry never knew
// about (Slack, Linear). Generalization means these are still discoverable.
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
    // The Slack tool was never added to the intent registry, yet it wins on
    // description relevance alone — new toolkits work without code changes.
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

describe("routeToolsForPrompt discovery gating", () => {
  test("cannot reach an unregistered toolkit's tools when discovery is off", async () => {
    const result = await routeToolsForPrompt("send a slack message to the team", {
      catalog: extendedCatalog,
      useLLM: false,
      discovery: false,
    });

    // The hand-written registry only knows Google/GitHub, so with discovery off
    // it can never select a Slack/Linear tool — that is exactly why discovery
    // over the live catalog is needed for new toolkits.
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
