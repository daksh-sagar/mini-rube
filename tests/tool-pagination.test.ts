import { describe, expect, test } from "bun:test";
import { maybePaginateCollectionRead } from "../src/lib/tool-pagination";

function page(count: number, offset: number, nextPageToken?: string) {
  return {
    data: {
      messages: Array.from({ length: count }, (_, index) => ({
        id: `msg_${offset + index + 1}`,
        payload: {
          headers: [{ name: "Subject", value: `Message ${offset + index + 1}` }],
        },
      })),
      ...(nextPageToken ? { nextPageToken } : {}),
    },
  };
}

describe("maybePaginateCollectionRead", () => {
  test("fetches additional Gmail pages until the requested 100 items are collected", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await maybePaginateCollectionRead(
      "GOOGLESUPER_FETCH_EMAILS",
      { max_results: 100 },
      page(23, 0, "page-2"),
      async (args) => {
        calls.push(args);
        if (args.pageToken === "page-2") return page(25, 23, "page-3");
        if (args.pageToken === "page-3") return page(52, 48);
        throw new Error("unexpected page token");
      }
    ) as any;

    expect(result.data.messages).toHaveLength(100);
    expect(result.data.messages[99].id).toBe("msg_100");
    expect(calls).toEqual([
      { max_results: 77, pageToken: "page-2" },
      { max_results: 52, pageToken: "page-3" },
    ]);
  });

  test("leaves a short Gmail result alone when there is no next page token", async () => {
    const result = await maybePaginateCollectionRead(
      "GOOGLESUPER_FETCH_EMAILS",
      { max_results: 100 },
      page(23, 0),
      async () => {
        throw new Error("should not fetch another page");
      }
    ) as any;

    expect(result.data.messages).toHaveLength(23);
  });

  const countFieldCases = ["max_results", "maxResults", "limit", "per_page", "page_size", "pageSize"];

  for (const field of countFieldCases) {
    test(`fetches Gmail pages only until requested count field ${field}`, async () => {
      const calls: Record<string, unknown>[] = [];
      const result = await maybePaginateCollectionRead(
        "GOOGLESUPER_FETCH_EMAILS",
        { [field]: 5 },
        page(2, 0, "page-2"),
        async (args) => {
          calls.push(args);
          return page(10, 2);
        }
      ) as any;

      expect(result.data.messages).toHaveLength(5);
      expect(calls).toEqual([{ [field]: 3, pageToken: "page-2" }]);
    });
  }
});
