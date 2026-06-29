import { describe, expect, test } from "bun:test";
import { parseCalendarEventDraft } from "../src/lib/calendar-intent";

const NOW = new Date("2026-06-29T10:00:00Z");

describe("parseCalendarEventDraft", () => {
  test("parses a terse calendar follow-up with email, time, title, and duration", () => {
    const draft = parseCalendarEventDraft(
      "daksh.iitmandi@gmail.com, tomorrow 7pm, TEST EVENT, 30 mins",
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "TEST EVENT",
      attendees: ["daksh.iitmandi@gmail.com"],
      start_datetime: "2026-06-30T19:00:00",
      timezone: "Asia/Kolkata",
      calendar_id: "primary",
      event_duration_hour: 0,
      event_duration_minutes: 30,
    });
  });

  test("splits long minute durations into hour and minute fields", () => {
    const draft = parseCalendarEventDraft(
      "person@example.com, 2026-06-30 14:15, titled Planning Review, 90 mins",
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "Planning Review",
      start_datetime: "2026-06-30T14:15:00",
      event_duration_hour: 1,
      event_duration_minutes: 30,
    });
  });

  test("parses natural order scheduling details", () => {
    const draft = parseCalendarEventDraft(
      "schedule TEST EVENT tomorrow at 7pm for 30 mins with daksh.iitmandi@gmail.com",
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "TEST EVENT",
      attendees: ["daksh.iitmandi@gmail.com"],
      start_datetime: "2026-06-30T19:00:00",
      event_duration_hour: 0,
      event_duration_minutes: 30,
    });
  });

  test("parses short meeting titles and hyphenated durations", () => {
    const draft = parseCalendarEventDraft(
      "set up a 30-min sync with daksh.iitmandi@gmail.com tomorrow 7pm",
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "sync",
      start_datetime: "2026-06-30T19:00:00",
      event_duration_hour: 0,
      event_duration_minutes: 30,
    });
  });

  test("defaults duration to 30 minutes when other event details are concrete", () => {
    const draft = parseCalendarEventDraft(
      "person@example.com, tomorrow 7pm, Design Review",
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "Design Review",
      event_duration_hour: 0,
      event_duration_minutes: 30,
    });
  });

  test("combines a previous schedule request with an email-only follow-up", () => {
    const draft = parseCalendarEventDraft(
      "schedule an event with Daksh, tomorrow 1am, TESTS, 10 mins\ndaksh.iitmandi@gmail.com",
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "TESTS",
      attendees: ["daksh.iitmandi@gmail.com"],
      start_datetime: "2026-06-30T01:00:00",
      event_duration_hour: 0,
      event_duration_minutes: 10,
    });
  });

  test("uses later corrected time and duration in a multi-turn draft", () => {
    const draft = parseCalendarEventDraft(
      [
        "schedule an event with Daksh, tomorrow 7pm, TESTS, 30 mins",
        "actually 8pm and make it 45 mins",
        "daksh.iitmandi@gmail.com",
      ].join("\n"),
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "TESTS",
      attendees: ["daksh.iitmandi@gmail.com"],
      start_datetime: "2026-06-30T20:00:00",
      event_duration_hour: 0,
      event_duration_minutes: 45,
    });
  });

  test("uses later corrected title and date in a multi-turn draft", () => {
    const draft = parseCalendarEventDraft(
      [
        "schedule a calendar event with person@example.com on 2026-06-30 at 14:00 titled Planning",
        "actually July 1, 2026, called Final Review",
      ].join("\n"),
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "Final Review",
      start_datetime: "2026-07-01T14:00:00",
      event_duration_hour: 0,
      event_duration_minutes: 30,
    });
  });

  test("uses timezone supplied as a later follow-up", () => {
    const draft = parseCalendarEventDraft(
      [
        "schedule an event with person@example.com on 2026-06-30 at 13:00 titled Planning",
        "UTC",
      ].join("\n"),
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      timezone: "UTC",
      start_datetime: "2026-06-30T13:00:00",
    });
  });

  test("normalizes common timezone aliases", () => {
    const draft = parseCalendarEventDraft(
      "person@example.com, 2026-06-30 13:00, Planning, IST",
      { now: NOW, timeZone: "UTC" }
    );

    expect(draft?.args.timezone).toBe("Asia/Kolkata");
  });

  test("does not use a timezone-only follow-up as the event title", () => {
    const draft = parseCalendarEventDraft(
      [
        "send a calendar invite to Daksh",
        "Daksh Sagar",
        "tomorrow, 1 pm, Test, 30 mins",
        "IST",
        "daksh.iitmandi@gmail.com",
      ].join("\n"),
      { now: NOW, timeZone: "Asia/Kolkata" }
    );

    expect(draft?.args).toMatchObject({
      summary: "Test",
      timezone: "Asia/Kolkata",
      start_datetime: "2026-06-30T13:00:00",
    });
  });

  test("does not draft an event without complete concrete details", () => {
    expect(
      parseCalendarEventDraft("tomorrow 7pm, TEST EVENT, 30 mins", {
        now: NOW,
        timeZone: "Asia/Kolkata",
      })
    ).toBeNull();
    expect(
      parseCalendarEventDraft("daksh.iitmandi@gmail.com, tomorrow 7pm, 30 mins", {
        now: NOW,
        timeZone: "Asia/Kolkata",
      })
    ).toBeNull();
  });
});
