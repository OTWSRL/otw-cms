'use client'

import { isSafeHref, type Block } from '@otwdesign/sdk'
import {
  EditorContent,
  Node,
  useEditor,
  useEditorState,
  type Editor,
  type JSONContent,
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MediaPicker, type PickedMedia } from '../media-picker'

export interface BlockEditorProps {
  /** The form's hidden input that carries the body, as JSON. */
  inputId: string
  initial: Block[]
  /** Where the browser keeps unsaved changes: one key per entry, and one for Add New. */
  backupKey: string
  /** The Add New screen's key, cleared once its entry has been saved. */
  firstSaveKey: string
  label: string
  /** The saved entry, which images uploaded from the editor are attached to. */
  entryId?: string
}

/** What's backed up: the fields an author writes in, as WordPress's `wp.autosave.local` keeps. */
interface Backup {
  title: string
  excerpt: string
  body: string
}

const BACKUP_PREFIX = 'otw-entry-backup:'

/**
 * An image from the media library, as WordPress's image block: the file's id, which the site
 * finds its sizes by, its address, its alternative text and its size. Only images with a library
 * id are kept from pasted HTML; the server checks the rest.
 */
const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null },
      src: { default: null },
      alt: { default: '' },
      width: { default: null },
      height: { default: null },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'img[data-media-id]',
        getAttrs: (element) => {
          const side = (name: string) => Number(element.getAttribute(name)) || null
          return {
            id: element.getAttribute('data-media-id'),
            src: element.getAttribute('src'),
            alt: element.getAttribute('alt') ?? '',
            width: side('width'),
            height: side('height'),
          }
        },
      },
    ]
  },
  renderHTML({ node }) {
    const { id, src, alt, width, height } = node.attrs as Record<string, string | number | null>
    return ['img', { 'data-media-id': id, src, alt, width, height, class: 'block-editor-image' }]
  },
})

/** The image as the editor inserts it: its large size, as WordPress inserts one. */
function imageAttrs(item: PickedMedia) {
  const large = item.sizes.large
  return {
    id: item.id,
    src: large?.url ?? item.url,
    alt: item.alt,
    width: large?.width ?? item.width,
    height: large?.height ?? item.height,
  }
}
const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

/** The doc's blocks; a lone empty paragraph is an empty body. */
function bodyOf(doc: JSONContent): Block[] {
  const content = (doc.content ?? []) as Block[]
  const only = content[0]
  return content.length === 1 && only?.type === 'paragraph' && !only.content ? [] : content
}

function docOf(body: readonly Block[]): JSONContent {
  return body.length > 0 ? { type: 'doc', content: body as JSONContent[] } : EMPTY_DOC
}

// Storage can be off (private windows, blocked site data); the editor works without it.
function readBackup(key: string): Backup | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(BACKUP_PREFIX + key) ?? 'null') as unknown
    const backup = value as Partial<Backup> | null
    return backup &&
      typeof backup.title === 'string' &&
      typeof backup.excerpt === 'string' &&
      typeof backup.body === 'string'
      ? (backup as Backup)
      : null
  } catch {
    return null
  }
}

function writeBackup(key: string, backup: Backup): void {
  try {
    sessionStorage.setItem(BACKUP_PREFIX + key, JSON.stringify(backup))
  } catch {
    // Full or blocked: the save itself still works.
  }
}

function removeBackup(key: string): void {
  try {
    sessionStorage.removeItem(BACKUP_PREFIX + key)
  } catch {
    // Nothing to clean up.
  }
}

const sameBackup = (a: Backup, b: Backup) =>
  a.title === b.title && a.excerpt === b.excerpt && a.body === b.body

function field(form: HTMLFormElement | null, name: string): HTMLInputElement | null {
  const element = form?.elements.namedItem(name)
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? (element as HTMLInputElement)
    : null
}

/**
 * The edit screen's body editor, on Tiptap (ProseMirror). It writes the body's JSON into the
 * form's hidden input on every change, and keeps the title, excerpt and body in the browser until
 * the entry is saved, so a refused save, a stale form or a closed tab loses nothing: the next
 * visit offers the backup, as WordPress does.
 */
