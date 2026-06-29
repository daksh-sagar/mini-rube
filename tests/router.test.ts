import { describe, expect, test } from "bun:test";
import type { LlmRouterInput, ToolCatalogEntry } from "../src/lib/types";

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

  test("asks on bare ambiguous follow-up across multiple prior task domains", async () => {
    const result = await routeToolsForPrompt("continue", {
      catalog,
      useLLM: false,
      messages: [
        { role: "user", content: "get my latest emails" },
        { role: "assistant", content: "Here are your latest emails." },
        { role: "user", content: "show issues from composiohq/composio" },
        { role: "assistant", content: "Here are the GitHub issues." },
        { role: "user", content: "continue" },
      ],
    });

    expect(result.routeScope).toBe("ambiguous");
    expect(result.slugs).toEqual([]);
    expect(result.clarification).toContain("emails");
    expect(result.clarification).toContain("GitHub issues");
  });

  test("uses LLM-first tool choices when they are valid", async () => {
    const result = await routeToolsForPrompt("schedule a calendar event tomorrow with karan", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: ["calendar.schedule"],
        toolSlugs: ["GOOGLESUPER_CREATE_EVENT"],
        confidence: 0.91,
        rationale: "calendar scheduling",
      }),
    });

    expect(result.routingMode).toBe("llm_first");
    expect(result.intentIds).toContain("calendar.schedule");
    expect(result.slugs).toContain("GOOGLESUPER_CREATE_EVENT");
    expect(result.slugs).toContain("GOOGLESUPER_GET_CURRENT_DATE_TIME");
  });

  test("filters invented and unsupported LLM tool slugs", async () => {
    const result = await routeToolsForPrompt("read my latest emails", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: ["email.read_summary", "unknown.intent"],
        toolSlugs: [
          " googlesuper_fetch_emails ",
          "GOOGLESUPER_FETCH_EMAILS",
          "GOOGLESUPER_CREATE_CALENDAR_EVENT",
          "COMPOSIO_SEARCH_TOOLS",
          "SLACK_SEND_MESSAGE",
        ],
        confidence: 0.88,
        rationale: "email read",
      }),
    });

    expect(result.intentIds).toEqual(["email.read_summary"]);
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID");
    expect(result.slugs).not.toContain("GOOGLESUPER_CREATE_CALENDAR_EVENT");
    expect(result.slugs).not.toContain("COMPOSIO_SEARCH_TOOLS");
    expect(result.slugs).not.toContain("SLACK_SEND_MESSAGE");
  });

  test("drops mutating LLM tools for read-only prompts", async () => {
    const result = await routeToolsForPrompt("summarize my inbox", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: ["email.read_summary"],
        toolSlugs: ["GOOGLESUPER_SEND_EMAIL", "GOOGLESUPER_FETCH_EMAILS"],
        confidence: 0.93,
        rationale: "bad mutating suggestion",
      }),
    });

    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).not.toContain("GOOGLESUPER_SEND_EMAIL");
  });

  test("does not let LLM authorize mutating intents for read-only prompts", async () => {
    const result = await routeToolsForPrompt("summarize my inbox", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: ["email.send"],
        toolSlugs: ["GOOGLESUPER_SEND_EMAIL"],
        confidence: 0.96,
        rationale: "malicious mutating route",
      }),
    });

    expect(result.intentIds).not.toContain("email.send");
    expect(result.slugs).not.toContain("GOOGLESUPER_SEND_EMAIL");
  });

  test("falls back when LLM-first throws", async () => {
    const result = await routeToolsForPrompt("read my latest emails", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => {
        throw new Error("planner down");
      },
    });

    expect(result.routingMode).toBe("llm_first_fallback");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
  });

  test("uses conversation context when LLM-first returns empty for an email follow-up", async () => {
    let routerInput: LlmRouterInput | undefined;
    const result = await routeToolsForPrompt(
      "these don't seem to be recent ones, can you fetch the most recent ones",
      {
        catalog,
        strategy: "llm_first",
        messages: [
          {
            role: "user",
            content: "read my last 100 emails and show me the important ones",
          },
          {
            role: "assistant",
            content: "Here are the important emails I found in your inbox.",
          },
          {
            role: "user",
            content: "these don't seem to be recent ones, can you fetch the most recent ones",
          },
        ],
        llmRouter: async (input) => {
          routerInput = input;
          return {
            intentIds: [],
            toolSlugs: [],
            confidence: 0.94,
            rationale: "No available tools were provided to select from.",
          };
        },
      }
    );

    expect(routerInput?.availableTools.map((tool) => tool.slug)).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.routingMode).toBe("llm_first_fallback");
    expect(result.intentIds).toContain("email.read_summary");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID");
  });

  test("routes latest email request to Gmail despite prior GitHub sheet context", async () => {
    const result = await routeToolsForPrompt("get me subjects of my last 5 emails", {
      catalog,
      useLLM: false,
      messages: [
        {
          role: "user",
          content:
            "Read the issues on composiohq/composio and make a Google Sheet with the problems people report",
        },
        {
          role: "assistant",
          content: "I started the github.issues_to_sheet workflow and wrote the GitHub issues to a sheet.",
        },
        {
          role: "user",
          content: "get me subjects of my last 5 emails",
        },
      ],
    });

    expect(result.intentIds).toContain("email.read_summary");
    expect(result.routeScope).toBe("standalone");
    expect(result.intentIds).not.toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID");
    expect(result.slugs.some((slug) => slug.startsWith("GITHUB_"))).toBe(false);
    expect(result.slugs).not.toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs).not.toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });

  test("rejects stale LLM GitHub route when latest prompt asks for emails", async () => {
    const result = await routeToolsForPrompt("get me subjects of my last 5 emails", {
      catalog,
      strategy: "llm_first",
      messages: [
        {
          role: "user",
          content:
            "Read the issues on composiohq/composio and make a Google Sheet with the problems people report",
        },
        {
          role: "assistant",
          content: "I started the github.issues_to_sheet workflow and wrote the GitHub issues to a sheet.",
        },
        {
          role: "user",
          content: "get me subjects of my last 5 emails",
        },
      ],
      llmRouter: async () => ({
        intentIds: ["github.issues_to_sheet"],
        toolSlugs: ["GITHUB_LIST_REPOSITORY_ISSUES", "GOOGLESUPER_SHEET_FROM_JSON"],
        confidence: 0.95,
        rationale: "stale github context",
      }),
    });

    expect(result.routingMode).toBe("llm_first_fallback");
    expect(result.routeScope).toBe("standalone");
    expect(result.intentIds).toContain("email.read_summary");
    expect(result.intentIds).not.toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs.some((slug) => slug.startsWith("GITHUB_"))).toBe(false);
    expect(result.slugs).not.toContain("GOOGLESUPER_SHEET_FROM_JSON");
  });

  test("routes sheet follow-up from prior GitHub read context to GitHub issue sheet workflow", async () => {
    const result = await routeToolsForPrompt("write them to a sheet", {
      catalog,
      useLLM: false,
      messages: [
        {
          role: "user",
          content: "composiohq/composio, just get the issues, don't write them",
        },
        {
          role: "assistant",
          content: "I found the recent GitHub issues in composiohq/composio.",
        },
        {
          role: "user",
          content: "write them to a sheet",
        },
      ],
    });

    expect(result.intentIds).toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(result.slugs).toContain("GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS");
    expect(result.slugs).toContain("GITHUB_GET_AN_ISSUE");
    expect(result.slugs).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });

  test("routes explicit read-only GitHub issue request away from sheet workflow", async () => {
    const result = await routeToolsForPrompt("composiohq/composio, just get the issues, don't write them", {
      catalog,
      useLLM: false,
    });

    expect(result.intentIds).toContain("github.issues_read");
    expect(result.intentIds).not.toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(result.slugs).toContain("GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS");
    expect(result.slugs).toContain("GITHUB_GET_AN_ISSUE");
    expect(result.slugs).not.toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs).not.toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });

  test("rejects LLM sheet workflow when latest GitHub prompt says not to write", async () => {
    const result = await routeToolsForPrompt("composiohq/composio, just get the issues, don't write them", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: ["github.issues_to_sheet"],
        toolSlugs: ["GITHUB_LIST_REPOSITORY_ISSUES", "GOOGLESUPER_SHEET_FROM_JSON"],
        confidence: 0.94,
        rationale: "ignored negative write constraint",
      }),
    });

    expect(result.intentIds).toContain("github.issues_read");
    expect(result.intentIds).not.toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(result.slugs).not.toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs).not.toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });

  test("routes latest email request to Gmail despite prior calendar context", async () => {
    const result = await routeToolsForPrompt("get me subjects of my last 5 emails", {
      catalog,
      useLLM: false,
      messages: [
        {
          role: "user",
          content: "schedule a calendar event tomorrow with karan",
        },
        {
          role: "assistant",
          content: "I prepared a calendar event draft and need a time before creating it.",
        },
        {
          role: "user",
          content: "get me subjects of my last 5 emails",
        },
      ],
    });

    expect(result.intentIds).toContain("email.read_summary");
    expect(result.intentIds).not.toContain("calendar.schedule");
    expect(result.intentIds).not.toContain("calendar.read");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_EMAILS");
    expect(result.slugs).toContain("GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID");
    expect(result.slugs).not.toContain("GOOGLESUPER_CREATE_EVENT");
    expect(result.slugs).not.toContain("GOOGLESUPER_FIND_FREE_SLOTS");
    expect(result.slugs).not.toContain("GOOGLESUPER_EVENTS_LIST");
  });

  test("returns none when LLM-first confidently chooses no tools", async () => {
    const result = await routeToolsForPrompt("send a slack message to the team", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: [],
        toolSlugs: [],
        confidence: 0.92,
        rationale: "unsupported app",
      }),
    });

    expect(result.routingMode).toBe("llm_first");
    expect(result.slugs).toEqual([]);
    expect(result.intentIds).toEqual([]);
  });

  test("does not fallback to unrelated tools when LLM selects unavailable external toolkit", async () => {
    const result = await routeToolsForPrompt("send a slack message to the team", {
      catalog,
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: [],
        toolSlugs: ["SLACK_SEND_MESSAGE"],
        confidence: 0.9,
        rationale: "Slack is not available",
      }),
    });

    expect(result.routingMode).toBe("llm_first");
    expect(result.slugs).toEqual([]);
  });

  test("does not expose unsupported same-toolkit tools to LLM-first routing", async () => {
    const result = await routeToolsForPrompt("delete my latest email", {
      catalog: [
        ...catalog,
        tool("GOOGLESUPER_DELETE_EMAIL", "Delete an email from Gmail"),
        tool("GITHUB_CREATE_AN_ISSUE", "Create a GitHub issue"),
      ],
      strategy: "llm_first",
      llmRouter: async () => ({
        intentIds: [],
        toolSlugs: ["GOOGLESUPER_DELETE_EMAIL", "GITHUB_CREATE_AN_ISSUE"],
        confidence: 0.93,
        rationale: "unsupported tools should be filtered",
      }),
    });

    expect(result.routingMode).toBe("llm_first");
    expect(result.slugs).toEqual([]);
  });

  test("does not let LLM-first downgrade a GitHub sheet workflow to read-only issue tools", async () => {
    const result = await routeToolsForPrompt(
      "Read 5 open and closed issues on composiohq/composio and make a Google Sheet of the problems people report",
      {
        catalog,
        strategy: "llm_first",
        llmRouter: async () => ({
          intentIds: ["github.issues_read"],
          toolSlugs: ["GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_GET_AN_ISSUE"],
          confidence: 0.91,
          rationale: "read issues",
        }),
      }
    );

    expect(result.routingMode).toBe("llm_first_fallback");
    expect(result.intentIds).toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(result.slugs).toContain("GOOGLESUPER_SHEET_FROM_JSON");
    expect(result.slugs).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });

  test("preserves workflow intent identity from LLM-first output", async () => {
    const result = await routeToolsForPrompt(
      "fetch 5 recent github issues on composiohq/composio and write them to a sheet",
      {
        catalog,
        strategy: "llm_first",
        llmRouter: async () => ({
          intentIds: ["github.issues_to_sheet"],
          toolSlugs: ["GITHUB_LIST_REPOSITORY_ISSUES", "GOOGLESUPER_SHEET_FROM_JSON"],
          confidence: 0.94,
          rationale: "github issues report",
        }),
      }
    );

    expect(result.intentIds).toContain("github.issues_to_sheet");
    expect(result.slugs).toContain("GITHUB_LIST_REPOSITORY_ISSUES");
    expect(result.slugs).toContain("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND");
  });
});

function tool(slug: string, description: string): ToolCatalogEntry {
  return {
    slug,
    description,
    toolkit: slug.startsWith("GITHUB_") ? "github" : "googlesuper",
  };
}
