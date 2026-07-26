const FNV_OFFSET_BASIS = [
  0xcbf29ce484222325n,
  0x84222325cbf29ce4n,
  0x9e3779b185ebca87n,
  0x517cc1b727220a95n
] as const;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** Stable, platform-neutral content fingerprint. It is not a security primitive. */
export function stableDigest(text: string): string {
  return FNV_OFFSET_BASIS.map((seed, seedIndex) => {
    let hash: bigint = seed;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= BigInt(text.charCodeAt(index) + seedIndex);
      hash = (hash * FNV_PRIME) & UINT64_MASK;
    }
    return hash.toString(16).padStart(16, "0");
  }).join("");
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
