/**
 * Render terminal control and bidi formatting characters as visible Unicode
 * escapes. Newlines are escaped by default so untrusted labels remain on one
 * line; multiline operator-authored text can opt in to preserving them.
 */
export function escapeTerminalControlCharacters(
  input: string,
  options: { preserveNewlines?: boolean } = {},
): string {
  let output = '';
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    if (character === '\n' && options.preserveNewlines === true) {
      output += '\n';
    } else if (character === '\t') {
      output += '\\t';
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else if (
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      codePoint === 0x061c
    ) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else {
      output += character;
    }
  }
  return output;
}
