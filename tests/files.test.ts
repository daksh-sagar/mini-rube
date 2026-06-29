import { describe, expect, test } from "bun:test";
import { MAX_PDF_UPLOAD_BYTES, uploadPdfToComposio } from "../src/lib/files";

describe("uploadPdfToComposio validation", () => {
  test("requires a user id", async () => {
    await expectRejects(
      () =>
        uploadPdfToComposio({
          file: new Blob(["pdf"], { type: "application/pdf" }),
          filename: "doc.pdf",
          userId: " ",
        }),
      "userId is required"
    );
  });

  test("rejects non-PDF uploads before requesting an upload URL", async () => {
    await expectRejects(
      () =>
        uploadPdfToComposio({
          file: new Blob(["hello"], { type: "text/plain" }),
          filename: "notes.txt",
          userId: "user_1",
        }),
      "only PDF files are supported"
    );
  });

  test("rejects empty PDFs before requesting an upload URL", async () => {
    await expectRejects(
      () =>
        uploadPdfToComposio({
          file: new Blob([], { type: "application/pdf" }),
          filename: "empty.pdf",
          userId: "user_1",
        }),
      "file is empty"
    );
  });

  test("rejects PDFs over the upload limit before reading bytes", async () => {
    const oversizedPdf = {
      type: "application/pdf",
      size: MAX_PDF_UPLOAD_BYTES + 1,
      arrayBuffer: async () => {
        throw new Error("arrayBuffer should not be called for oversized files");
      },
    } as unknown as Blob;

    await expectRejects(
      () =>
        uploadPdfToComposio({
          file: oversizedPdf,
          filename: "large.pdf",
          userId: "user_1",
        }),
      "25MB or smaller"
    );
  });
});

async function expectRejects(action: () => Promise<unknown>, expectedMessage: string) {
  try {
    await action();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(expectedMessage);
    return;
  }

  throw new Error(`Expected action to reject with "${expectedMessage}"`);
}
