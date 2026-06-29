import { createHash, randomUUID } from "node:crypto";

const COMPOSIO_FILE_UPLOAD_REQUEST_URL =
  "https://backend.composio.dev/api/v3.1/files/upload/request";

export const MAX_PDF_UPLOAD_BYTES = 25 * 1024 * 1024;

export type ComposioFileRef = {
  id?: string;
  fileId?: string;
  file_id?: string;
  key?: string;
  rawResponse?: unknown;
  [key: string]: unknown;
};

export type UploadedFileRef = {
  id: string;
  userId: string;
  filename: string;
  size: number;
  mimeType: string;
  md5: string;
  composioFileRef: ComposioFileRef;
  composioUploadResponse: unknown;
  rawResponse: unknown;
  createdAt: string;
};

export type UploadPdfToComposioOptions = {
  file: Blob | File;
  userId: string;
  filename?: string;
};

type UploadRequestPayload = {
  toolkit_slug: "googlesuper";
  tool_slug: "GOOGLESUPER_SEND_EMAIL";
  filename: string;
  mimetype: string;
  md5: string;
};

export async function uploadPdfToComposio(
  fileOrOptions: Blob | File | UploadPdfToComposioOptions,
  userId?: string
): Promise<UploadedFileRef> {
  const { file, resolvedUserId, filename: providedFilename } =
    normalizeUploadInput(fileOrOptions, userId);

  if (typeof resolvedUserId !== "string" || !resolvedUserId.trim()) {
    throw new Error("Invalid file upload: userId is required.");
  }
  const normalizedUserId = resolvedUserId.trim();

  assertBlobLike(file);

  const originalFilename = providedFilename ?? getBlobFilename(file);
  const hasPdfMime = file.type.toLowerCase() === "application/pdf";
  const hasPdfExtension = originalFilename?.toLowerCase().endsWith(".pdf") ?? false;

  if (!hasPdfMime && !hasPdfExtension) {
    throw new Error(
      "Invalid file upload: only PDF files are supported. Use application/pdf or a .pdf filename."
    );
  }

  if (file.size <= 0) {
    throw new Error("Invalid file upload: file is empty.");
  }

  if (file.size > MAX_PDF_UPLOAD_BYTES) {
    throw new Error(
      `Invalid file upload: PDF must be ${formatBytes(MAX_PDF_UPLOAD_BYTES)} or smaller.`
    );
  }

  const filename = sanitizeFilename(originalFilename ?? "upload.pdf");
  const mimeType = "application/pdf";
  const fileBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(fileBuffer);
  const md5 = createHash("md5").update(bytes).digest("hex");
  const uploadRequestResponse = await requestComposioUpload({
    toolkit_slug: "googlesuper",
    tool_slug: "GOOGLESUPER_SEND_EMAIL",
    filename,
    mimetype: mimeType,
    md5,
  });

  const presignedUrl = extractPresignedUrl(uploadRequestResponse);
  if (!presignedUrl) {
    throw new Error(
      "Composio upload request failed: response did not include newPresignedUrl/new_presigned_url."
    );
  }

  await putFileToPresignedUrl(presignedUrl, fileBuffer, mimeType);

  return {
    id: randomUUID(),
    userId: normalizedUserId,
    filename,
    size: file.size,
    mimeType,
    md5,
    composioFileRef: buildComposioFileRef(uploadRequestResponse),
    composioUploadResponse: uploadRequestResponse,
    rawResponse: uploadRequestResponse,
    createdAt: new Date().toISOString(),
  };
}

export const uploadPdfFile = uploadPdfToComposio;

function normalizeUploadInput(
  fileOrOptions: Blob | File | UploadPdfToComposioOptions,
  userId?: string
) {
  if (isUploadOptions(fileOrOptions)) {
    return {
      file: fileOrOptions.file,
      resolvedUserId: fileOrOptions.userId,
      filename: fileOrOptions.filename,
    };
  }

  return {
    file: fileOrOptions,
    resolvedUserId: userId ?? "",
    filename: undefined,
  };
}

function isUploadOptions(
  value: Blob | File | UploadPdfToComposioOptions
): value is UploadPdfToComposioOptions {
  return typeof value === "object" && value !== null && "file" in value && "userId" in value;
}

function assertBlobLike(value: unknown): asserts value is Blob | File {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Blob).arrayBuffer !== "function" ||
    typeof (value as Blob).size !== "number" ||
    typeof (value as Blob).type !== "string"
  ) {
    throw new Error("Invalid file upload: expected a File or Blob.");
  }
}

function getBlobFilename(file: Blob | File) {
  const name = "name" in file && typeof file.name === "string" ? file.name : undefined;
  return name?.trim() ? name : undefined;
}

function sanitizeFilename(filename: string) {
  const base = filename.split(/[\\/]/).pop()?.trim() || "upload.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

async function requestComposioUpload(payload: UploadRequestPayload) {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is not set; cannot request Composio file upload URL.");
  }

  const response = await fetch(COMPOSIO_FILE_UPLOAD_REQUEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `Composio upload request failed with HTTP ${response.status}: ${stringifyForError(body)}`
    );
  }

  return body;
}

async function putFileToPresignedUrl(url: string, bytes: ArrayBuffer, mimeType: string) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": mimeType,
    },
    body: bytes,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Composio S3 upload failed with HTTP ${response.status}: ${body.slice(0, 500) || response.statusText}`
    );
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractPresignedUrl(response: unknown): string | undefined {
  return findStringValue(response, ["newPresignedUrl", "new_presigned_url"]);
}

function buildComposioFileRef(response: unknown): ComposioFileRef {
  const responseObject = isRecord(response) ? response : {};
  const data = isRecord(responseObject.data) ? responseObject.data : {};
  const file = isRecord(data.file) ? data.file : {};

  return {
    ...responseObject,
    ...data,
    ...file,
    id: findStringValue(response, ["id", "fileId", "file_id", "key"]),
    fileId: findStringValue(response, ["fileId", "file_id", "id"]),
    key: findStringValue(response, ["key", "fileKey", "file_key"]),
    rawResponse: response,
  };
}

function findStringValue(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (isRecord(nestedValue)) {
      const candidate = findStringValue(nestedValue, keys);
      if (candidate) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyForError(value: unknown) {
  if (typeof value === "string") {
    return value.slice(0, 500);
  }

  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}
