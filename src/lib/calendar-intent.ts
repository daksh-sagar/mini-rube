export const DEFAULT_CALENDAR_TIMEZONE = "Asia/Kolkata";

export type CalendarEventDraft = {
  args: {
    summary: string;
    attendees: string[];
    start_datetime: string;
    timezone: string;
    calendar_id: "primary";
    event_duration_hour: number;
    event_duration_minutes: number;
  };
  display: {
    summary: string;
    attendee: string;
    start: string;
    durationMinutes: number;
  };
};

type ParseOptions = {
  now?: Date;
  timeZone?: string;
};

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

export function parseCalendarEventDraft(
  prompt: string,
  options: ParseOptions = {}
): CalendarEventDraft | null {
  const source = prompt.trim();
  if (!source) return null;

  const attendee = lastMatch(source, EMAIL_PATTERN)?.[0];
  if (!attendee) return null;

  const start = parseStart(source, options);
  if (!start) return null;

  const duration = parseDurationMinutes(source) ?? 30;
  if (duration <= 0) return null;

  const summary = parseSummary(source, {
    attendee,
    dateText: start.dateText,
    timeText: start.timeText,
  });
  if (!summary) return null;

  return {
    args: {
      summary,
      attendees: [attendee],
      start_datetime: start.iso,
      timezone: options.timeZone ?? DEFAULT_CALENDAR_TIMEZONE,
      calendar_id: "primary",
      event_duration_hour: Math.floor(duration / 60),
      event_duration_minutes: duration % 60,
    },
    display: {
      summary,
      attendee,
      start: start.iso,
      durationMinutes: duration,
    },
  };
}

function parseStart(prompt: string, options: ParseOptions) {
  const date = parseDate(prompt, options);
  const time = parseTime(prompt);
  if (!date || !time) return null;

  return {
    iso: `${date.isoDate}T${pad(time.hour)}:${pad(time.minute)}:00`,
    dateText: date.text,
    timeText: time.text,
  };
}

function parseDate(prompt: string, options: ParseOptions) {
  const timeZone = options.timeZone ?? DEFAULT_CALENDAR_TIMEZONE;
  const now = options.now ?? new Date();
  const matches: Array<{ index: number; isoDate: string; text: string }> = [];

  for (const relative of prompt.matchAll(/\b(today|tomorrow)\b/gi)) {
    const offset = relative[1].toLowerCase() === "tomorrow" ? 1 : 0;
    matches.push({
      index: relative.index ?? 0,
      isoDate: addDays(currentDateInZone(now, timeZone), offset),
      text: relative[0],
    });
  }

  for (const iso of prompt.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    matches.push({
      index: iso.index ?? 0,
      isoDate: `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`,
      text: iso[0],
    });
  }

  for (const month of prompt.matchAll(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi
  )) {
    const year = Number(month[3] ?? currentDateInZone(now, timeZone).slice(0, 4));
    matches.push({
      index: month.index ?? 0,
      isoDate: `${year}-${pad(MONTHS[month[1].toLowerCase().replace(".", "")])}-${pad(Number(month[2]))}`,
      text: month[0],
    });
  }

  return latestByIndex(matches);
}

function parseTime(prompt: string) {
  const matches: Array<{ index: number; hour: number; minute: number; text: string }> = [];

  for (const meridiem of prompt.matchAll(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/gi)) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? 0);
    const suffix = meridiem[3].toLowerCase();
    if (suffix === "pm" && hour !== 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    matches.push({ index: meridiem.index ?? 0, hour, minute, text: meridiem[0] });
  }

  for (const twentyFourHour of prompt.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    matches.push({
      index: twentyFourHour.index ?? 0,
      hour: Number(twentyFourHour[1]),
      minute: Number(twentyFourHour[2]),
      text: twentyFourHour[0],
    });
  }

  return latestByIndex(matches);
}

function parseDurationMinutes(prompt: string) {
  const segments = prompt
    .split(/\n+/)
    .flatMap((segment) => segment.split(/\b(?:actually|instead|make it|change it to)\b/i))
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const duration = parseDurationSegmentMinutes(segments[i]);
    if (duration != null) {
      return duration;
    }
  }

  return null;
}

function parseDurationSegmentMinutes(segment: string) {
  let total = 0;
  let found = false;

  for (const match of segment.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h)\b/gi)) {
    total += Math.round(Number(match[1]) * 60);
    found = true;
  }

  for (const match of segment.matchAll(/\b(\d+)\s*-?\s*(minutes?|mins?|min|m)\b/gi)) {
    total += Number(match[1]);
    found = true;
  }

  return found ? total : null;
}

function parseSummary(
  prompt: string,
  context: { attendee: string; dateText: string; timeText: string }
) {
  const explicit = lastMatch(
    prompt,
    /\b(?:title|titled|called|named)\s+["']?([^"',\n]+?)["']?(?=,|\n|$)/gi
  );
  if (explicit?.[1]?.trim()) {
    return cleanSummary(explicit[1]);
  }

  const parts = prompt
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidates: string[] = [];
  for (const part of parts) {
    if (part.includes(context.attendee)) continue;
    if (part.toLowerCase().includes(context.dateText.toLowerCase())) continue;
    if (part.toLowerCase().includes(context.timeText.toLowerCase())) continue;
    if (parseDurationMinutes(part) != null) continue;
    if (isSchedulingCommandPart(part)) continue;

    const summary = cleanSummary(part);
    if (summary) candidates.push(summary);
  }

  if (candidates.length) {
    return candidates.at(-1) ?? null;
  }

  return cleanSummary(summaryFromNaturalOrder(prompt, context));
}

function cleanSummary(value: string) {
  const cleaned = value
    .replace(/\b(?:event|meeting)\s+(?:title|name)\s*[:=-]\s*/i, "")
    .replace(/\b(?:duration|for)\s+\d+.*$/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (/^(event|meeting|call|invite|calendar event)$/i.test(cleaned)) {
    return null;
  }
  return cleaned.length >= 2 ? cleaned : null;
}

function isSchedulingCommandPart(value: string) {
  return /\b(?:schedule|book|create|set up|setup|add|put|make)\b/i.test(value) &&
    /\b(?:event|meeting|calendar|invite|call|with)\b/i.test(value);
}

function summaryFromNaturalOrder(
  prompt: string,
  context: { attendee: string; dateText: string; timeText: string }
) {
  return prompt
    .replace(new RegExp(escapeRegExp(context.attendee), "gi"), " ")
    .replace(new RegExp(escapeRegExp(context.dateText), "gi"), " ")
    .replace(new RegExp(escapeRegExp(context.timeText), "gi"), " ")
    .replace(/\b\d+(?:\.\d+)?\s*-?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/gi, " ")
    .replace(/\b(?:please|can you|could you|schedule|book|create|set up|setup|add|put|make)\b/gi, " ")
    .replace(/\b(?:calendar|with|for|at|on|to|from|and|a|an|the|my)\b/gi, " ")
    .replace(/[,:;()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentDateInZone(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function lastMatch(value: string, pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  let latest: RegExpMatchArray | null = null;
  for (const match of value.matchAll(global)) {
    latest = match;
  }
  return latest;
}

function latestByIndex<T extends { index: number }>(matches: T[]) {
  return matches.sort((left, right) => left.index - right.index).at(-1) ?? null;
}

function addDays(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
