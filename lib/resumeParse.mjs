// Shared guard for the resume-text extraction path (api/coach.js parse-resume).
// Kept tiny and dependency-free so it can be unit-tested in isolation.

// User-facing message when a PDF/DOCX yields no usable text — typically a
// scanned or image-based PDF that has no embedded text layer.
export const EMPTY_RESUME_ERROR =
  "We couldn't find any readable text in that file — it may be a scanned or image-based PDF. Try exporting a text-based PDF, or paste your resume instead.";

// True when the extracted text is missing or whitespace-only.
export function isExtractedTextEmpty(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}
