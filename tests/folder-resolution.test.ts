import { describe, expect, test } from "bun:test";
import {
  tryParseDriveFolderId,
  extractFolderNameHint,
  resolveDriveFolderRequest,
  resolveGithubRepoRequest,
  tryParseGithubRepository,
  NO_FOLDER_MESSAGE,
} from "../src/lib/workflows";

describe("tryParseDriveFolderId", () => {
  test("uses an explicit folderId as-is", () => {
    expect(tryParseDriveFolderId({ folderId: "drive_folder_123" })).toBe("drive_folder_123");
  });

  test("extracts id from a share link", () => {
    expect(
      tryParseDriveFolderId({
        prompt: "resumes in https://drive.google.com/drive/folders/1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r please",
      })
    ).toBe("1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r");
  });

  test("extracts id from an ?id= param", () => {
    expect(tryParseDriveFolderId({ prompt: "open?id=0ABCdef123456789ghIJ" })).toBe("0ABCdef123456789ghIJ");
  });

  test("matches a long mixed Drive-id token", () => {
    expect(tryParseDriveFolderId({ prompt: "use 1bOEE3JXXiFqbY99VTRq1akUOQULc5r" })).toBe(
      "1bOEE3JXXiFqbY99VTRq1akUOQULc5r"
    );
  });

  test("does not treat ordinary words or short tokens as ids", () => {
    expect(tryParseDriveFolderId({ prompt: "Take the resumes in this Drive folder, university and last job" })).toBeNull();
    expect(tryParseDriveFolderId({ prompt: "the candidates folder" })).toBeNull();
  });
});

describe("extractFolderNameHint", () => {
  test("pulls the word before 'folder'", () => {
    expect(extractFolderNameHint("Take all the resumes in the pdfs folder and make a sheet")).toBe("pdfs");
  });

  test("pulls a quoted/named folder", () => {
    expect(extractFolderNameHint('process the folder named "Q3 Candidates" please')).toBe("Q3 Candidates");
    expect(extractFolderNameHint('use the "Applicants" folder')).toBe("Applicants");
  });

  test("returns null for a generic reference", () => {
    expect(extractFolderNameHint("Take all the resumes in this Drive folder")).toBeNull();
    expect(extractFolderNameHint("make a sheet of candidate name and university")).toBeNull();
  });
});

describe("resolveDriveFolderRequest", () => {
  const execNoop = async () => ({ files: [] });

  test("returns folderId for an explicit link without calling FIND_FOLDER", async () => {
    let called = false;
    const result = await resolveDriveFolderRequest(
      "resumes in https://drive.google.com/drive/folders/abc123DEF456ghi789JKL to a sheet",
      async () => {
        called = true;
        return {};
      }
    );
    expect(result).toEqual({ folderId: "abc123DEF456ghi789JKL" });
    expect(called).toBe(false);
  });

  test("resolves a named folder via FIND_FOLDER", async () => {
    const result = await resolveDriveFolderRequest("resumes in the pdfs folder", async (slug, args) => {
      expect(slug).toBe("GOOGLESUPER_FIND_FOLDER");
      expect(args).toEqual({ query: "pdfs" });
      return { files: [{ name: "other", id: "x1" }, { name: "pdfs", id: "folder_pdfs" }] };
    });
    expect(result).toEqual({ folderId: "folder_pdfs" });
  });

  test("asks when no folder is referenced", async () => {
    const result = await resolveDriveFolderRequest("make a sheet of candidate name and university", execNoop);
    expect(result).toEqual({ ask: NO_FOLDER_MESSAGE });
  });

  test("asks (does not throw) when a named folder is not found", async () => {
    const result = await resolveDriveFolderRequest("resumes in the missing folder", execNoop);
    expect("ask" in result).toBe(true);
    if ("ask" in result) expect(result.ask).toContain("missing");
  });
});

describe("github repo resolution", () => {
  test("parses owner/repo and github URLs", () => {
    expect(tryParseGithubRepository({ prompt: "issues in composiohq/composio to a sheet" })?.repository).toBe(
      "composiohq/composio"
    );
    expect(
      tryParseGithubRepository({ prompt: "export issues from https://github.com/vercel/next.js" })?.repository
    ).toBe("vercel/next.js");
  });

  test("ignores prose like 'and/or' in the bare fallback", () => {
    expect(tryParseGithubRepository({ prompt: "make a sheet of issues and/or pull requests" })).toBeNull();
  });

  test("resolveGithubRepoRequest asks when no repo is present", () => {
    const result = resolveGithubRepoRequest("create a spreadsheet summarizing all the github issues");
    expect("ask" in result).toBe(true);
  });

  test("resolveGithubRepoRequest returns the repository when present", () => {
    expect(resolveGithubRepoRequest("issues in facebook/react to sheets")).toEqual({
      repository: "facebook/react",
    });
  });
});
