import { describe, expect, test } from "bun:test";
import { normalizeToolArgs } from "../src/lib/tool-args";

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

  test("normalizes collection reads generically", () => {
    expect(normalizeToolArgs("GITHUB_LIST_REPOSITORY_ISSUES", { per_page: 100 })).toEqual({
      per_page: 100,
      include_payload: false,
      verbose: false,
    });
  });
});
