import { describe, expect, it } from "vitest";
import {
    civilDateIn,
    fillTemplate,
    inferDailyFormat,
    templateIsComplete,
    TimeZoneError,
} from "../../src/note/daily.js";

const dates = (folder: string, format: (n: number) => string, count: number) =>
    Array.from({ length: count }, (_, index) => `${folder}${format(index + 1)}.md`);

describe("civilDateIn", () => {
    it("uses the named zone rather than the host's", () => {
        // 2026-07-28T15:00Z is already the 29th in Brisbane, which is the whole
        // reason this is configurable: a UTC container would file an evening
        // capture under the previous day.
        const at = Date.UTC(2026, 6, 28, 15, 0, 0);
        expect(civilDateIn("UTC", at)).toEqual({ year: 2026, month: 7, day: 28 });
        expect(civilDateIn("Australia/Brisbane", at)).toEqual({ year: 2026, month: 7, day: 29 });
    });

    it("handles a zone west of UTC in the other direction", () => {
        const at = Date.UTC(2026, 6, 28, 3, 0, 0);
        expect(civilDateIn("America/Los_Angeles", at)).toEqual({ year: 2026, month: 7, day: 27 });
    });

    it("names the setting when the zone is not real", () => {
        expect(() => civilDateIn("Australia/Slugworx", Date.now())).toThrow(TimeZoneError);
    });
});

describe("fillTemplate", () => {
    const date = { year: 2026, month: 7, day: 5 };

    it("fills the numeric tokens with padding", () => {
        expect(fillTemplate("daily/YYYY-MM-DD.md", date)).toBe("daily/2026-07-05.md");
        expect(fillTemplate("daily/YYYY/MM/DD.md", date)).toBe("daily/2026/07/05.md");
        expect(fillTemplate("YYYYMMDD.md", date)).toBe("20260705.md");
        expect(fillTemplate("YY-MM-DD.md", date)).toBe("26-07-05.md");
    });

    it("fills month and weekday names", () => {
        expect(fillTemplate("daily/YYYY/MMMM/DD dddd.md", date)).toBe("daily/2026/July/05 Sunday.md");
        expect(fillTemplate("MMM-DD-YYYY.md", date)).toBe("Jul-05-2026.md");
    });

    it("replaces in one pass, so a filled value is not rescanned", () => {
        // "May" contains no token, but a month rendered as a name could
        // otherwise collide with a later replacement of its own text.
        expect(fillTemplate("MMMM Notes/YYYY-MM-DD.md", { year: 2026, month: 5, day: 1 })).toBe(
            "May Notes/2026-05-01.md"
        );
    });

    it("leaves text that is not a token alone", () => {
        expect(fillTemplate("journal/YYYY-MM-DD note.md", date)).toBe("journal/2026-07-05 note.md");
    });
});

describe("templateIsComplete", () => {
    it("requires a year, a month and a day", () => {
        expect(templateIsComplete("daily/YYYY-MM-DD.md")).toBe(true);
        expect(templateIsComplete("daily/YYYY/MMMM/DD.md")).toBe(true);
        expect(templateIsComplete("daily/YYYY-MM.md")).toBe(false);
        expect(templateIsComplete("daily/note.md")).toBe(false);
    });
});

describe("inferDailyFormat", () => {
    it("finds the folder and the ISO format", () => {
        const inferred = inferDailyFormat([
            "projects/house.md",
            "daily/2026-07-26.md",
            "daily/2026-07-27.md",
            "daily/2026-07-28.md",
            "inbox/thoughts.md",
        ]);

        expect(inferred?.template).toBe("daily/YYYY-MM-DD.md");
        expect(inferred?.folder).toBe("daily");
        expect(inferred?.matches).toBe(3);
        expect(inferred?.examples[0]).toBe("daily/2026-07-28.md");
        expect(inferred?.assumedDayFirst).toBe(false);
    });

    it("recognises the other separators and the compact form", () => {
        expect(inferDailyFormat(dates("journal/", (n) => `2026.07.0${n}`, 3))?.template).toBe(
            "journal/YYYY.MM.DD.md"
        );
        expect(inferDailyFormat(dates("journal/", (n) => `2026_07_0${n}`, 3))?.template).toBe(
            "journal/YYYY_MM_DD.md"
        );
        expect(inferDailyFormat(dates("journal/", (n) => `2026070${n}`, 3))?.template).toBe(
            "journal/YYYYMMDD.md"
        );
    });

    it("finds notes at the vault root", () => {
        const inferred = inferDailyFormat(["2026-07-27.md", "2026-07-28.md", "about.md"]);
        expect(inferred?.template).toBe("YYYY-MM-DD.md");
        expect(inferred?.folder).toBe("");
    });

    it("handles nested year and month folders", () => {
        const inferred = inferDailyFormat([
            "daily/2026/07/27.md",
            "daily/2026/07/28.md",
            "daily/2026/06/30.md",
        ]);
        expect(inferred?.template).toBe("daily/YYYY/MM/DD.md");
        expect(inferred?.matches).toBe(3);
    });

    it("decides day-first from a component that cannot be a month", () => {
        const inferred = inferDailyFormat(["daily/28-07-2026.md", "daily/13-07-2026.md"]);
        expect(inferred?.template).toBe("daily/DD-MM-YYYY.md");
        expect(inferred?.assumedDayFirst).toBe(false);
    });

    it("decides month-first the same way", () => {
        const inferred = inferDailyFormat(["daily/07-28-2026.md", "daily/07-13-2026.md"]);
        expect(inferred?.template).toBe("daily/MM-DD-YYYY.md");
        expect(inferred?.assumedDayFirst).toBe(false);
    });

    it("says so when nothing settles day-first against month-first", () => {
        const inferred = inferDailyFormat(["daily/07-05-2026.md", "daily/08-06-2026.md"]);
        expect(inferred?.template).toBe("daily/DD-MM-YYYY.md");
        expect(inferred?.assumedDayFirst).toBe(true);
    });

    it("needs more than one note, because one filename is not a convention", () => {
        expect(inferDailyFormat(["scratch/2026-07-28.md", "notes/a.md"])).toBeUndefined();
    });

    it("ignores numbers that are not plausible dates", () => {
        expect(inferDailyFormat(["invoices/1234-56-78.md", "invoices/1234-56-79.md"])).toBeUndefined();
    });

    it("picks the busiest folder and reports the others", () => {
        const inferred = inferDailyFormat([
            "daily/2026-07-26.md",
            "daily/2026-07-27.md",
            "daily/2026-07-28.md",
            "archive/2019-01-01.md",
            "archive/2019-01-02.md",
        ]);

        expect(inferred?.folder).toBe("daily");
        expect(inferred?.alternatives).toEqual([{ folder: "archive", matches: 2 }]);
    });

    it("ignores files that are not notes", () => {
        expect(inferDailyFormat(["shots/2026-07-27.png", "shots/2026-07-28.png"])).toBeUndefined();
    });
});
