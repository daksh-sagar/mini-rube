import { describe, expect, test } from "bun:test";
import type { ToolCatalogEntry } from "../src/lib/types";

process.env.COMPOSIO_API_KEY ??= "test";
process.env.GOOGLESUPER_AUTH_CONFIG_ID ??= "test";
process.env.GITHUB_AUTH_CONFIG_ID ??= "test";
process.env.OPENROUTER_API_KEY ??= "test";

const { routeToolsForPrompt } = await import("../src/lib/router");

const catalog: ToolCatalogEntry[] = [
  tool("GOOGLESUPER_FETCH_EMAILS", "Fetch emails from Gmail"),
  tool("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID", "Fetch full Gmail message by ID"),
  tool("GOOGLESUPER_SEND_EMAIL", "Send an email"),
  tool("GOOGLESUPER_GET_ATTACHMENT", "Get a Gmail attachment"),
  tool("GOOGLESUPER_CREATE_EVENT", "Create calendar event"),
  tool("GOOGLESUPER_FIND_FREE_SLOTS", "Find free calendar slots"),
  tool("GOOGLESUPER_EVENTS_LIST", "List calendar events"),
  tool("GOOGLESUPER_GET_CONTACTS", "Get contacts"),
  tool("GOOGLESUPER_SEARCH_PEOPLE", "Search people"),
  tool("GOOGLESUPER_GET_CURRENT_DATE_TIME", "Get current date and time"),
  tool("GOOGLESUPER_FIND_FILE", "Find Drive file"),
  tool("GOOGLESUPER_FIND_FOLDER", "Find Drive folder"),
  tool("GOOGLESUPER_LIST_CHILDREN_V2", "List folder children"),
  tool("GOOGLESUPER_DOWNLOAD_FILE", "Download Drive file"),
  tool("GOOGLESUPER_DOWNLOAD_FILE_OPERATION", "Download Drive file operation"),
  tool("GOOGLESUPER_PARSE_FILE", "Parse Drive file"),
  tool("GOOGLESUPER_SHEET_FROM_JSON", "Create a sheet from JSON rows"),
  tool("GOOGLESUPER_CREATE_GOOGLE_SHEET1", "Create Google Sheet"),
  tool("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND", "Append values to a spreadsheet"),
  tool("GITHUB_LIST_REPOSITORY_ISSUES", "List repository issues"),
  tool("GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS", "Search issues and pull requests"),
  tool("GITHUB_GET_AN_ISSUE", "Get an issue"),
];

describe("routeToolsForPrompt", () => {
  test("routes email reading prompts to Gmail fetch tools", async () => {
    const result = await routeToolsForPrompt("read my last 100 emails and show me the important ones", {
      catalog,
      useLLM: false,
    });

    expect(result.intentIds).toContain("email.read_summary");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID");
    expect(result.slugs).not.toContain("GOOGLESUPER_SEND_EMAIL");
  });

  test("routes merchant purchase history prompts to email search tools", async () => {
    const result = await routeToolsForPrompt("What products have I bought from scentoria in the past month?", {
      catalog,
      useLLM: false,
    });

    expect(result.intentIds).toContain("email.purchase_history");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID");
    expect(result.slugs).toContain("GOOGLESUPER_GET_CURRENT_DATE_TIME");
    expect(result.slugs.some((slug) => slug.startsWith("GITHUB_"))).toBe(false);
  });

  test("routes scheduling prompts to calendar, contacts, and date tools", async () => {
    const result = await routeToolsForPrompt("schedule a calendar event tomorrow with karan", {
      catalog,
      useLLM: false,
    });

    expect(result.intentIds).toContain("calendar.schedule");
    expect(result.slugs).toContain("GOOGLESUPER_CREATE_EVENT");
    expect(result.slugs).toContain("GOOGLESUPER_GET_CONTACTS");
    expect(result.slugs).toContain("GOOGLESUPER_SEARCH_PEOPLE");
    expect(result.slugs).toContain("GOOGLESUPER_GET_CURRENT_DATE_TIME");
  });

  test("routes GitHub reporting prompts to issue and spreadsheet tools", async () => {
    const result = await routeToolsForPrompt(
      "read all issues on composiohq/composio and make a google sheet with the problems",
      { catalog, useLLM: false }
    );

    expect(result.intentIds).toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(result.slugs).toContain("GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS");
    expect(result.slugs).toContain("GITHUB_GET_AN_ISSUE");
    expect(result.slugs).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });

  test("routes Drive resume extraction prompts to document and sheet tools", async () => {
    const result = await routeToolsForPrompt(
      "can you take all the resumes in this drive and make a google sheet with candidates names, uni and last job https://drive.google.com/drive/folders/abc",
      {
        catalog,
        useLLM: false,
      }
    );

    expect(result.intentIds).toContain("drive.resumes_to_sheet");
    expect(result.slugs).toContain("GOOGLESUPER_LIST_CHILDREN_V2");
    expect(result.slugs).toContain("GOOGLESUPER_DOWNLOAD_FILE");
    expect(result.slugs).toContain("GOOGLESUPER_PARSE_FILE");
    expect(result.slugs).toContain("GOOGLESUPER_SHEET_FROM_JSON");
  });

  test("routes uploaded PDF email prompts to email sending tools", async () => {
    const result = await routeToolsForPrompt("send an email with the attached pdf", {
      catalog,
      useLLM: false,
    });

    expect(result.intentIds).toContain("email.send_with_upload");
    expect(result.slugs).toContain("GOOGLESUPER_SEND_EMAIL");
    expect(result.slugs).toContain("GOOGLESUPER_GET_CONTACTS");
    expect(result.slugs).not.toContain("GOOGLESUPER_GET_ATTACHMENT");
  });

  test("routes standalone sheet prompts to sheet tools only", async () => {
    const result = await routeToolsForPrompt("make a google sheet from this data", {
      catalog,
      useLLM: false,
    });

    expect(result.intentIds).toContain("sheet.create_or_update");
    expect(result.slugs).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs.some((slug) => slug.startsWith("GITHUB_"))).toBe(false);
    expect(result.slugs).not.toContain("GOOGLESUPER_PARSE_FILE");
  });

  test("respects maxTools after deterministic routing", async () => {
    const result = await routeToolsForPrompt("drive folder of resumes to google sheet", {
      catalog,
      maxTools: 3,
      useLLM: false,
    });

    expect(result.intentIds).toContain("drive.resumes_to_sheet");
    expect(result.slugs).toHaveLength(3);
  });

  test("does not route generic follow-ups to random tools", async () => {
    const result = await routeToolsForPrompt("what else", {
      catalog,
      useLLM: false,
    });

    expect(result.slugs).toEqual([]);
    expect(result.intentIds).toEqual([]);
    expect(result.routingMode).toBe("none");
  });
});

function tool(slug: string, description: string): ToolCatalogEntry {
  return {
    slug,
    description,
    toolkit: slug.startsWith("GITHUB_") ? "github" : "googlesuper",
  };
}
