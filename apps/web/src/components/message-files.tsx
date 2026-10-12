import { fileKind, fileLabel, fitImage, formatBytes, type MessageFile } from "@campflare/core"
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, LoaderCircleIcon } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useInView } from "@/lib/in-view"
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

/** Saves a private file through a short-lived object URL: a plain link couldn't send the token. */
function saveFile(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = href
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

/** Downloads a file with the token and saves it under its name; `saving` while that runs. */
function useDownload(file: MessageFile) {
  const workspace = useWorkspace()
  const [saving, setSaving] = useState(false)
  const url = file.url_private_download ?? file.url_private
  const name = file.name ?? fileLabel(file)
  const download = () => {
    if (!url) return
    setSaving(true)
    workspace.files
      .blob(url)
      .then((blob) => saveFile(blob, name))
      .catch(reportError(`download ${name}`))
      .finally(() => setSaving(false))
  }
  return { url, name, saving, download }
}

/**
 * An image in a message, drawn in a box of its final size from the start (original_w and
 * original_h), so nothing moves when it arrives. Its bytes are fetched only once it nears the
 * viewport: the server has no thumbnails, so each one is the whole file.
 */
function ImageFile({ file, onOpen }: { file: MessageFile; onOpen: () => void }) {
  const [ref, inView] = useInView<HTMLButtonElement>()
  const { src, failed } = usePrivateFile(inView ? file.url_private : undefined)
  if (failed) return <FileCard file={file} />
  const { width, height } = fitImage(file, IMAGE_BOX.width, IMAGE_BOX.height)
  const label = fileLabel(file)
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Open ${label}`}
      aria-haspopup="dialog"
      className="max-w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onClick={onOpen}
    >
      {src ? (
        <img
          src={src}
          alt={label}
          title={file.title || file.name}
          width={width}
          height={height}
          className="block max-w-full rounded-md border bg-muted object-contain"
          style={{ maxHeight: IMAGE_BOX.height }}
        />
      ) : (
        <Skeleton role="img" aria-label={`Loading ${label}`} className="block max-w-full" style={{ width, height }} />
      )}
    </button>
  )
}

/**
 * One message's images at full size: Escape or a click outside closes it, the arrow keys
 * (and the buttons) step through the images, Download saves the one shown.
 */
function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: MessageFile[]
  index: number | undefined
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const file = index === undefined ? undefined : images[index]
  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => !open && onClose()}>
      {file && <ViewerContent images={images} index={index!} onIndexChange={onIndexChange} />}
    </Dialog>
  )
}

function ViewerContent({
  images,
  index,
  onIndexChange,
}: {
  images: MessageFile[]
  index: number
  onIndexChange: (index: number) => void
}) {
  const file = images[index]!
  const { src, failed } = usePrivateFile(file.url_private)
  const { url, name, saving, download } = useDownload(file)
  const label = fileLabel(file)
  // The window less the dialog's margins and header: the box reserved while the bytes load.
  const { width, height } = fitImage(
    file,
    Math.max(160, window.innerWidth - 96),
    Math.max(120, window.innerHeight - 160),
  )
  const several = images.length > 1
  const step = (by: number) => onIndexChange((index + by + images.length) % images.length)
  const onKeyDown = (e: KeyboardEvent) => {
    if (!several) return
    if (e.key === "ArrowLeft") step(-1)
    else if (e.key === "ArrowRight") step(1)
    else return
    e.preventDefault()
  }
  const details = [
    several ? `${index + 1} of ${images.length}` : undefined,
    file.title && file.title !== name ? name : undefined,
    file.size !== undefined ? formatBytes(file.size) : undefined,
  ].filter(Boolean)

  // The dialog itself takes focus when it opens, not Download: Enter mustn't save a file by accident.
  const popup = useRef<HTMLDivElement>(null)

  return (
    <DialogContent
      ref={popup}
      initialFocus={popup}
      className="w-max max-w-[calc(100vw-2rem)] gap-3 sm:max-w-[calc(100vw-4rem)]"
      onKeyDown={onKeyDown}
    >
      <DialogHeader className="min-w-0 pr-16">
        <DialogTitle className="truncate leading-normal">{file.title || name}</DialogTitle>
        <DialogDescription className={details.length > 0 ? "truncate" : "sr-only"}>
          {details.length > 0 ? details.join(" · ") : label}
        </DialogDescription>
      </DialogHeader>
      {url && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-10"
          aria-label={`Download ${name}`}
          disabled={saving}
          onClick={download}
        >
          <DownloadIcon />
        </Button>
      )}
      <div className="relative flex min-w-40 items-center justify-center">
        {src ? (
          <img
            src={src}
            alt={label}
            width={width}
            height={height}
            // Viewport units, not percentages: the dialog (w-max: it is centred with left 50%) takes its width from the image.
            style={{ width, height }}
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-6rem)] rounded-md object-contain"
          />
        ) : failed ? (
          <p className="p-8 text-muted-foreground">Couldn't load this image.</p>
        ) : (
          <Skeleton
            role="img"
            aria-label={`Loading ${label}`}
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-6rem)]"
            style={{ width, height }}
          />
        )}
        {several && (
          <>
            <Button
              variant="secondary"
              size="icon"
              className="absolute left-2 opacity-80 hover:opacity-100"
              aria-label="Previous image"
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              className="absolute right-2 opacity-80 hover:opacity-100"
              aria-label="Next image"
              onClick={() => step(1)}
            >
              <ChevronRightIcon />
            </Button>
          </>
        )}
      </div>
    </DialogContent>
  )
}

function FileCard({ file, uploading }: { file: MessageFile; uploading?: boolean }) {
  const { url, name, saving, download } = useDownload(file)
  const details = [file.size !== undefined ? formatBytes(file.size) : undefined, file.pretty_type ?? file.filetype]
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

/** A message's files: images inline (a click opens them full size), the rest as cards, a note where one was deleted. */
export function MessageFiles({ files, uploading }: { files: MessageFile[]; uploading?: boolean }) {
  const [viewing, setViewing] = useState<number>()
  const images = uploading ? [] : files.filter((f) => fileKind(f) === "image")
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
        if (kind === "image" && !uploading)
          return <ImageFile key={file.id} file={file} onOpen={() => setViewing(images.indexOf(file))} />
        return <FileCard key={file.id} file={file} uploading={uploading} />
      })}
      {images.length > 0 && (
        <ImageViewer images={images} index={viewing} onIndexChange={setViewing} onClose={() => setViewing(undefined)} />
      )}
    </div>
  )
}
