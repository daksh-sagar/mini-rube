import { describe, expect, test } from "bun:test";
import { normalizeToolError } from "../src/lib/tool-errors";

describe("normalizeToolError", () => {
  test("extracts Composio payload-too-large details", () => {
    const normalized = normalizeToolError({
      status: 413,
      headers: new Headers({ "x-request-id": "req_1" }),
      error: {
        error: {
          message: "The tool response payload is too large.",
          code: 1613,
          slug: "Upstream_PayloadTooLarge",
          status: 413,
          request_id: "req_nested",
          suggested_fix: "Reduce the size of data.",
        },
      },
    });

    expect(normalized).toMatchObject({
      status: 413,
      code: 1613,
      slug: "Upstream_PayloadTooLarge",
      requestId: "req_nested",
      suggestedFix: "Reduce the size of data.",
      category: "payload_too_large",
      retryable: true,
    });
  });

  test("classifies common status codes", () => {
    expect(normalizeToolError({ status: 429, message: "rate limit" }).category).toBe("rate_limited");
    expect(normalizeToolError({ status: 401, message: "unauthorized" }).category).toBe("auth");
    expect(normalizeToolError({ status: 404, message: "missing" }).category).toBe("not_found");
    expect(normalizeToolError({ status: 500, message: "server error" }).category).toBe("server");
    expect(normalizeToolError({ status: 400, message: "bad args" }).category).toBe("bad_request");
  });
});
