// Light or dark with the system, via the .dark class shadcn's theme keys on.

export function followSystemTheme(root: HTMLElement = document.documentElement): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  const apply = () => root.classList.toggle("dark", query.matches)
  apply()
  query.addEventListener("change", apply)
  return () => query.removeEventListener("change", apply)
}
