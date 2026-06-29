import { describe, expect, test } from "bun:test";
import { buildRetryArgs, isCollectionReadTool, isMutatingToolSlug, normalizeToolArgs } from "../src/lib/tool-recovery";
import type { NormalizedToolError } from "../src/lib/tool-errors";

const payloadError: NormalizedToolError = {
  message: "too large",
  category: "payload_too_large",
  retryable: true,
  status: 413,
};

describe("tool recovery policy", () => {
  test("identifies broad tool classes", () => {
    expect(isCollectionReadTool("GOOGLESUPER_FETCH_EMAILS")).toBe(true);
    expect(isCollectionReadTool("GITHUB_LIST_REPOSITORY_ISSUES")).toBe(true);
    expect(isMutatingToolSlug("GOOGLESUPER_CREATE_GOOGLE_SHEET1")).toBe(true);
  });

  test("classifies sheet-write tools as mutating regardless of verb position", () => {
    // Verb is not the first token — prefix-only matching used to miss these,
    // letting them execute with no confirmation card.
    expect(isMutatingToolSlug("GOOGLESUPER_SPREADSHEETS_VALUES_APPEND")).toBe(true);
    expect(isMutatingToolSlug("GOOGLESUPER_SHEET_FROM_JSON")).toBe(true);
    expect(isMutatingToolSlug("GOOGLESUPER_SPREADSHEETS_BATCH_UPDATE")).toBe(true);
    expect(isMutatingToolSlug("GOOGLESUPER_SEND_EMAIL")).toBe(true);
    expect(isMutatingToolSlug("GITHUB_CREATE_AN_ISSUE")).toBe(true);
  });

  test("does not over-classify batched/standard reads as mutating", () => {
    expect(isMutatingToolSlug("GOOGLESUPER_BATCH_GET")).toBe(false);
    expect(isMutatingToolSlug("GOOGLESUPER_GET_BATCH_VALUES")).toBe(false);
    expect(isMutatingToolSlug("GOOGLESUPER_FETCH_EMAILS")).toBe(false);
    expect(isMutatingToolSlug("GOOGLESUPER_EVENTS_LIST")).toBe(false);
    expect(isMutatingToolSlug("GITHUB_GET_AN_ISSUE")).toBe(false);
  });

  test("is toolkit-agnostic: a new toolkit's write/read verbs classify correctly", () => {
    expect(isMutatingToolSlug("SLACK_SEND_MESSAGE")).toBe(true);
    expect(isMutatingToolSlug("LINEAR_CREATE_ISSUE")).toBe(true);
    expect(isMutatingToolSlug("SLACK_SEARCH_MESSAGES")).toBe(false);
    // Unknown verb-less tool defaults to mutating (gated, not silently run).
    expect(isMutatingToolSlug("NOTION_PAGE_FROM_TEMPLATE")).toBe(true);
  });

  test("normalizes collection reads before execution", () => {
    expect(
      normalizeToolArgs("GOOGLESUPER_FETCH_EMAILS", {
        max_results: 100,
        include_payload: true,
        verbose: true,
      })
    ).toMatchObject({
      max_results: 100,
      include_payload: false,
      verbose: false,
    });
  });

  test("builds generic smaller retry args for payload-too-large", () => {
    expect(
      buildRetryArgs(
        "GITHUB_LIST_REPOSITORY_ISSUES",
        { per_page: 100, verbose: true, include_body: true },
        payloadError,
        1
      )
    ).toEqual({
      per_page: 25,
      verbose: false,
      include_payload: false,
      include_body: false,
    });
  });

  test("does not retry mutating tools", () => {
    expect(
      buildRetryArgs("GOOGLESUPER_CREATE_GOOGLE_SHEET1", { title: "x" }, payloadError, 1)
    ).toBeNull();
  });
});
