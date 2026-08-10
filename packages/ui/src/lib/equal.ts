/**
 * Structural equality.
 *
 * Key order must not matter, which rules out comparing JSON strings — the
 * options bag is rebuilt from storage on every load and key order is not
 * stable.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;

  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(objB, key) && deepEqual(objA[key], objB[key]),
  );
}
