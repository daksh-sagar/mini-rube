import { describe, expect, test } from "bun:test";
import { authRequirementsForToolkit, authToolsForToolkit } from "../src/lib/auth-requirements";

describe("auth requirements", () => {
  test("google auth covers assignment-critical apps", () => {
    const labels = authRequirementsForToolkit("googlesuper").map((requirement) => requirement.label);
    const tools = authToolsForToolkit("googlesuper");

    expect(labels).toEqual(["Gmail", "Contacts", "Calendar", "Drive", "Sheets"]);
    expect(tools).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(tools).toContain("GOOGLESUPER_CREATE_EVENT");
    expect(tools).toContain("GOOGLESUPER_PARSE_FILE");
    expect(tools).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(tools).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
    expect(tools).toContain("GOOGLESUPER_GET_BATCH_VALUES");
  });

  test("github auth covers issue report workflow", () => {
    expect(authToolsForToolkit("github")).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
  });
});
