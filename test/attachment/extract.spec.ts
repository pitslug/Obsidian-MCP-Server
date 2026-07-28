/**
 * Attachment text extraction.
 *
 * The behaviour worth defending here is the distinction between "this document
 * contains no words" and "this document's words are pictures". Those look
 * identical to a naive extractor: both yield an empty string. Conflating them
 * would mean a vault of scanned handwriting reports as indexed and searchable
 * while quietly matching nothing.
 */

import { describe, expect, it } from "vitest";
import { extractAttachment, extractPdf, isImage, isPdf, mimeTypeFor } from "../../src/attachment/extract.js";
import { pdfWithText, pdfWithoutText } from "../helpers/pdf.js";

describe("file type detection", () => {
    it("recognises PDFs and images by extension", () => {
        expect(isPdf("Interacts/Notes.pdf")).toBe(true);
        expect(isPdf("notes.PDF")).toBe(true);
        expect(isPdf("notes.md")).toBe(false);
        expect(isImage("photo.JPG")).toBe(true);
        expect(isImage("diagram.svg")).toBe(true);
        expect(isImage("notes.pdf")).toBe(false);
    });

    it("maps extensions to MIME types", () => {
        expect(mimeTypeFor("a.pdf")).toBe("application/pdf");
        expect(mimeTypeFor("a.PNG")).toBe("image/png");
        expect(mimeTypeFor("a.jpeg")).toBe("image/jpeg");
        expect(mimeTypeFor("a.unknown")).toBe("application/octet-stream");
    });
});

describe("PDFs with a text layer", () => {
    it("extracts the text", async () => {
        const result = await extractPdf(
            pdfWithText([
                "Harmony meeting, 2 July 2026.",
                "Discussed the Adelaide office strategy at length.",
                "Actions: confirm the lease, review headcount, report back.",
            ])
        );

        expect(result.outcome).toBe("extracted");
        expect(result.text).toContain("Adelaide office strategy");
        expect(result.pages).toBe(1);
    });

    it("reports the page count", async () => {
        const result = await extractPdf(
            pdfWithText(["Some reasonably long line of text on every page here."], 3)
        );
        expect(result.pages).toBe(3);
        expect(result.outcome).toBe("extracted");
    });

    it("merges the text of several pages", async () => {
        const result = await extractPdf(pdfWithText(["A line long enough to count as real content."], 2));
        const occurrences = result.text.split("A line long enough").length - 1;
        expect(occurrences).toBe(2);
    });
});

describe("PDFs without a text layer", () => {
    it("says so, rather than returning an empty document", async () => {
        const result = await extractPdf(pdfWithoutText());

        expect(result.outcome).toBe("no-text-layer");
        expect(result.reason).toMatch(/no usable text layer/i);
        // The reason must name the cause, since the fix differs entirely.
        expect(result.reason).toMatch(/scan|handwriting|recognition/i);
        expect(result.reason).toMatch(/OCR/);
    });

    it("treats a page with only a stray character as having no text layer", async () => {
        // Scans commonly yield a few characters from a header stamp: enough to
        // look non-empty, nowhere near enough to search.
        const result = await extractPdf(pdfWithText(["p1"]));
        expect(result.outcome).toBe("no-text-layer");
    });
});

describe("failures", () => {
    it("reports an unreadable PDF instead of throwing", async () => {
        const result = await extractPdf(new Uint8Array([1, 2, 3, 4, 5]));
        expect(result.outcome).toBe("failed");
        expect(result.reason).toMatch(/could not read/i);
    });

    it("does not consume the caller's buffer", async () => {
        // The PDF machinery transfers the buffer it is given; a caller that
        // still needs those bytes would otherwise find them gone.
        const bytes = pdfWithText(["A line of genuine content for this test."]);
        const before = bytes.length;
        await extractPdf(bytes);
        expect(bytes.length).toBe(before);
        expect(bytes[0]).toBe("%".charCodeAt(0));
    });
});

describe("non-PDF attachments", () => {
    it("reports images as having nothing to extract, not as a failure", async () => {
        const result = await extractAttachment("photo.png", new Uint8Array([137, 80, 78, 71]));
        expect(result.outcome).toBe("not-textual");
        expect(result.reason).toMatch(/look at it/i);
    });

    it("reports an unsupported type by name", async () => {
        const result = await extractAttachment("archive.zip", new Uint8Array([80, 75]));
        expect(result.outcome).toBe("not-textual");
        expect(result.reason).toMatch(/zip/);
    });
});
