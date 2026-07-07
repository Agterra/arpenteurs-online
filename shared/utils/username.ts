/**
 * Username hygiene: strip control + zero-width/invisible characters (log-line
 * spoofing defense), collapse whitespace, enforce 1-24 chars.
 * Usernames must only ever be rendered as DOM text nodes - never v-html.
 */
export function sanitizeUsername(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length < 1 || cleaned.length > 24) return null
  return cleaned
}
