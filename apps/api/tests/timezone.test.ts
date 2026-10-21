import { describe, expect, it } from "vitest";
import { localDate, zonedISO } from "../../web/lib/timezone";

describe("timezone scheduling", () => {
  it("converts Karachi wall time to UTC", () => {
    expect(zonedISO("2026-10-21T17:30", "Asia/Karachi")).toBe(
      "2026-10-21T12:30:00.000Z",
    );
  });
  it("uses daylight saving offsets for the actual scheduled date", () => {
    expect(zonedISO("2026-07-01T09:00", "America/New_York")).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(zonedISO("2026-01-01T09:00", "America/New_York")).toBe(
      "2026-01-01T14:00:00.000Z",
    );
  });
  it("rejects nonexistent DST times and malformed schedules", () => {
    expect(() => zonedISO("2026-03-08T02:30", "America/New_York")).toThrow(
      "does not exist",
    );
    expect(() => zonedISO("garbage", "UTC")).toThrow();
  });
  it("resolves an ambiguous hour to a valid occurrence", () => {
    const utc = zonedISO("2026-11-01T01:30", "America/New_York");
    expect(localDate("America/New_York", new Date(utc))).toBe(
      "2026-11-01T01:30",
    );
  });
  it("initializes the date in the chosen zone rather than the device zone", () => {
    expect(localDate("Asia/Karachi", new Date("2026-10-21T20:00:00Z"))).toBe(
      "2026-10-22T01:00",
    );
  });
});