export function BlockEditor({
  inputId,
  initial,
  backupKey,
  firstSaveKey,
  label,
  entryId,
}: BlockEditorProps) {
  const [offer, setOffer] = useState<Backup | null>(null)
  const dirty = useRef(false)

  const input = () => document.getElementById(inputId) as HTMLInputElement | null
  const snapshot = (editor: Editor): Backup => {
    const form = input()?.form ?? null
    return {
      title: field(form, 'title')?.value ?? '',
      excerpt: field(form, 'excerpt')?.value ?? '',
      body: JSON.stringify(bodyOf(editor.getJSON())),
    }
  }
  const changed = (editor: Editor) => {
    const backup = snapshot(editor)
    const target = input()
    if (target) target.value = backup.body
    dirty.current = true
    writeBackup(backupKey, backup)
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        underline: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          isAllowedUri: (url) => isSafeHref(url),
          HTMLAttributes: { target: null, rel: null },
        },
      }),
      ImageBlock,
    ],
    content: docOf(initial),
    editorProps: {
      attributes: {
        class: 'block-editor-content',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
      },
    },
    onCreate: ({ editor }) => offerBackup(editor),
    onUpdate: ({ editor }) => changed(editor),
  })

  /** Offers a backup that differs from what the server sent, and drops one that matches it. */
  function offerBackup(editor: Editor) {
    const current = snapshot(editor)
    const backup = readBackup(backupKey)
    if (backup && !sameBackup(backup, current)) setOffer(backup)
    else removeBackup(backupKey)
    const firstSave = firstSaveKey === backupKey ? null : readBackup(firstSaveKey)
    if (firstSave && sameBackup(firstSave, current)) removeBackup(firstSaveKey)
  }

  // Typing in the form's other fields counts as a change; leaving with changes asks first.
  useEffect(() => {
    if (!editor) return
    const form = input()?.form
    const typed = () => changed(editor)
    const submitted = () => {
      dirty.current = false
    }
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault()
    }
    form?.addEventListener('input', typed)
    form?.addEventListener('submit', submitted)
    window.addEventListener('beforeunload', leaving)
    return () => {
      form?.removeEventListener('input', typed)
      form?.removeEventListener('submit', submitted)
      window.removeEventListener('beforeunload', leaving)
    }
    // The editor is created once; the keys don't change on a screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  const restore = () => {
    if (!editor || !offer) return
    const form = input()?.form ?? null
    const title = field(form, 'title')
    const excerpt = field(form, 'excerpt')
    if (title) title.value = offer.title
    if (excerpt) excerpt.value = offer.excerpt
    editor.commands.setContent(docOf(JSON.parse(offer.body) as Block[]))
    changed(editor)
    setOffer(null)
  }
  const dismiss = () => {
    removeBackup(backupKey)
    setOffer(null)
  }

  return (
    <div className="block-editor">
      {offer && (
        <div className="notice notice-warning inline" role="status">
          <p>
            This browser kept changes that weren&rsquo;t saved.{' '}
            <button type="button" className="button-link" onClick={restore}>
              Restore them
            </button>{' '}
            or{' '}
            <button type="button" className="button-link" onClick={dismiss}>
              discard them
            </button>
            .
          </p>
        </div>
      )}
      {editor && <Toolbar editor={editor} entryId={entryId} />}
      <EditorContent editor={editor} />
    </div>
  )
}

const BLOCK_TYPES = [
  { value: 'paragraph', label: 'Paragraph' },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ value: `h${level}`, label: `Heading ${level}` })),
  { value: 'code', label: 'Code' },
] as const

