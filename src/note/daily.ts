/**
 * Working out where today's note lives.
 *
 * Obsidian keeps the daily note folder and date format in `.obsidian/`, which
 * is a hidden file. LiveSync syncs hidden files only when told to, and this
 * vault is not telling it to, so the setting is simply not in CouchDB. There is
 * no authoritative answer to read.
 *
 * What is in CouchDB is every note that has ever been created, and a vault that
 * uses daily notes contains a folder full of filenames shaped like dates. So
 * the format is inferred from the vault's own history rather than configured,
 * and `DAILY_NOTE_PATH` overrides the inference for the cases inference cannot
 * serve: a vault too new to have a pattern, or one with two folders of dated
 * notes where the wrong one wins.
 *
 * Inference reports what it found and how many notes it found it from, because
 * a wrong guess here creates a note in the wrong place, and a note in the wrong
 * place is invisible rather than obviously broken.
 *
 * ## Which day is today
 *
 * Not the container's. The server runs in UTC in deployment and the vault's
 * owner is in Brisbane, ten hours ahead, so for ten hours of every day the
 * container's date is yesterday's. "Add this to today's note" would file the
 * evening's capture under the wrong day, every evening. `VAULT_TIMEZONE` names
 * the zone whose civil date counts, and it defaults to the host's own zone,
 * which is right when the server runs on a laptop and wrong quietly enough in a
 * container that the deployment sets it explicitly.
 */

/** Tokens a path template may use, longest first so `MMMM` wins over `MM`. */
const TOKENS = ["YYYY", "MMMM", "MMM", "dddd", "ddd", "YY", "MM", "DD"] as const;
const TOKEN_PATTERN = new RegExp(TOKENS.join("|"), "g");

export interface CivilDate {
    year: number;
    /** 1 to 12. */
    month: number;
    /** 1 to 31. */
    day: number;
}

export class TimeZoneError extends Error {
    constructor(zone: string) {
        super(
            `VAULT_TIMEZONE is set to "${zone}", which is not a time zone this system knows. ` +
                `Use an IANA name such as "Australia/Brisbane" or "UTC".`
        );
        this.name = "TimeZoneError";
    }
}

/**
 * The civil date in a given zone at a given instant.
 *
 * Via `Intl` rather than by offsetting a timestamp, because an offset has to be
 * known and half the reason for naming a zone is that offsets change. `en-CA`
 * is used for its formatting alone: it is the locale that renders a date as
 * `YYYY-MM-DD`, which parses without ambiguity.
 */
export function civilDateIn(timeZone: string, now: number): CivilDate {
    let formatted: string;
    try {
        formatted = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date(now));
    } catch {
        throw new TimeZoneError(timeZone);
    }

    const [year, month, day] = formatted.split("-").map(Number);
    return { year: year as number, month: month as number, day: day as number };
}

/** The zone to use when nothing says otherwise. */
export function hostTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Fill a path template for a date.
 *
 * Every token is replaced in one pass, so a folder called `MMM Notes` cannot
 * have its `MMM` replaced and then have the result rescanned. Names come from
 * `en-GB`, which is the vault owner's spelling of a month.
 */
