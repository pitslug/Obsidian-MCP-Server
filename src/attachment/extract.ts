/**
 * Getting text out of attachments.
 *
 * The important distinction, and the one that decides whether any of this is
 * useful for a given vault: extraction reads the text a PDF already contains.
 * It is not recognition. A PDF of handwriting has a text layer only if
 * something put one there - OneNote's handwriting recognition does, a scanner
 * without OCR does not, and a pen-on-tablet export usually does not either.
 *
 * When there is no text layer this says so, loudly and specifically, rather
 * than returning an empty string that looks like an empty document. The
 * difference matters: one means "this file has no words in it", the other
 * means "this file's words are pictures".
 */

import { extractText, getDocumentProxy } from "unpdf";

export type ExtractionOutcome =
    | "extracted"
    /** A PDF whose pages carry no meaningful text layer. */
    | "no-text-layer"
    /** A file type with no text to extract, such as an image. */
    | "not-textual"
    | "failed";

export interface ExtractionResult {
    outcome: ExtractionOutcome;
    text: string;
    pages: number;
    /** Mean extracted characters per page; the basis of the text-layer check. */
    charsPerPage: number;
    /** Present for `no-text-layer` and `failed`, explaining what to do next. */
    reason: string | undefined;
}

/**
 * Below this many characters per page, a PDF is treated as having no usable
 * text layer.
 *
 * Scanned documents commonly extract a handful of characters per page from
 * stray metadata or a header stamp, which is enough to look non-empty and not
 * nearly enough to search. A page of real prose runs to hundreds.
 */
const MIN_CHARS_PER_PAGE = 25;

export function isPdf(path: string): boolean {
    return /\.pdf$/i.test(path);
}

export function isImage(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(path);
}

/** MIME type from the extension, for returning bytes to a client. */
export function mimeTypeFor(path: string): string {
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
    switch (ext) {
        case "pdf":
            return "application/pdf";
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        case "avif":
            return "image/avif";
        case "bmp":
            return "image/bmp";
        case "svg":
            return "image/svg+xml";
        case "txt":
        case "md":
        case "csv":
            return "text/plain";
        case "json":
            return "application/json";
        default:
            return "application/octet-stream";
    }
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
    try {
        // A copy, because the PDF machinery transfers the buffer it is given
        // and the caller may still need theirs.
        //
        // `verbosity: 0` is ERRORS-only. Left at its default, pdf.js writes a
        // warning to stderr for every font it substitutes and every optional
        // feature the running V8 lacks: a single vault of scanned PDFs produces
        // hundreds of lines of "Math.sumPrecise is not a function" that mean
        // nothing, extract nothing differently, and bury the log lines that do
        // matter. Errors still come through, and the outcomes this function
        // returns are what actually report a PDF it could not read.
        const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
        const { totalPages, text } = await extractText(doc, { mergePages: true });

        const merged = (Array.isArray(text) ? text.join("\n\n") : text).replace(/\s+\n/g, "\n").trim();
        const pages = totalPages || 1;
        const charsPerPage = merged.length / pages;

        if (charsPerPage < MIN_CHARS_PER_PAGE) {
            return {
                outcome: "no-text-layer",
                text: merged,
                pages,
                charsPerPage,
                reason:
                    `Only ${merged.length} character(s) across ${pages} page(s). This PDF has no ` +
                    `usable text layer, which is normal for a scan or for handwriting that was ` +
                    `never run through recognition. Its contents cannot be searched without OCR.`,
            };
        }

        return { outcome: "extracted", text: merged, pages, charsPerPage, reason: undefined };
    } catch (error) {
        return {
            outcome: "failed",
            text: "",
            pages: 0,
            charsPerPage: 0,
            reason: `Could not read this PDF: ${(error as Error).message}`,
        };
    }
}

/**
 * Extract whatever text an attachment has.
 *
 * Only PDFs are handled today. Images are reported as `not-textual` rather than
 * failing, because there is a sensible thing to do with them (hand them to a
 * model that can look at them) and that is the caller's decision.
 */
export async function extractAttachment(path: string, bytes: Uint8Array): Promise<ExtractionResult> {
    if (isPdf(path)) return extractPdf(bytes);

    if (isImage(path)) {
        return {
            outcome: "not-textual",
            text: "",
            pages: 0,
            charsPerPage: 0,
            reason: "Images carry no text layer. Retrieve the image itself to look at it.",
        };
    }

    return {
        outcome: "not-textual",
        text: "",
        pages: 0,
        charsPerPage: 0,
        reason: `No text extractor for "${path.split(".").pop() ?? "this file type"}".`,
    };
}
