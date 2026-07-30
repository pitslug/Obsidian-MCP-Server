/**
 * The changes feed, and what it does when it falls over.
 *
 * Everything else about the index is tested through a real replica, which is
 * the right way round: the queries matter more than the plumbing. This one is
 * tested against a fake feed, because the behaviour being checked is what
 * happens after an error, and an error that a real PouchDB can be persuaded to
 * emit on demand is not the error this is for.
 *
 * The failure it exists to prevent was silent and permanent. On any error the
 * feed logged once, set itself inactive, and stayed dead until the process
 * restarted. Reads kept working, so nothing looked wrong, and every note
 * written from then on was missing from search.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexBuilder } from "../../src/index/builder.js";
import { VaultIndex } from "../../src/index/index.js";
import type { Logger } from "../../src/server/logger.js";

/** A changes feed that does nothing until a test tells it to. */
class FakeFeed {
    handlers = new Map<string, (value: unknown) => void>();
    cancelled = false;

    constructor(readonly options: { since?: string | number }) {}

    on(event: string, handler: (value: unknown) => void): this {
        this.handlers.set(event, handler);
        return this;
    }

    cancel(): void {
        this.cancelled = true;
    }

    emit(event: string, value: unknown): void {
        this.handlers.get(event)?.(value);
    }
}

let feeds: FakeFeed[];
let index: VaultIndex;
let builder: IndexBuilder;
let warnings: string[];

const latest = () => feeds[feeds.length - 1] as FakeFeed;

const logger = (): Logger =>
    ({
        debug: () => undefined,
        info: () => undefined,
        warn: (message: string) => warnings.push(message),
        error: (message: string) => warnings.push(message),
    }) as unknown as Logger;

beforeEach(async () => {
    vi.useFakeTimers();
    feeds = [];
    warnings = [];

    index = new VaultIndex(":memory:");
    index.open();

    const replicator = {
        database: {
            info: async () => ({ update_seq: "seq-1" }),
            changes: (options: { since?: string | number }) => {
                const feed = new FakeFeed(options);
                feeds.push(feed);
                return feed;
            },
        },
    } as never;

    builder = new IndexBuilder(replicator, {} as never, index, logger());
    await builder.follow();
});

afterEach(() => {
    builder.stop();
    index.close();
    vi.useRealTimers();
});

describe("following the replica", () => {
    it("starts from where the replica is, not from the beginning", () => {
        // A rebuild has just covered everything before this point. Replaying
        // from zero would index the whole vault a second time.
        expect(feeds.length).toBe(1);
        expect(latest().options.since).toBe("seq-1");
    });

    it("puts the feed back after an error, rather than dying quietly", () => {
        latest().emit("error", new Error("socket hung up"));
        expect(feeds.length).toBe(1);

        vi.advanceTimersByTime(1_000);
        expect(feeds.length).toBe(2);
        expect(builder.feedAttached).toBe(true);
    });

    it("says what the outage costs while it lasts", () => {
        // A warning that only says a feed dropped is a warning nobody acts on.
        // What matters is that search has quietly stopped keeping up.
        latest().emit("error", new Error("socket hung up"));
        expect(warnings.join("\n")).toContain("will not appear in search");
        expect(warnings.join("\n")).toContain("Reconnecting in 1s");
    });

    it("resumes from the last change it applied, not from now", () => {
        // "Now" at the moment of reconnection means "skip whatever happened
        // while the feed was dead", which is the same silent gap in a smaller
        // window.
        latest().emit("change", { id: "note.md", seq: "seq-9" });
        latest().emit("error", new Error("socket hung up"));
        vi.advanceTimersByTime(1_000);

        expect(latest().options.since).toBe("seq-9");
    });

    it("backs off, and gives up waiting longer at a minute", () => {
        const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
        for (const wait of waits) {
            latest().emit("error", new Error("still down"));
            // Not yet: the wait is the point.
            vi.advanceTimersByTime(wait - 1);
            const before = feeds.length;
            vi.advanceTimersByTime(1);
            expect(feeds.length, `after ${wait}ms`).toBe(before + 1);
        }
    });

    it("starts the backoff over once a change gets through", () => {
        latest().emit("error", new Error("down"));
        vi.advanceTimersByTime(1_000);
        latest().emit("error", new Error("down again"));
        vi.advanceTimersByTime(2_000);

        // A change means whatever was wrong is over.
        latest().emit("change", { id: "note.md", seq: "seq-2" });
        latest().emit("error", new Error("down once more"));

        const before = feeds.length;
        vi.advanceTimersByTime(1_000);
        expect(feeds.length).toBe(before + 1);
    });

    it("does not reconnect after it has been stopped", () => {
        // Otherwise shutting the server down leaves a timer that reattaches a
        // feed to a database that is being closed.
        latest().emit("error", new Error("down"));
        builder.stop();
        vi.advanceTimersByTime(60_000);

        expect(feeds.length).toBe(1);
        expect(builder.feedAttached).toBe(false);
    });

    it("cancels the feed when it is stopped", () => {
        builder.stop();
        expect(feeds[0]?.cancelled).toBe(true);
    });
});
