import { fileKind, fileLabel, fitImage, formatBytes, type MessageFile } from "@campflare/core"
import { DownloadIcon, FileIcon, LoaderCircleIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspace } from "@/workspace"
import { reportError } from "./message"

/** The largest an inline image is drawn; bigger ones scale down to fit. */
export const IMAGE_BOX = { width: 360, height: 240 }

/** An object URL for a private file's bytes while the component is mounted; undefined until loaded. */
export function usePrivateFile(url: string | undefined): { src?: string; failed: boolean } {
  const workspace = useWorkspace()
  const [loaded, setLoaded] = useState<{ url: string; src?: string; failed: boolean }>()
  useEffect(() => {
    if (!url) return
    let mounted = true
    workspace.files.acquire(url).then(
      (src) => mounted && setLoaded({ url, src, failed: false }),
      () => mounted && setLoaded({ url, failed: true }),
    )
    return () => {
      mounted = false
      workspace.files.release(url)
    }
  }, [workspace, url])
  return loaded && loaded.url === url ? loaded : { failed: false }
}

function ImageFile({ file }: { file: MessageFile }) {
  const { src, failed } = usePrivateFile(file.url_private)
  if (failed) return <FileCard file={file} />
  const { width, height } = fitImage(file, IMAGE_BOX.width, IMAGE_BOX.height)
  const label = fileLabel(file)
  if (!src) return <Skeleton role="img" aria-label={`Loading ${label}`} style={{ width, height }} />
  return (
    <img
      src={src}
      alt={label}
      title={file.title || file.name}
      width={width}
      height={height}
      className="max-w-full rounded-md border bg-muted object-contain"
      style={{ maxHeight: IMAGE_BOX.height }}
    />
  )
}

/** Saves a private file through a short-lived object URL: a plain link couldn't send the token. */
function saveFile(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = href
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

function FileCard({ file, uploading }: { file: MessageFile; uploading?: boolean }) {
  const workspace = useWorkspace()
  const [saving, setSaving] = useState(false)
  const url = file.url_private_download ?? file.url_private
  const name = file.name ?? fileLabel(file)
  const details = [file.size !== undefined ? formatBytes(file.size) : undefined, file.pretty_type ?? file.filetype]
  const download = () => {
    if (!url) return
    setSaving(true)
    workspace.files
      .blob(url)
      .then((blob) => saveFile(blob, name))
      .catch(reportError(`download ${name}`))
      .finally(() => setSaving(false))
  }
  return (
    <div
      role="group"
      aria-label={`File: ${name}`}
      className="flex w-72 max-w-full items-center gap-3 rounded-md border bg-card p-2 text-card-foreground"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {uploading ? <LoaderCircleIcon className="size-4 animate-spin" /> : <FileIcon className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={file.title || name}>
          {file.title || name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {uploading ? "Uploading…" : details.filter(Boolean).join(" · ")}
        </div>
      </div>
      {!uploading && url && (
        <Button variant="ghost" size="icon-sm" aria-label={`Download ${name}`} disabled={saving} onClick={download}>
          <DownloadIcon />
        </Button>
      )}
    </div>
  )
}

/** A message's files: images inline, the rest as cards, a note where one was deleted. */
export function MessageFiles({ files, uploading }: { files: MessageFile[]; uploading?: boolean }) {
  return (
    <div className="mt-1 flex flex-wrap items-start gap-2">
      {files.map((file) => {
        const kind = fileKind(file)
        if (kind === "deleted")
          return (
            <p key={file.id} className="text-sm text-muted-foreground italic">
              This file was deleted.
            </p>
          )
        if (kind === "image" && !uploading) return <ImageFile key={file.id} file={file} />
        return <FileCard key={file.id} file={file} uploading={uploading} />
      })}
    </div>
  )
}
