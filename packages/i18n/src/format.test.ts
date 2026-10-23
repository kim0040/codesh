import { describe, expect, it } from "vitest";
import { formatDuration, formatNumber, formatRelativeTime } from "./index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("says 'just now' under a minute, in both directions", () => {
    expect(formatRelativeTime("en", -30_000)).toBe("Just now");
    expect(formatRelativeTime("ko", 20_000)).toBe("방금");
  });

  it("formats the past", () => {
    expect(formatRelativeTime("en", -5 * MIN)).toBe("5 minutes ago");
    expect(formatRelativeTime("ko", -5 * MIN)).toBe("5분 전");
    expect(formatRelativeTime("en", -3 * HOUR)).toBe("3 hours ago");
    expect(formatRelativeTime("ko", -3 * HOUR)).toBe("3시간 전");
    expect(formatRelativeTime("en", -10 * DAY)).toBe("10 days ago");
  });

  it("formats the future", () => {
    expect(formatRelativeTime("en", 3 * DAY)).toBe("in 3 days");
    expect(formatRelativeTime("ko", 3 * DAY)).toBe("3일 후");
  });

  it("rounds down so '59 minutes' never turns into '60 minutes'", () => {
    expect(formatRelativeTime("en", -(HOUR - 1))).toBe("59 minutes ago");
  });

  it("moves to months and years", () => {
    expect(formatRelativeTime("en", -90 * DAY)).toBe("3 months ago");
    expect(formatRelativeTime("en", -800 * DAY)).toBe("2 years ago");
  });
});

describe("formatDuration", () => {
  it("shows the largest unit and the next one", () => {
    expect(formatDuration("en", HOUR + 30 * MIN)).toBe("1 hr 30 min");
    expect(formatDuration("ko", HOUR + 30 * MIN)).toBe("1시간 30분");
    expect(formatDuration("en", 2 * DAY + 5 * HOUR + 10 * MIN)).toBe("2 days 5 hr");
  });

  it("drops a zero second unit and handles tiny values", () => {
    expect(formatDuration("en", 2 * HOUR)).toBe("2 hr");
    expect(formatDuration("en", 45_000)).toBe("45 sec");
    expect(formatDuration("en", 0)).toBe("0 sec");
    expect(formatDuration("en", -500)).toBe("0 sec");
  });

  it("supports other styles", () => {
    expect(formatDuration("en", HOUR + MIN, "long")).toBe("1 hour 1 minute");
    expect(formatDuration("ko", 90 * MIN, "long")).toBe("1시간 30분");
  });
});

describe("formatNumber", () => {
  it("groups digits", () => {
    expect(formatNumber("en", 1234567)).toBe("1,234,567");
    expect(formatNumber("ko", 1234567)).toBe("1,234,567");
  });
});
