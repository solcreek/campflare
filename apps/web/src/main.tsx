import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./app"
import { browserStore, devSession } from "./session"
import { followSystemTheme } from "./theme"

followSystemTheme()
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App store={browserStore()} autoSession={devSession(__CAMPFLARE_DEV__, location.search)} />
  </StrictMode>,
)
