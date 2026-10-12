import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./app"
import { webOrigin } from "./server-address"
import { devSession, platformStore } from "./session"
import { followSystemTheme } from "./theme"

followSystemTheme()
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      store={platformStore()}
      autoSession={devSession(__CAMPFLARE_DEV__, location.search)}
      devServer={__CAMPFLARE_DEV__?.url}
      origin={webOrigin()}
    />
  </StrictMode>,
)
