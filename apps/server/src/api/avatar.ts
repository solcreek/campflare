// Placeholder avatars: a person's initials on a colour derived from their id.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const firstGrapheme = (word: string) => segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? ""

/**
 * "Olive Owner" → "OO", "émile" → "É". A CJK name gives its first character
 * alone ("王小明" → "王"): two would not fit, and there's no space between words.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = firstGrapheme(words[0] ?? "")
  if (!first || CJK.test(first)) return first
  const last = words.length > 1 ? firstGrapheme(words.at(-1)!) : ""
  return (first + last).toLocaleUpperCase()
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]!)

/** The SVG for /avatars/:id: the initials of `name` (none if it's empty) on the id's colour. */
export function avatarSvg(id: string, name: string): string {
  const hue = [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0)
  const text = initials(name)
  const size = [...text].length > 1 ? 26 : 32
  const label = text
    ? `<text x="32" y="32" dy="0.35em" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif" font-size="${size}" font-weight="600">${escapeXml(text)}</text>`
    : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 55% 45%)"/>${label}</svg>`
}