export function fillTemplate(template: string, date: CivilDate): string {
    const at = new Date(Date.UTC(date.year, date.month - 1, date.day));
    const name = (options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(at);

    return template.replace(TOKEN_PATTERN, (token) => {
        switch (token) {
            case "YYYY":
                return String(date.year).padStart(4, "0");
            case "YY":
                return String(date.year % 100).padStart(2, "0");
            case "MMMM":
                return name({ month: "long" });
            case "MMM":
                return name({ month: "short" });
            case "MM":
                return String(date.month).padStart(2, "0");
            case "DD":
                return String(date.day).padStart(2, "0");
            case "dddd":
                return name({ weekday: "long" });
            case "ddd":
                return name({ weekday: "short" });
            default:
                return token;
        }
    });
}

/** Whether a template can actually name a single day. */
export function templateIsComplete(template: string): boolean {
    return /YYYY|YY/.test(template) && /MMMM|MMM|MM/.test(template) && /DD/.test(template);
}

interface StemShape {
    /** The template for the stem, e.g. `YYYY-MM-DD`. */
    format: string;
    /** Which component is which, for the forms where that is not obvious. */
    order: "ymd" | "ambiguous";
    parse: RegExp;
}

/**
 * The filename shapes recognised as a date.
 *
 * Year-first forms are unambiguous and are listed first so they win. The
 * two-digit-first forms could be day-month or month-day, and which one is
 * decided by evidence across the whole folder rather than by assuming a locale.
 */
const SHAPES: StemShape[] = [
    { format: "YYYY-MM-DD", order: "ymd", parse: /^(\d{4})-(\d{2})-(\d{2})$/ },
    { format: "YYYY_MM_DD", order: "ymd", parse: /^(\d{4})_(\d{2})_(\d{2})$/ },
    { format: "YYYY.MM.DD", order: "ymd", parse: /^(\d{4})\.(\d{2})\.(\d{2})$/ },
    { format: "YYYY MM DD", order: "ymd", parse: /^(\d{4}) (\d{2}) (\d{2})$/ },
    { format: "YYYYMMDD", order: "ymd", parse: /^(\d{4})(\d{2})(\d{2})$/ },
    { format: "DD-MM-YYYY", order: "ambiguous", parse: /^(\d{2})-(\d{2})-(\d{4})$/ },
    { format: "DD_MM_YYYY", order: "ambiguous", parse: /^(\d{2})_(\d{2})_(\d{4})$/ },
    { format: "DD.MM.YYYY", order: "ambiguous", parse: /^(\d{2})\.(\d{2})\.(\d{4})$/ },
];

/** How a date-first shape is resolved once the folder has been looked at. */
const DAY_FIRST: Record<string, string> = {
    "DD-MM-YYYY": "DD-MM-YYYY",
    DD_MM_YYYY: "DD_MM_YYYY",
    "DD.MM.YYYY": "DD.MM.YYYY",
};
const MONTH_FIRST: Record<string, string> = {
    "DD-MM-YYYY": "MM-DD-YYYY",
    DD_MM_YYYY: "MM_DD_YYYY",
    "DD.MM.YYYY": "MM.DD.YYYY",
};

export interface InferredDailyFormat {
    /** A full path template, e.g. `daily/YYYY-MM-DD.md`. */
    template: string;
    /** The folder the dated notes are in, or "" for the vault root. */
    folder: string;
    /** How many existing notes match this shape. */
    matches: number;
    /** A few of them, so the inference can be checked by eye. */
    examples: string[];
    /**
     * True when the shape was day-month-year or month-day-year and no filename
     * settled which. Day-first was assumed. Worth saying out loud.
     */
    assumedDayFirst: boolean;
    /** Other folders that also hold dated notes, most populated first. */
    alternatives: { folder: string; matches: number }[];
}

interface Candidate {
    folder: string;
    format: string;
    /** True when the date lives in nested `YYYY/MM/` folders. */
    nested: boolean;
    stems: string[];
    paths: string[];
    /** Components in file order, for deciding day-first against month-first. */
    firstComponents: number[];
    secondComponents: number[];
    order: StemShape["order"];
}

/**
 * Work out the vault's daily note path template from the notes it already has.
 *
 * Requires at least two matching notes. One dated filename is not a convention,
 * and inferring a daily note location from a single note called `2026-07-28.md`
 * that somebody made once would send every capture to a folder nobody uses.
 */
export function inferDailyFormat(paths: readonly string[]): InferredDailyFormat | undefined {
    const candidates = new Map<string, Candidate>();

    for (const path of paths) {
        if (!path.toLowerCase().endsWith(".md")) continue;
        const segments = path.split("/");
        const stem = (segments.pop() as string).replace(/\.md$/i, "");

        // The date may be entirely in the filename, or split across nested
        // `YYYY/MM/` folders with the day as the filename. Both are shapes
        // Obsidian's own daily note plugin will produce.
        const nestedYear = segments.length >= 2 && /^\d{4}$/.test(segments[segments.length - 2] ?? "");
        const nestedMonth = segments.length >= 1 && /^\d{2}$/.test(segments[segments.length - 1] ?? "");
        if (nestedYear && nestedMonth && /^\d{2}$/.test(stem)) {
            const folder = segments.slice(0, -2).join("/");
            add(candidates, {
                folder,
                format: "YYYY/MM/DD",
                nested: true,
                stem,
                path,
                first: Number(segments[segments.length - 2]),
                second: Number(segments[segments.length - 1]),
                order: "ymd",
            });
            continue;
        }

        for (const shape of SHAPES) {
            const match = shape.parse.exec(stem);
            if (!match) continue;
            const [, a, b] = match;
            if (!plausible(shape, match)) break;
            add(candidates, {
                folder: segments.join("/"),
                format: shape.format,
                nested: false,
                stem,
                path,
                first: Number(a),
                second: Number(b),
                order: shape.order,
            });
            break;
        }
    }

    const ranked = [...candidates.values()]
        .filter((candidate) => candidate.paths.length >= 2)
        .sort((a, b) => b.paths.length - a.paths.length || a.folder.length - b.folder.length);

    const best = ranked[0];
    if (!best) return undefined;

    let format = best.format;
    let assumedDayFirst = false;
    if (best.order === "ambiguous") {
        const dayFirst = best.firstComponents.some((value) => value > 12);
        const monthFirst = best.secondComponents.some((value) => value > 12);
        if (monthFirst && !dayFirst) {
            format = MONTH_FIRST[best.format] ?? best.format;
        } else {
            format = DAY_FIRST[best.format] ?? best.format;
            assumedDayFirst = !dayFirst;
        }
    }

    const template = best.nested ? join(best.folder, "YYYY/MM/DD.md") : join(best.folder, `${format}.md`);

    return {
        template,
        folder: best.folder,
        matches: best.paths.length,
        examples: best.paths.slice().sort().slice(-3).reverse(),
        assumedDayFirst,
        alternatives: ranked
            .slice(1)
            .filter((candidate) => candidate.folder !== best.folder)
            .map((candidate) => ({ folder: candidate.folder, matches: candidate.paths.length })),
    };
}

/**
 * Whether the numbers in a matched filename could be a date at all.
 *
 * Without this, an invoice called `1234-56-78.md` is a daily note and a folder
 * of them outvotes the real one. Checked before the shape is accepted rather
 * than after, so a near-miss falls through to the remaining shapes.
 */
function plausible(shape: StemShape, match: RegExpExecArray): boolean {
    const [, a, b, c] = match.map(Number) as [number, number, number, number];
    if (shape.order === "ymd") {
        return a >= 1000 && a <= 9999 && b >= 1 && b <= 12 && c >= 1 && c <= 31;
    }
    // Either reading has to work: one of the first two is a month, the other a
    // day, and which is which is decided later from the whole folder.
    const dayFirst = a >= 1 && a <= 31 && b >= 1 && b <= 12;
    const monthFirst = a >= 1 && a <= 12 && b >= 1 && b <= 31;
    return (dayFirst || monthFirst) && c >= 1000 && c <= 9999;
}

function add(
    candidates: Map<string, Candidate>,
    entry: {
        folder: string;
        format: string;
        nested: boolean;
        stem: string;
        path: string;
        first: number;
        second: number;
        order: StemShape["order"];
    }
): void {
    const key = `${entry.folder} ${entry.format}`;
    const existing = candidates.get(key) ?? {
        folder: entry.folder,
        format: entry.format,
        nested: entry.nested,
        stems: [],
        paths: [],
        firstComponents: [],
        secondComponents: [],
        order: entry.order,
    };
    existing.stems.push(entry.stem);
    existing.paths.push(entry.path);
    existing.firstComponents.push(entry.first);
    existing.secondComponents.push(entry.second);
    candidates.set(key, existing);
}

function join(folder: string, rest: string): string {
    return folder ? `${folder}/${rest}` : rest;
}
