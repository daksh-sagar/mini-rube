import { getTool, listToolSlugs } from "./tools";
import { AUTH_CONFIGS } from "./composio";
import type { ComposioToolSchema, ToolCatalogEntry } from "./types";

// Toolkits the agent discovers / loads / executes over = whatever has a configured
// auth config (AUTH_CONFIGS is derived from env in composio.ts). Adding a toolkit
// (Slack, Linear, …) is a single config change — a new auth config — not a code
// change here. This is what keeps tool discovery generalizable rather than wired
// to two specific toolkits.
export function supportedToolkits(): string[] {
  return Object.keys(AUTH_CONFIGS);
}
export const SUPPORTED_TOOLKITS = supportedToolkits();

let catalogCache: ToolCatalogEntry[] | null = null;
const schemaCache = new Map<string, ComposioToolSchema>();

export async function getToolCatalog(forceRefresh = false): Promise<ToolCatalogEntry[]> {
  if (catalogCache && !forceRefresh) {
    return catalogCache;
  }

  const entries: ToolCatalogEntry[] = [];
  for (const toolkit of supportedToolkits()) {
    const tools = await listToolSlugs([toolkit]);
    for (const tool of tools) {
      const slug = String(tool.slug ?? "").trim();
      if (!slug || !isAllowedToolSlug(slug, toolkit)) {
        continue;
      }

      entries.push({
        slug,
        description: String(tool.description ?? ""),
        toolkit,
      });
    }
  }

  catalogCache = dedupeTools(entries);
  return catalogCache;
}

export const listToolCatalog = getToolCatalog;
export const listComposioToolCatalog = getToolCatalog;

export async function loadToolSchemas(slugs: string[]): Promise<ComposioToolSchema[]> {
  const uniqueSlugs = [...new Set(slugs)].filter(Boolean);
  const loaded: ComposioToolSchema[] = [];

  for (const slug of uniqueSlugs) {
    const normalizedSlug = slug.trim();
    if (!isAllowedToolSlug(normalizedSlug)) {
      continue;
    }

    const cached = schemaCache.get(normalizedSlug);
    if (cached) {
      loaded.push(cached);
      continue;
    }

    const tool = await getTool(normalizedSlug);
    const toolSlug = tool ? getToolSlug(tool as ComposioToolSchema) : "";
    if (tool && isAllowedToolSlug(toolSlug)) {
      const schema = tool as ComposioToolSchema;
      schemaCache.set(normalizedSlug, schema);
      loaded.push(schema);
    }
  }

  return loaded;
}

export async function loadToolSchema(slug: string): Promise<ComposioToolSchema | null> {
  const [schema] = await loadToolSchemas([slug]);
  return schema ?? null;
}

export const loadSelectedToolSchemas = loadToolSchemas;

export function getToolSlug(tool: ComposioToolSchema) {
  return tool.slug ?? tool.name ?? "";
}

export function getToolInputSchema(tool: ComposioToolSchema) {
  const raw = tool.inputParameters ?? tool.input_parameters;

  if (isJsonSchemaObject(raw)) {
    return raw;
  }

  if (isRecord(raw)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [name, parameter] of Object.entries(raw)) {
      if (isRecord(parameter)) {
        const { required: requiredFlag, ...rest } = parameter;
        properties[name] = rest;
        if (requiredFlag === true) {
          required.push(name);
        }
      } else {
        properties[name] = parameter;
      }
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: true,
    };
  }

  return { type: "object", properties: {}, additionalProperties: true };
}

function dedupeTools(tools: ToolCatalogEntry[]) {
  const bySlug = new Map<string, ToolCatalogEntry>();
  for (const tool of tools) {
    bySlug.set(tool.slug, tool);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function clearToolCatalogCache() {
  catalogCache = null;
  schemaCache.clear();
}

export function isAllowedToolSlug(slug: string, toolkit?: string) {
  // Composio meta tools are off-limits per the brief, regardless of toolkit.
  if (slug.startsWith("COMPOSIO_")) {
    return false;
  }
  // A slug's toolkit is its first segment (GOOGLESUPER_… → googlesuper).
  const slugToolkit = slug.split("_")[0]?.toLowerCase();
  if (!slugToolkit) {
    return false;
  }
  if (toolkit) {
    return slugToolkit === toolkit.toLowerCase();
  }
  // No toolkit hint: allow any slug whose toolkit has a configured auth config.
  return supportedToolkits().some((t) => t.toLowerCase() === slugToolkit);
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
