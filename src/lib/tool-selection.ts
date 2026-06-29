import { chatToolSlugsForConnections } from "./tool-catalog";
import { isMutatingToolSlug } from "./tool-recovery";
import type { RouteToolsResult } from "./types";

export type ChatToolSelectionMode = "all_connected" | "routed";

export function resolveChatToolSelectionMode(value = process.env.CHAT_TOOL_SELECTION_MODE): ChatToolSelectionMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "routed" || normalized === "route" || normalized === "selected") {
    return "routed";
  }
  return "all_connected";
}

export function exposedToolSlugsForChat(
  route: Pick<RouteToolsResult, "slugs">,
  connections: Record<string, boolean>,
  mode: ChatToolSelectionMode = resolveChatToolSelectionMode()
) {
  if (mode === "routed") {
    return unique(route.slugs);
  }
  return chatToolSlugsForConnections(connections);
}

export function allowedMutatingToolSlugs(route: Pick<RouteToolsResult, "slugs">) {
  return route.slugs.filter(isMutatingToolSlug).filter((slug, index, all) => all.indexOf(slug) === index);
}

export function routeAllowsMutation(route: Pick<RouteToolsResult, "slugs">) {
  return allowedMutatingToolSlugs(route).length > 0;
}

export function isMutatingToolAllowedForRoute(slug: string, route: Pick<RouteToolsResult, "slugs">) {
  return allowedMutatingToolSlugs(route).includes(slug);
}

function unique(values: string[]) {
  return values.filter((value, index, all) => value && all.indexOf(value) === index);
}
