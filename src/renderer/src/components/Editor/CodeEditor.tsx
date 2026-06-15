import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { EditorState, Compartment, Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, StreamLanguage } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'

interface CodeEditorProps {
  value: string
  filename: string
  onChange: (value: string) => void
  onSave?: () => void
  readOnly?: boolean
}

export default function CodeEditor({ value, filename, onChange, onSave, readOnly }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  // Callbacks live in refs so the keymap and update listener never go stale
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => { onSaveRef.current?.(); return true },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        langCompartment.current.of(languageFor(filename)),
        readOnlyCompartment.current.of(EditorState.readOnly.of(!!readOnly)),
        noxTheme,
        syntaxHighlighting(noxHighlightStyle),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // The view is created once per file; switching files remounts via the key prop or filename effect below
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: langCompartment.current.reconfigure(languageFor(filename)) })
  }, [filename])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(!!readOnly)) })
  }, [readOnly])

  // Sync external value changes (e.g. a different file loaded into the same mounted editor)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}

function languageFor(filename: string): Extension {
  const base = filename.split('/').pop() ?? ''
  const lower = base.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return StreamLanguage.define(dockerFile)
  if (lower === 'makefile') return StreamLanguage.define(shell)
  if (lower.startsWith('nginx') && lower.endsWith('.conf')) return StreamLanguage.define(nginx)

  const lastDot = lower.lastIndexOf('.')
  const ext = lastDot >= 0 ? lower.slice(lastDot + 1) : ''
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'ts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'json': return json()
    case 'yml': case 'yaml': return yaml()
    case 'py': return python()
    case 'md': case 'markdown': return markdown()
    case 'html': case 'htm': return html()
    case 'xml': case 'svg': case 'plist': return xml()
    case 'css': case 'scss': case 'less': case 'sass': return css()
    case 'sql': return sql()
    case 'sh': case 'bash': case 'zsh': case 'fish': return StreamLanguage.define(shell)
    case 'toml': return StreamLanguage.define(toml)
    case 'ini': case 'cfg': case 'conf': case 'env': case 'properties': return StreamLanguage.define(properties)
    default: return []
  }
}

const noxTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'transparent',
    color: 'var(--nox-text)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--nox-active-t)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--nox-active-t)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--nox-text-3)',
    border: 'none',
    borderRight: '1px solid var(--nox-border)',
    fontSize: '10px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '32px' },
  '.cm-activeLine': { backgroundColor: 'var(--nox-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--nox-text)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--nox-active)',
  },
  '.cm-selectionMatch': { backgroundColor: 'rgba(245,158,11,0.18)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(245,158,11,0.25)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(245,158,11,0.45)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--nox-active)',
    outline: '1px solid var(--nox-active-t)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--nox-shell)',
    color: 'var(--nox-text)',
    borderTop: '1px solid var(--nox-border)',
    fontSize: '11px',
  },
  '.cm-panels input, .cm-panels button, .cm-panels label': {
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: '11px',
    color: 'var(--nox-text)',
  },
  '.cm-panels input': {
    background: 'var(--nox-bg)',
    border: '1px solid var(--nox-border)',
    borderRadius: '4px',
  },
  '.cm-panels button': {
    background: 'var(--nox-bg)',
    border: '1px solid var(--nox-border)',
    borderRadius: '4px',
    backgroundImage: 'none',
  },
  '.cm-tooltip': {
    background: 'var(--nox-shell)',
    border: '1px solid var(--nox-border)',
    color: 'var(--nox-text)',
  },
})

const noxHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: 'var(--nox-syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--nox-syn-string)' },
  { tag: [tags.number, tags.float, tags.integer], color: 'var(--nox-syn-number)' },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], color: 'var(--nox-syn-comment)', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.variableName)], color: 'var(--nox-syn-property)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--nox-syn-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--nox-syn-type)' },
  { tag: [tags.bool, tags.null, tags.atom, tags.constant(tags.variableName), tags.self], color: 'var(--nox-syn-constant)' },
  { tag: [tags.heading], color: 'var(--nox-syn-property)', fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: 'var(--nox-syn-type)', textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--nox-syn-comment)' },
  { tag: tags.invalid, color: '#EF4444' },
])
