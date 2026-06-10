export const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const SLUG_MAX_LEN = 50;
export const RESERVED_SLUGS = new Set(['health', 'ready', 'metrics']);

export function isValidSlug(slug) {
  return (
    typeof slug === 'string' &&
    SLUG_PATTERN.test(slug) &&
    slug.length <= SLUG_MAX_LEN &&
    !RESERVED_SLUGS.has(slug)
  );
}
