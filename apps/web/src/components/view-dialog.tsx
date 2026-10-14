import { formField, initialValues, type FormField, type FormValues, type View } from "@campflare/core"
import { Loader2Icon } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspace, useWorkspaceState } from "@/workspace"
import { BlockActions, MenuSelect } from "./message-blocks"
import { BlockView } from "./message-body"

// A modal an app opened for you (views.open): the top of your stack of views,
// as an accessible dialog. Its inputs are a form; Submit sends what they hold
// (view_submission), and errors (yours, or the app's response_action) show
// under each input. Escape, the close button or Cancel closes it
// (view_closed, if the app asked), showing the view under it, if any.

/** The error code of a failed call. */
const codeOf = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : String(error)

export function ViewDialog() {
  const workspace = useWorkspace()
  const views = useWorkspaceState((s) => s.views)
  const top = views.at(-1)
  return (
    <Dialog
      open={Boolean(top)}
      onOpenChange={(open) => {
        if (!open && top) void workspace.closeView(top.id)
      }}
    >
      {/* A new view, or an update to this one (a new hash), starts from its initial values. */}
      {top && <ViewForm key={`${top.id}/${top.hash ?? ""}`} view={top} />}
    </Dialog>
  )
}

function ViewForm({ view }: { view: View }) {
  const workspace = useWorkspace()
  const [values, setValues] = useState<FormValues>(() => initialValues(view))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState<string>()
  const form = useRef<HTMLFormElement>(null)

  // After a refused submission, the first input to fix has the focus.
  useEffect(() => {
    if (Object.keys(errors).length === 0) return
    form.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus()
  }, [errors])

  const set = (field: FormField, value: string | string[] | undefined) =>
    setValues((all) => {
      const inputs = { ...all[field.blockId] }
      if (value === undefined || value.length === 0) delete inputs[field.actionId]
      else inputs[field.actionId] = value
      return { ...all, [field.blockId]: inputs }
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setFailed(undefined)
    try {
      const answer = await workspace.submitView(view.id, values)
      setErrors(answer.errors ?? {})
    } catch (error) {
      setFailed(codeOf(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <form ref={form} onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{view.title?.text ?? "Untitled"}</DialogTitle>
        </DialogHeader>
        <div className="-mx-4 grid max-h-[60vh] gap-4 overflow-y-auto px-4">
          {view.blocks.map((block, i) => {
            const field = formField(block)
            if (field) {
              return (
                <Field
                  key={field.blockId}
                  field={field}
                  value={values[field.blockId]?.[field.actionId]}
                  error={errors[field.blockId]}
                  onChange={(value) => set(field, value)}
                />
              )
            }
            if (block.type === "actions" || (block.type === "section" && block.accessory)) {
              return (
                <div key={String(block.block_id ?? i)}>
                  {block.type === "section" && <BlockView block={block} />}
                  <BlockActions
                    blocks={[block]}
                    onClick={(c) => workspace.clickInView(view.id, c, values)}
                    inert={submitting}
                  />
                </div>
              )
            }
            return <BlockView key={String(block.block_id ?? i)} block={block} />
          })}
        </div>
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            The app didn't take that ({failed}).
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>{view.close?.text ?? "Cancel"}</DialogClose>
          {view.submit && (
            <Button type="submit" disabled={submitting} aria-busy={submitting || undefined}>
              {submitting && <Loader2Icon aria-hidden className="animate-spin" />}
              {view.submit.text}
            </Button>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

/** One input, labelled, with its hint and its error. */
function Field({
  field,
  value,
  error,
  onChange,
}: {
  field: FormField
  value: string | string[] | undefined
  error?: string
  onChange: (value: string | string[] | undefined) => void
}) {
  const id = useId()
  const hintId = field.hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined
  const one = typeof value === "string" ? value : undefined
  const many = Array.isArray(value) ? value : one ? [one] : []
  const label = (
    <>
      {field.label}
      {field.optional && <span className="font-normal text-muted-foreground"> (optional)</span>}
    </>
  )
  const invalid = Boolean(error)
  const aria = {
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    "aria-required": !field.optional || undefined,
  }
  const after = (
    <>
      {field.hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {field.hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )

  // Several choices: a group, its legend the label.
  if (field.kind === "checkboxes" || field.kind === "radio") {
    return (
      <fieldset
        className="grid gap-1.5"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-required={!field.optional || undefined}
      >
        <legend className="mb-1 text-sm font-medium">{label}</legend>
        {field.options.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm">
            <input
              type={field.kind === "radio" ? "radio" : "checkbox"}
              name={`${id}-choice`}
              className="mt-0.5 size-4 accent-primary"
              value={o.value}
              checked={many.includes(o.value)}
              aria-invalid={invalid || undefined}
              onChange={(e) =>
                onChange(
                  field.kind === "radio"
                    ? o.value
                    : e.target.checked
                      ? [...many, o.value]
                      : many.filter((v) => v !== o.value),
                )
              }
            />
            <span>
              {o.label}
              {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
            </span>
          </label>
        ))}
        {after}
      </fieldset>
    )
  }

  let control
  switch (field.kind) {
    case "text": {
      const common = {
        id,
        ...aria,
        placeholder: field.placeholder,
        minLength: field.minLength,
        maxLength: field.maxLength,
        value: one ?? "",
      }
      control = field.multiline ? (
        <Textarea {...common} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input
          {...common}
          type={field.inputType}
          inputMode={field.inputType === "number" ? "decimal" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    }
    case "select":
      control = (
        <MenuSelect
          id={id}
          menu={field}
          value={one}
          invalid={invalid}
          describedBy={describedBy}
          onChange={(v) => onChange(v)}
        />
      )
      break
    case "date":
      control = <Input id={id} type="date" {...aria} value={one ?? ""} onChange={(e) => onChange(e.target.value)} />
      break
    default:
      control = (
        <p id={id} className="text-sm text-muted-foreground">
          This input ({field.type}) can't be filled in here yet.
        </p>
      )
  }
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {control}
      {after}
    </div>
  )
}
