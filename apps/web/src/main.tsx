import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { toast } from "sonner"
import "./index.css"
import { App } from "./app"
import { browserPlatform, registerServiceWorker } from "./push"
import { webOrigin } from "./server-address"
import { devSession, noticeFileSession, platformStore } from "./session"
import { followSystemTheme } from "./theme"

followSystemTheme()
// Push notifications' service worker (docs/push.md); a click on one opens its route here.
registerServiceWorker(browserPlatform(), (route) => (location.hash = route)).catch((error: unknown) =>
  console.warn("no service worker", error),
)
// Non-blocking: the app goes on signed in, and says once where the session lives when it's a file.
const store = platformStore(
  undefined,
  noticeFileSession((message) => toast.info(message, { duration: 10_000 })),
)
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      store={store}
      autoSession={devSession(__CAMPFLARE_DEV__, location.search)}
      devServer={__CAMPFLARE_DEV__?.url}
      origin={webOrigin()}
    />
  </StrictMode>,
)