function Toolbar({ editor, entryId }: { editor: Editor; entryId?: string }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const level = [1, 2, 3, 4, 5, 6].find((n) => current.isActive('heading', { level: n }))
      return {
        block: level ? `h${level}` : current.isActive('codeBlock') ? 'code' : 'paragraph',
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        strike: current.isActive('strike'),
        code: current.isActive('code'),
        link: current.isActive('link'),
        bulletList: current.isActive('bulletList'),
        orderedList: current.isActive('orderedList'),
        blockquote: current.isActive('blockquote'),
        image: current.isActive('image'),
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      }
    },
  })
  const [linking, setLinking] = useState(false)
  const [picking, setPicking] = useState(false)
  const chain = () => editor.chain().focus()

  const setBlock = (value: string) => {
    if (value === 'paragraph') chain().setParagraph().run()
    else if (value === 'code') chain().setCodeBlock().run()
    else
      chain()
        .setHeading({ level: Number(value.slice(1)) as 1 })
        .run()
  }

  return (
    <div className="block-editor-toolbar" role="toolbar" aria-label="Formatting">
      <label className="screen-reader-text" htmlFor={`${editor.instanceId}-block`}>
        Block type
      </label>
      <select
        id={`${editor.instanceId}-block`}
        value={state.block}
        onChange={(event) => setBlock(event.target.value)}
      >
        {BLOCK_TYPES.map((type) => (
          <option key={type.value} value={type.value}>
            {type.label}
          </option>
        ))}
      </select>
      <span className="block-editor-group">
        <Tool label="Bold" pressed={state.bold} onClick={() => chain().toggleBold().run()}>
          <b>B</b>
        </Tool>
        <Tool label="Italic" pressed={state.italic} onClick={() => chain().toggleItalic().run()}>
          <i>I</i>
        </Tool>
        <Tool
          label="Strikethrough"
          pressed={state.strike}
          onClick={() => chain().toggleStrike().run()}
        >
          <s>S</s>
        </Tool>
        <Tool label="Inline code" pressed={state.code} onClick={() => chain().toggleCode().run()}>
          {'</>'}
        </Tool>
        <Tool
          label="Link"
          pressed={state.link || linking}
          onClick={() => setLinking((open) => !open)}
        >
          Link
        </Tool>
      </span>
      <span className="block-editor-group">
        <Tool
          label="Bulleted list"
          pressed={state.bulletList}
          onClick={() => chain().toggleBulletList().run()}
        >
          • List
        </Tool>
        <Tool
          label="Numbered list"
          pressed={state.orderedList}
          onClick={() => chain().toggleOrderedList().run()}
        >
          1. List
        </Tool>
        <Tool
          label="Quote"
          pressed={state.blockquote}
          onClick={() => chain().toggleBlockquote().run()}
        >
          Quote
        </Tool>
        <Tool label="Separator" onClick={() => chain().setHorizontalRule().run()}>
          —
        </Tool>
        <Tool label="Image" onClick={() => setPicking(true)}>
          Image
        </Tool>
      </span>
      <span className="block-editor-group">
        <Tool label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          Undo
        </Tool>
        <Tool label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          Redo
        </Tool>
      </span>
      {linking && <LinkForm editor={editor} close={() => setLinking(false)} />}
      {state.image && <AltForm editor={editor} />}
      {picking && (
        <MediaPicker
          title="Add image"
          action="Insert image"
          entryId={entryId}
          onClose={() => setPicking(false)}
          onSelect={(item) => {
            setPicking(false)
            chain()
              .insertContent({ type: 'image', attrs: imageAttrs(item) })
              .run()
          }}
        />
      )}
    </div>
  )
}

function Tool({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="block-editor-tool"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      // Keep the editor's selection: a click on the toolbar would otherwise take focus first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * The selected image's alternative text, as WordPress's image block has it beside the image.
 * What's typed is the image's at once; Enter stays in the field rather than saving the entry.
 */
function AltForm({ editor }: { editor: Editor }) {
  const alt = (editor.getAttributes('image') as { alt?: string }).alt ?? ''
  const id = `${editor.instanceId}-alt`
  return (
    <div className="block-editor-link">
      <label htmlFor={id}>Alternative text</label>
      <input
        id={id}
        type="text"
        value={alt}
        maxLength={500}
        onChange={(event) =>
          editor.chain().updateAttributes('image', { alt: event.target.value }).run()
        }
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault()
        }}
      />
      <span className="description">
        Describe what the image shows. Leave it empty if it&rsquo;s only decoration.
      </span>
    </div>
  )
}

/** The link's address, checked as the server checks it. Enter applies; Escape closes. */
function LinkForm({ editor, close }: { editor: Editor; close(): void }) {
  const current = (editor.getAttributes('link') as { href?: string }).href ?? ''
  const [href, setHref] = useState(current)
  const [error, setError] = useState('')
  const id = `${editor.instanceId}-link`

  const apply = () => {
    const value = href.trim()
    if (value === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      close()
      return
    }
    if (!isSafeHref(value)) {
      setError('Use a web or email address, or a path on this site.')
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run()
    close()
  }

  return (
    <div className="block-editor-link">
      <label htmlFor={id}>Link to</label>
      <input
        id={id}
        type="text"
        inputMode="url"
        value={href}
        autoFocus
        placeholder="https://"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setHref(event.target.value)
          setError('')
        }}
        onKeyDown={(event) => {
          // Enter would submit the entry's form.
          if (event.key === 'Enter') {
            event.preventDefault()
            apply()
          }
          if (event.key === 'Escape') close()
        }}
      />
      <button type="button" className="button" onClick={apply}>
        Apply
      </button>
      {current && (
        <button
          type="button"
          className="button-link button-link-delete"
          onClick={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run()
            close()
          }}
        >
          Remove link
        </button>
      )}
      {error && (
        <p className="block-editor-link-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
