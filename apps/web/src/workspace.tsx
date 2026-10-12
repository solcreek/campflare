import type { Workspace, WorkspaceState } from "@campflare/core"
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react"

// The app's one workspace, shared through context. Components read slices of
// its state with useWorkspaceState and act through useWorkspace().

const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error("useWorkspace needs a WorkspaceProvider")
  return workspace
}

/**
 * A slice of the state; the component renders again when it changes. The state
 * is immutable, so a selector returning part of it as is (not a new object or
 * array) is free. Selectors that derive new values belong in useMemo on top.
 */
export function useWorkspaceState<T>(select: (state: WorkspaceState) => T): T {
  const workspace = useWorkspace()
  return useSyncExternalStore(workspace.subscribe, () => select(workspace.getState()))
}
