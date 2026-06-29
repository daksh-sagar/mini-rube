export type SupportedToolkit = "googlesuper" | "github";

export type ToolkitAccessRequirement = {
  label: string;
  reason: string;
  tools: string[];
};

export const TOOLKIT_AUTH_REQUIREMENTS: Record<SupportedToolkit, ToolkitAccessRequirement[]> = {
  googlesuper: [
    {
      label: "Gmail",
      reason: "Read important emails, fetch message details, send confirmed email, and attach PDFs.",
      tools: [
        "GOOGLESUPER_FETCH_EMAILS",
        "GOOGLESUPER_FETCH_MESSAGE_BY_MESSAGE_ID",
        "GOOGLESUPER_GET_ATTACHMENT",
        "GOOGLESUPER_SEND_EMAIL",
      ],
    },
    {
      label: "Contacts",
      reason: "Find recipients such as Karan without exposing full email addresses in chat.",
      tools: ["GOOGLESUPER_GET_CONTACTS", "GOOGLESUPER_SEARCH_PEOPLE"],
    },
    {
      label: "Calendar",
      reason: "Read availability and create calendar events after confirmation.",
      tools: [
        "GOOGLESUPER_CREATE_EVENT",
        "GOOGLESUPER_FIND_FREE_SLOTS",
        "GOOGLESUPER_EVENTS_LIST",
      ],
    },
    {
      label: "Drive",
      reason: "Find folders/files and parse resume documents.",
      tools: [
        "GOOGLESUPER_FIND_FILE",
        "GOOGLESUPER_FIND_FOLDER",
        "GOOGLESUPER_PARSE_FILE",
      ],
    },
    {
      label: "Sheets",
      reason: "Create and append rows to generated reports after confirmation.",
      tools: [
        "GOOGLESUPER_SHEET_FROM_JSON",
        "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
        "GOOGLESUPER_GET_BATCH_VALUES",
      ],
    },
  ],
  github: [
    {
      label: "GitHub issues",
      reason: "Read open and closed repository issues for generated reports.",
      tools: ["GITHUB_LIST_REPOSITORY_ISSUES"],
    },
  ],
};

export function authToolsForToolkit(toolkit: string) {
  return authRequirementsForToolkit(toolkit).flatMap((requirement) => requirement.tools);
}

export function authRequirementsForToolkit(toolkit: string): ToolkitAccessRequirement[] {
  if (toolkit === "googlesuper" || toolkit === "github") {
    return TOOLKIT_AUTH_REQUIREMENTS[toolkit];
  }
  return [];
}
