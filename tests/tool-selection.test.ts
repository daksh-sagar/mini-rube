import { describe, expect, test } from "bun:test";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";

const {
  allowedMutatingToolSlugs,
  exposedToolSlugsForChat,
  isMutatingToolAllowedForRoute,
  resolveChatToolSelectionMode,
  routeAllowsMutation,
} = await import("../src/lib/tool-selection");

describe("chat tool selection policy", () => {
  test("defaults to all supported tools for currently connected accounts", () => {
    const exposed = exposedToolSlugsForChat(
      { slugs: ["GOOGLESUPER_FETCH_EMAILS"] },
      { googlesuper: true, github: true },
      "all_connected"
    );

    expect(exposed).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(exposed).toContain("GOOGLESUPER_CREATE_EVENT");
    expect(exposed).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(exposed).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(exposed).not.toContain("GOOGLESUPER_GET_BATCH_VALUES");
  });

  test("does not expose tools for disconnected accounts", () => {
    const exposed = exposedToolSlugsForChat(
      { slugs: ["GOOGLESUPER_FETCH_EMAILS", "GITHUB_LIST_REPOSITORY_ISSUES"] },
      { googlesuper: false, github: true },
      "all_connected"
    );

    expect(exposed).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(exposed.some((slug) => slug.startsWith("GOOGLESUPER_"))).toBe(false);
  });

  test("keeps routed mode as a rollback path", () => {
    expect(resolveChatToolSelectionMode("selected")).toBe("routed");
    expect(
      exposedToolSlugsForChat(
        { slugs: ["GOOGLESUPER_FETCH_EMAILS"] },
        { googlesuper: true, github: true },
        "routed"
      )
    ).toEqual(["GOOGLESUPER_FETCH_EMAILS"]);
  });

  test("authorizes mutations only when routed by the latest request", () => {
    const readRoute = { slugs: ["GITHUB_LIST_REPOSITORY_ISSUES"], intentIds: ["github.issues_read"] };
    const writeRoute = {
      slugs: ["GITHUB_LIST_REPOSITORY_ISSUES", "GOOGLESUPER_SHEET_FROM_JSON"],
      intentIds: ["github.issues_to_sheet"],
    };

    expect(routeAllowsMutation(readRoute)).toBe(false);
    expect(isMutatingToolAllowedForRoute("GOOGLESUPER_SHEET_FROM_JSON", readRoute)).toBe(false);
    expect(routeAllowsMutation(writeRoute)).toBe(true);
    expect(allowedMutatingToolSlugs(writeRoute)).toEqual(["GOOGLESUPER_SHEET_FROM_JSON"]);
    expect(isMutatingToolAllowedForRoute("GOOGLESUPER_SHEET_FROM_JSON", writeRoute)).toBe(true);
  });
});
