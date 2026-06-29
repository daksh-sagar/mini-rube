import { describe, expect, test } from "bun:test";
import { compactToolResult } from "../src/lib/tool-results";

describe("compactToolResult", () => {
  function gmailMessages(count: number) {
    return {
      data: {
        messages: Array.from({ length: count }, (_, index) => ({
          id: `msg_${index + 1}`,
          threadId: `thread_${index + 1}`,
          labelIds: ["INBOX", index % 3 === 0 ? "IMPORTANT" : "CATEGORY_PERSONAL"],
          payload: {
            headers: [
              { name: "Subject", value: `Important account update ${index + 1}` },
              { name: "From", value: `sender${index + 1}@example.com` },
              { name: "Date", value: `2026-06-${String((index % 28) + 1).padStart(2, "0")}` },
            ],
            body: {
              data: "payload ".repeat(400),
            },
          },
          snippet: `Useful summary ${index + 1}: ${"details ".repeat(50)}`,
        })),
      },
    };
  }

  test("extracts nested name/value fields without tool-specific handling", () => {
    const result = {
      data: {
        messages: Array.from({ length: 50 }, (_, index) => ({
          id: `msg_${index}`,
          threadId: `thread_${index}`,
          payload: {
            headers: [
              { name: "Subject", value: `Subject ${index + 1}` },
              { name: "From", value: `sender${index}@example.com` },
              { name: "Date", value: `2026-06-${String(index + 1).padStart(2, "0")}` },
            ],
          },
          snippet: `Snippet ${index + 1}`,
        })),
      },
    };

    const compacted = compactToolResult("ANY_COLLECTION_TOOL", result, {
      prompt: "fetch the subject of my last 50 emails",
    }) as any;

    expect(compacted.resultType).toBe("collection");
    expect(compacted.sourceTool).toBe("ANY_COLLECTION_TOOL");
    expect(compacted.path).toBe("$.data.messages");
    expect(compacted.itemCount).toBe(50);
    expect(compacted.returnedCount).toBe(50);
    expect(compacted.items).toHaveLength(50);
    expect(compacted.items[0]).toMatchObject({
      index: 1,
      id: "msg_0",
      threadId: "thread_0",
      subject: "Subject 1",
      from: "sender0@example.com",
    });
    expect(compacted.items[49].subject).toBe("Subject 50");
  });

  test("keeps collection compaction under budget by truncating whole items", () => {
    const result = {
      results: Array.from({ length: 200 }, (_, index) => ({
        number: index + 1,
        title: `Issue ${index + 1}`,
        state: "open",
        html_url: `https://github.com/example/repo/issues/${index + 1}`,
        body: `Long issue body ${index + 1} ${"details ".repeat(100)}`,
      })),
    };

    const compacted = compactToolResult("GITHUB_ISSUES_LIST", result, {
      maxLength: 4_000,
      prompt: "list issue titles and urls",
    }) as any;

    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(4_000);
    expect(compacted.resultType).toBe("collection");
    expect(compacted.itemCount).toBe(200);
    expect(compacted.returnedCount).toBeLessThan(200);
    expect(compacted.truncated).toBe(true);
    expect(compacted.items.at(-1)).toMatchObject({
      number: expect.any(Number),
      title: expect.stringContaining("Issue"),
    });
  });

  test("preserves requested GitHub issues by dropping long body fields first", () => {
    const result = {
      data: {
        issues: Array.from({ length: 5 }, (_, index) => ({
          number: 3700 + index,
          title: `Issue ${index + 1}`,
          state: "open",
          url: `https://api.github.com/repos/example/repo/issues/${3700 + index}`,
          html_url: `https://github.com/example/repo/issues/${3700 + index}`,
          created_at: `2026-06-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
          updated_at: `2026-06-${String(index + 1).padStart(2, "0")}T11:00:00Z`,
          comments: index,
          body: `Long issue body ${index + 1} ${"details ".repeat(500)}`,
        })),
      },
    };

    const compacted = compactToolResult("GITHUB_LIST_REPOSITORY_ISSUES", result, {
      maxLength: 3_000,
      args: { per_page: 5 },
      prompt: "get 5 issues from composiohq/composio",
    }) as any;

    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(3_000);
    expect(compacted.resultType).toBe("collection");
    expect(compacted.itemCount).toBe(5);
    expect(compacted.returnedCount).toBe(5);
    expect(compacted.items).toHaveLength(5);
    expect(compacted.items[0]).toMatchObject({
      index: 1,
      number: 3700,
      title: "Issue 1",
      state: "open",
      htmlUrl: "https://github.com/example/repo/issues/3700",
    });
    expect(compacted.items[0].htmlUrl).not.toContain("api.github.com");
    expect(String(compacted.items[0].body ?? "").length).toBeLessThanOrEqual(220);
    expect(JSON.stringify(compacted.items)).not.toContain("details ".repeat(80).trim());
  });

  test("fallback preview is marked truncated", () => {
    const compacted = compactToolResult("OTHER_TOOL", { text: "word ".repeat(200) }, 120) as any;

    expect(compacted.truncated).toBe(true);
    expect(compacted.preview.endsWith("...")).toBe(true);
    expect(compacted.preview).not.toContain("wor\n...");
  });

  test("preserves 100 Gmail messages by compacting fields before items", () => {
    const compacted = compactToolResult("GOOGLESUPER_FETCH_EMAILS", gmailMessages(100), {
      args: { max_results: 100 },
      prompt: "read my last 100 emails and show me the important ones",
    }) as any;

    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(16_000);
    expect(compacted.resultType).toBe("collection");
    expect(compacted.itemCount).toBe(100);
    expect(compacted.returnedCount).toBe(100);
    expect(compacted.items).toHaveLength(100);
    expect(compacted.items[0]).toMatchObject({
      index: 1,
      from: "sender1@example.com",
      subject: "Important account update 1",
    });
    expect(compacted.items[99]).toMatchObject({
      index: 100,
      subject: "Important account update 100",
    });
    expect(JSON.stringify(compacted.items)).not.toContain("payload payload");
  });

  const gmailCountFieldCases = ["max_results", "maxResults", "limit", "per_page", "page_size", "pageSize"];

  for (const field of gmailCountFieldCases) {
    test(`compacts Gmail result to requested count field ${field}`, () => {
      const compacted = compactToolResult("GOOGLESUPER_FETCH_EMAILS", gmailMessages(100), {
        args: { [field]: 25 },
        prompt: "read my latest 25 emails",
      }) as any;

      expect(compacted.itemCount).toBe(100);
      expect(compacted.returnedCount).toBe(25);
      expect(compacted.items).toHaveLength(25);
      expect(compacted.items[24].subject).toBe("Important account update 25");
    });
  }

  test("does not inflate a genuinely short Gmail result", () => {
    const compacted = compactToolResult("GOOGLESUPER_FETCH_EMAILS", gmailMessages(23), {
      args: { max_results: 100 },
      prompt: "read my last 100 emails",
    }) as any;

    expect(compacted.itemCount).toBe(23);
    expect(compacted.returnedCount).toBe(23);
    expect(compacted.items).toHaveLength(23);
  });
});
