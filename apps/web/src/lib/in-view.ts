import { useEffect, useState } from "react"

/**
 * Whether an element has come within `margin` of the viewport (through any scrolling ancestor),
 * and stays true once it has: a ref callback to put on it, and the answer. Without
 * IntersectionObserver everything counts as in view.
 */
export function useInView<T extends Element>(margin = "400px"): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    if (seen || !element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setSeen(true)
        observer.disconnect()
      },
      { rootMargin: margin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, seen, margin])
  return [setElement, seen]
}
