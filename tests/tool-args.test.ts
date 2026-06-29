import { describe, expect, test } from "bun:test";
import { applyPromptLimitToToolArgs, normalizeToolArgs } from "../src/lib/tool-args";

describe("normalizeToolArgs", () => {
  test("prevents large Gmail reads from requesting full payloads", () => {
    expect(
      normalizeToolArgs("GOOGLESUPER_FETCH_EMAILS", {
        max_results: 100,
        include_payload: true,
        verbose: true,
      })
    ).toEqual({
      max_results: 100,
      include_payload: false,
      verbose: false,
    });
  });

  test("caps oversized Gmail result counts", () => {
    expect(
      normalizeToolArgs("GOOGLESUPER_FETCH_EMAILS", {
        max_results: 500,
      })
    ).toEqual({
      max_results: 100,
      include_payload: false,
      verbose: false,
    });
  });

  const countFieldCases = ["max_results", "maxResults", "limit", "per_page", "page_size", "pageSize"];

  for (const field of countFieldCases) {
    test(`preserves Gmail count field under cap: ${field}`, () => {
      expect(normalizeToolArgs("GOOGLESUPER_FETCH_EMAILS", { [field]: 5 })).toEqual({
        [field]: 5,
        include_payload: false,
        verbose: false,
      });
    });
  }

  const gmailPromptLimitCases = [
    ["show me my latest 25 emails", 25],
    ["read exactly 12 Gmail messages", 12],
    ["fetch at most 9 emails", 9],
    ["get no more than 8 messages from my inbox", 8],
    ["25 most recent emails", 25],
    ["emails, limit 11", 11],
  ] as const;

  for (const [prompt, limit] of gmailPromptLimitCases) {
    test(`applies Gmail prompt count: ${prompt}`, () => {
      expect(applyPromptLimitToToolArgs("GOOGLESUPER_FETCH_EMAILS", {}, prompt)).toEqual({
        max_results: limit,
      });
      expect(applyPromptLimitToToolArgs("GOOGLESUPER_FETCH_EMAILS", { limit: 100 }, prompt)).toEqual({
        limit,
      });
    });
  }

  test("does not apply Gmail prompt counts to unrelated tools", () => {
    expect(applyPromptLimitToToolArgs("GITHUB_LIST_REPOSITORY_ISSUES", {}, "read 5 emails")).toEqual({});
  });

  const githubIssuePromptLimitCases = [
    ["get titles of 5 recent github issues", 5],
    ["read exactly 7 issues on composiohq/composio", 7],
    ["list 4 open and closed pull requests", 4],
    ["github issues, limit 3", 3],
  ] as const;

  for (const [prompt, limit] of githubIssuePromptLimitCases) {
    test(`applies GitHub issue prompt count: ${prompt}`, () => {
      expect(applyPromptLimitToToolArgs("GITHUB_LIST_REPOSITORY_ISSUES", {}, prompt)).toEqual({
        per_page: limit,
      });
      expect(applyPromptLimitToToolArgs("GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS", { limit: 100 }, prompt)).toEqual({
        limit,
      });
    });
  }

  test("does not apply GitHub issue prompt counts to unrelated prompts", () => {
    expect(applyPromptLimitToToolArgs("GITHUB_LIST_REPOSITORY_ISSUES", {}, "read 5 emails")).toEqual({});
  });

  test("normalizes collection reads generically", () => {
    expect(normalizeToolArgs("GITHUB_LIST_REPOSITORY_ISSUES", { per_page: 100 })).toEqual({
      per_page: 100,
      include_payload: false,
      verbose: false,
    });
  });
});
