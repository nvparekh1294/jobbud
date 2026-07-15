// Shared HTML-escaping helpers for building email/HTML output from scraped or
// AI-generated job fields (titles, company names, descriptions, summaries).
//
// esc()     — encode the five HTML-significant characters so a value renders as
//             text and cannot inject markup.
// safeUrl() — only permit http(s) URLs in an href attribute; anything else
//             (javascript:, data:, relative/internal) collapses to '#'. The
//             result is also esc()'d so a stray quote can't break out of the
//             surrounding attribute.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function safeUrl(u) {
  return /^https?:\/\//i.test(String(u ?? '')) ? esc(u) : '#';
}
