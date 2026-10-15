import { BellIcon, BellOffIcon, BellRingIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu"
import {
  browserPlatform,
  currentPush,
  needsInstall,
  type PushPlatform,
  type PushState,
  turnOffPush,
  turnOnPush,
} from "@/push"
import { useWorkspace } from "@/workspace"
import { reportError } from "./message"

/** Why notifications can't be turned on here, as the menu says it. */
function unavailable(state: PushState, platform: PushPlatform): string | undefined {
  if (state === "unsupported") {
    return needsInstall(platform)
      ? "Add Campflare to your Home Screen to get notifications"
      : "This browser can't show notifications"
  }
  if (state === "unconfigured") return "Notifications aren't set up on this server"
  if (state === "denied") return "Notifications are blocked in your browser's settings"
  return undefined
}

export interface Push {
  platform: PushPlatform
  /** Undefined while it's being found out. */
  state?: PushState
  setState(state: PushState): void
}

/**
 * Where push stands in this browser, found out once the app is signed in (which
 * also puts a stale subscription right: see currentPush). For the sidebar,
 * which is always there; the menu, which mounts on opening, only shows it.
 */
export function usePush(given?: PushPlatform): Push {
  const workspace = useWorkspace()
  const [platform] = useState(() => given ?? browserPlatform())
  const [state, setState] = useState<PushState>()

  useEffect(() => {
    let live = true
    currentPush(workspace, platform).then(
      (s) => live && setState(s),
      // The server or the browser failed to say: offer to turn it on, which says why if it fails again.
      () => live && setState("off"),
    )
    return () => {
      live = false
    }
  }, [workspace, platform])
  return { platform, state, setState }
}

/**
 * The workspace menu's notification items: turn push on or off in this
 * browser, or send a test; or why it can't be had here. Nothing while it looks.
 */
export function NotificationItems({ push: { platform, state, setState } }: { push: Push }) {
  const workspace = useWorkspace()
  if (!state) return null
  const why = unavailable(state, platform)
  if (why) {
    return (
      <DropdownMenuGroup>
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          <BellOffIcon className="mr-2 inline size-4" aria-hidden />
          {why}
        </DropdownMenuLabel>
      </DropdownMenuGroup>
    )
  }
  if (state === "off") {
    return (
      <DropdownMenuItem
        onClick={() => {
          turnOnPush(workspace, platform)
            .then((s) => {
              setState(s)
              if (s === "on") toast.success("Notifications are on in this browser")
            })
            .catch(reportError("turn on notifications"))
        }}
      >
        <BellIcon />
        Turn on notifications
      </DropdownMenuItem>
    )
  }
  return (
    <>
      <DropdownMenuItem
        onClick={() => {
          workspace
            .testPush()
            .then(({ sent }) => toast.info(`Sent a test notification to ${sent} device${sent === 1 ? "" : "s"}`))
            .catch(reportError("send a test notification"))
        }}
      >
        <BellRingIcon />
        Send a test notification
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          turnOffPush(workspace, platform).then(setState).catch(reportError("turn off notifications"))
        }}
      >
        <BellOffIcon />
        Turn off notifications
      </DropdownMenuItem>
    </>
  )
}
