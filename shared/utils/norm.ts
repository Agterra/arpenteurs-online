/**
 * Canonical card-name normalizer, shared by the catalog import (nameNorm/alias
 * columns) and the decklist parser (user input). Both sides MUST use the same
 * function or exact-match resolution silently breaks.
 */
export function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
