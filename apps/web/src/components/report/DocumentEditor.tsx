import type { Editor } from '@tiptap/react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Eraser,
  Highlighter,
  ImagePlus,
  Indent,
  Italic,
  List,
  ListTree,
  ListOrdered,
  Loader2,
  FilePenLine,
  Globe2,
  MessageSquarePlus,
  MessagesSquare,
  Outdent,
  Quote,
  RefreshCw,
  Redo2,
  Search,
  SeparatorHorizontal,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DocumentShell } from '@/components/report/DocumentShell'
import { EditableLine } from '@/components/report/EditableLine'
import { artifactsApi } from '@/lib/api'
import { diagramKey } from '@/lib/diagramKey'
import { FRAMES, drawFitting, framed, rasterise, theme } from '@/lib/mermaid'
import { parseCallout, parseCards } from '@/components/report/CardGrid'
import { parse as parsePairs } from '@/components/report/StepList'
import { SectionEditor } from '@/components/report/SectionEditor'
import {
  A4_HEIGHT_PX,
  A4_WIDTH_PX,
  usePagination,
} from '@/components/report/usePagination'
import {
  designTemplatesApi,
  errorMessage,
  type DesignTokens,
  type TemplateStyle,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ReportArtifact, ReportSection, Source } from '@/types'
import { useT } from '@/lib/useT'
import { scopePagedStyles } from '@/components/report/scopePagedStyles'

const FONTS = [
  { label: '문서 기본', value: '' },
  { label: '바탕', value: "'Nanum Myeongjo', 'Batang', serif" },
  { label: '맑은 고딕', value: "'Pretendard', 'Malgun Gothic', sans-serif" },
  { label: '돋움', value: "'Nanum Gothic', 'Dotum', sans-serif" },
  { label: '고정폭', value: "'D2Coding', 'Consolas', monospace" },
]
const SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36']
// h3/h4 only: matches StarterKit's levels and the server's allowed tags.
const HEADINGS = [
  { label: '본문', value: 0 },
  { label: '소제목', value: 3 },
  { label: '작은 제목', value: 4 },
] as const
// Multipliers, not pt, so they track font size.
const LINE_HEIGHTS = ['1.3', '1.5', '1.7', '2.0']
const ALIGNMENTS = [
  { value: 'left', icon: AlignLeft, label: '왼쪽 맞춤' },
  { value: 'center', icon: AlignCenter, label: '가운데 맞춤' },
  { value: 'right', icon: AlignRight, label: '오른쪽 맞춤' },
  { value: 'justify', icon: AlignJustify, label: '양쪽 맞춤' },
] as const

function Sep() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-line" />
}

/** Toolbar toggle with pressed state. */
function Tool({
  on,
  label,
  disabled,
  onClick,
  children,
}: {
  on?: boolean
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      // `onMouseDown` with preventDefault keeps the caret in the document.
      onMouseDown={(e) => {
        e.preventDefault()
        if (!disabled) onClick()
      }}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        on ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-elevated hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

/** Re-renders on every selection change and transaction; Tiptap 3 does not re-render React by itself. */
function useEditorTick(editor: Editor | null) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!editor) return
    const bump = () => tick((n) => n + 1)
    editor.on('selectionUpdate', bump)
    editor.on('transaction', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('transaction', bump)
    }
  }, [editor])
}

function Toolbar({ editor, sources, onFind, onComment, bare }: { editor: Editor | null; sources: Source[]; onFind: () => void; onComment: () => void; bare?: boolean }) {
  const t = useT()
  useEditorTick(editor)
  const off = !editor
  const face = (editor?.getAttributes('textStyle').fontFamily as string) ?? ''
  const size = String(
    (editor?.getAttributes('textStyle').fontSize as string) ?? '',
  ).replace(/pt$/, '')

  const run = (fn: () => void) => () => fn()

  const insertImage = () => {
    if (!editor) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      // Embedded as a data URI so the exported file carries it.
      const reader = new FileReader()
      reader.onload = () => editor.chain().focus().setImage({ src: String(reader.result) }).run()
      reader.readAsDataURL(file)
    }
    input.click()
  }

  const field =
    'h-8 rounded-control border border-line bg-panel px-2 text-sm text-fg ' +
    'disabled:opacity-40 focus:outline-2 focus:outline-offset-1 focus:outline-accent'

  return (
    <div className={cn(
      'flex flex-nowrap items-center gap-0.5 overflow-x-auto',
      // Inside the ribbon the ribbon draws the chrome.
      bare ? 'px-0 py-0' : 'border-b border-line bg-panel px-3 py-1.5 max-sm:px-1.5',
    )}>
      <select
        aria-label={t('서체')}
        title={t('서체')}
        disabled={off}
        value={face}
        className={cn(field, 'w-32')}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) =>
          e.target.value
            ? editor?.chain().focus().setFontFamily(e.target.value).run()
            : editor?.chain().focus().unsetFontFamily().run()
        }
      >
        {FONTS.map((f) => (
          <option key={f.label} value={f.value}>
            {t(f.label)}
          </option>
        ))}
      </select>
      <select
        aria-label={t('글자 크기')}
        title={t('글자 크기')}
        disabled={off}
        value={size}
        className={cn(field, 'w-16')}
        onChange={(e) =>
          e.target.value
            ? editor?.chain().focus().setFontSize(`${e.target.value}pt`).run()
            : editor?.chain().focus().unsetFontSize().run()
        }
      >
        <option value="">{t('기본')}</option>
        {SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <select
        aria-label={t('제목 단계')}
        title={t('제목 단계')}
        disabled={off}
        value={HEADINGS.find((h) => h.value && editor?.isActive('heading', { level: h.value }))?.value ?? 0}
        className={cn(field, 'w-24')}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const level = Number(e.target.value)
          if (!level) editor?.chain().focus().setParagraph().run()
          else editor?.chain().focus().setHeading({ level: level as 3 | 4 }).run()
        }}
      >
        {HEADINGS.map((h) => (
          <option key={h.value} value={h.value}>
            {t(h.label)}
          </option>
        ))}
      </select>

      <Sep />

      <Tool label={t('찾기 및 바꾸기')} onClick={onFind}>
        <Search size={15} />
      </Tool>
      <Tool label={t('선택한 문장에 메모')} disabled={off || editor?.state.selection.empty} onClick={onComment}>
        <MessageSquarePlus size={15} />
      </Tool>

      <Tool
        label={t('굵게')}
        disabled={off}
        on={editor?.isActive('bold')}
        onClick={run(() => editor?.chain().focus().toggleBold().run())}
      >
        <Bold size={15} />
      </Tool>
      <Tool
        label={t('기울임')}
        disabled={off}
        on={editor?.isActive('italic')}
        onClick={run(() => editor?.chain().focus().toggleItalic().run())}
      >
        <Italic size={15} />
      </Tool>
      <Tool
        label={t('밑줄')}
        disabled={off}
        on={editor?.isActive('underline')}
        onClick={run(() => editor?.chain().focus().toggleUnderline().run())}
      >
        <Underline size={15} />
      </Tool>
      <Tool
        label={t('취소선')}
        disabled={off}
        on={editor?.isActive('strike')}
        onClick={run(() => editor?.chain().focus().toggleStrike().run())}
      >
        <Strikethrough size={15} />
      </Tool>

      <Sep />

      {ALIGNMENTS.map((a) => (
        <Tool
          key={a.value}
          label={t(a.label)}
          disabled={off}
          on={editor?.isActive({ textAlign: a.value })}
          onClick={run(() => editor?.chain().focus().setTextAlign(a.value).run())}
        >
          <a.icon size={15} />
        </Tool>
      ))}

      <Sep />

      <label
        title={t('글자색')}
        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-muted transition-colors hover:bg-elevated hover:text-fg"
      >
        <Baseline size={15} />
        <span
          className="pointer-events-none absolute mt-4 h-1 w-4 rounded-full"
          style={{ background: (editor?.getAttributes('textStyle').color as string) || 'transparent' }}
        />
        <input
          type="color"
          aria-label={t('글자색')}
          disabled={off}
          className="sr-only"
          value={(editor?.getAttributes('textStyle').color as string) || '#1a1a1a'}
          onInput={(e) => editor?.chain().focus().setColor(e.currentTarget.value).run()}
        />
      </label>
      <select
        aria-label={t('글자색 빠른 선택')}
        title={t('글자색 빠른 선택')}
        disabled={off}
        defaultValue=""
        className={cn(field, 'w-20 px-1 text-xs')}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (e.target.value) editor?.chain().focus().setColor(e.target.value).run()
          e.currentTarget.value = ''
        }}
      >
        <option value="">{t('글자색')}</option>
        <option value="#cc0000">{t('빨강')}</option>
        <option value="#1d4ed8">{t('파랑')}</option>
        <option value="#15803d">{t('초록')}</option>
        <option value="#666666">{t('회색')}</option>
      </select>
      <label
        title={t('형광펜')}
        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-muted transition-colors hover:bg-elevated hover:text-fg"
      >
        <Highlighter size={15} />
        <input
          type="color"
          aria-label={t('형광펜')}
          disabled={off}
          className="sr-only"
          value={(editor?.getAttributes('textStyle').backgroundColor as string) || '#fff3a3'}
          onInput={(e) => editor?.chain().focus().setBackgroundColor(e.currentTarget.value).run()}
        />
      </label>
      <Tool
        label={t('색 지우기')}
        disabled={off}
        onClick={run(() =>
          editor?.chain().focus().unsetColor().unsetBackgroundColor().run(),
        )}
      >
        <Eraser size={15} />
      </Tool>
      <select
        aria-label={t('줄간격')}
        title={t('줄간격')}
        disabled={off}
        value={String((editor?.getAttributes('paragraph').lineHeight as string) ?? '')}
        className={cn(field, 'w-20')}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) =>
          e.target.value
            ? editor?.chain().focus().setLineHeight(e.target.value).run()
            : editor?.chain().focus().unsetLineHeight().run()
        }
      >
        <option value="">{t('줄간격')}</option>
        {LINE_HEIGHTS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <Sep />

      <Tool
        label={t('글머리 기호')}
        disabled={off}
        on={editor?.isActive('bulletList')}
        onClick={run(() => editor?.chain().focus().toggleBulletList().run())}
      >
        <List size={15} />
      </Tool>
      <Tool
        label={t('번호 매기기')}
        disabled={off}
        on={editor?.isActive('orderedList')}
        onClick={run(() => editor?.chain().focus().toggleOrderedList().run())}
      >
        <ListOrdered size={15} />
      </Tool>
      {/* Indent is list nesting, which survives save and export. */}
      <Tool
        label={t('한 단계 들여쓰기')}
        disabled={off || !editor?.can().sinkListItem('listItem')}
        onClick={run(() => editor?.chain().focus().sinkListItem('listItem').run())}
      >
        <Indent size={15} />
      </Tool>
      <Tool
        label={t('한 단계 내어쓰기')}
        disabled={off || !editor?.can().liftListItem('listItem')}
        onClick={run(() => editor?.chain().focus().liftListItem('listItem').run())}
      >
        <Outdent size={15} />
      </Tool>
      <Tool
        label={t('인용')}
        disabled={off}
        on={editor?.isActive('blockquote')}
        onClick={run(() => editor?.chain().focus().toggleBlockquote().run())}
      >
        <Quote size={15} />
      </Tool>

      <Sep />

      <Tool
        label={t('표 넣기')}
        disabled={off}
        onClick={run(() =>
          editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        )}
      >
        <TableIcon size={15} />
      </Tool>
      {/* Table commands appear only with the caret inside a table. */}
      {editor?.isActive('table') && (
        <>
          <Tool
            label={t('아래에 행 추가')}
            onClick={run(() => editor.chain().focus().addRowAfter().run())}
          >
            <span className="text-[10px] font-semibold">{t('행+')}</span>
          </Tool>
          <Tool
            label={t('현재 행 삭제')}
            onClick={run(() => editor.chain().focus().deleteRow().run())}
          >
            <span className="text-[10px] font-semibold">{t('행−')}</span>
          </Tool>
          <Tool
            label={t('오른쪽에 열 추가')}
            onClick={run(() => editor.chain().focus().addColumnAfter().run())}
          >
            <span className="text-[10px] font-semibold">{t('열+')}</span>
          </Tool>
          <Tool
            label={t('현재 열 삭제')}
            onClick={run(() => editor.chain().focus().deleteColumn().run())}
          >
            <span className="text-[10px] font-semibold">{t('열−')}</span>
          </Tool>
          <Tool
            label={t('선택한 셀 병합')}
            disabled={!editor.can().mergeCells()}
            onClick={run(() => editor.chain().focus().mergeCells().run())}
          >
            <span className="text-[10px] font-semibold">병합</span>
          </Tool>
          <Tool
            label={t('셀 나누기')}
            disabled={!editor.can().splitCell()}
            onClick={run(() => editor.chain().focus().splitCell().run())}
          >
            <span className="text-[10px] font-semibold">분할</span>
          </Tool>
          <Tool
            label={t('첫 행을 머리글로 전환')}
            on={editor.isActive('tableHeader')}
            onClick={run(() => editor.chain().focus().toggleHeaderRow().run())}
          >
            <span className="text-[10px] font-semibold">머리</span>
          </Tool>
          <Tool
            label={t('표 지우기')}
            onClick={run(() => editor.chain().focus().deleteTable().run())}
          >
            <Trash2 size={15} />
          </Tool>
        </>
      )}
      <Tool label={t('그림')} disabled={off} onClick={insertImage}>
        <ImagePlus size={15} />
      </Tool>
      <Tool
        label={t('쪽 나누기')}
        disabled={off}
        onClick={run(() => editor?.chain().focus().insertContent({ type: 'pageBreak' }).run())}
      >
        <SeparatorHorizontal size={15} />
      </Tool>

      {sources.length > 0 && (
        <select
          aria-label={t('출처 인용 넣기')}
          title={t('현재 커서에 출처 번호 넣기')}
          disabled={off}
          defaultValue=""
          className={cn(field, 'max-w-40')}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const ordinal = Number(e.target.value)
            if (ordinal && editor) editor.chain().focus().insertContent(`[${ordinal}]`).run()
            e.currentTarget.value = ''
          }}
        >
          <option value="">{t('출처 인용')}</option>
          {sources.map((source) => (
            <option key={source.id} value={source.ordinal}>
              [{source.ordinal}] {source.title}
            </option>
          ))}
        </select>
      )}

      <Sep />

      <Tool
        label={t('실행 취소')}
        disabled={off || !editor?.can().undo()}
        onClick={run(() => editor?.chain().focus().undo().run())}
      >
        <Undo2 size={15} />
      </Tool>
      <Tool
        label={t('다시 실행')}
        disabled={off || !editor?.can().redo()}
        onClick={run(() => editor?.chain().focus().redo().run())}
      >
        <Redo2 size={15} />
      </Tool>

      {off && (
        <span className="ml-2 text-xs text-faint">{t('문단을 눌러 편집을 시작하세요')}</span>
      )}
    </div>
  )
}

/** Dashed estimated page-break guides over the continuous sheet. */
function PageGuides({ breaks }: { breaks: number[] }) {
  const t = useT()
  if (!breaks.length) return null
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {breaks.map((top, i) => (
        <div
          key={i}
          data-page-break={i + 2}
          className="absolute inset-x-0 border-t border-dashed border-line/80"
          style={{ top }}
        >
          <span className="absolute -top-4 right-3 rounded bg-panel/90 px-1.5 text-[10px] text-faint">
            {t('{n}쪽 즈음').replace('{n}', String(i + 2))}
          </span>
        </div>
      ))}
    </div>
  )
}

const escapePagedText = (text: string) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const escapeCssContent = (text: string) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')

type PageSettings = NonNullable<ReportArtifact['pageSettings']>
const DEFAULT_PAGE_SETTINGS: Required<PageSettings> = {
  header: '', footer: 'KloudChat', pageNumbers: 'page-total', firstPageHeader: false,
  margins: { top: 18, right: 16, bottom: 20, left: 16 },
}

/** Class on the element every paginated page is inside; the scope for Paged.js rules. Shared with `index.css`. */
const PAGED_SCOPE = 'paged-report-preview'

/**
 * The editor's continuous sheet laid out like the printed page: A4 wide with the page margins
 * as padding, the cover at its print size, sections spaced as in print. Line breaks, type
 * and the position of the body then match the page view; only the sheet being one long
 * page differs. The seed's `body` typography is repeated on the sheet, since a shadow root
 * has no body. `.page.paginated` outranks the seed's own `.paginated` rules.
 */
function sheetGeometryCss(margins: Required<PageSettings>['margins']): string {
  return `
  .page.paginated { box-sizing: border-box; width: ${A4_WIDTH_PX}px; max-width: ${A4_WIDTH_PX}px; margin: 0 auto; padding: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm; min-height: ${A4_HEIGHT_PX}px; }
  .page.paginated { color: var(--ink); font-family: var(--font-body); font-size: var(--doc-body); line-height: var(--doc-leading-body); }
  .page.paginated .cover { min-height: 232mm; padding: 74mm 0 0; margin: 0; }
  .page.paginated section { margin: 0 0 12mm; }
  /* The editor keeps a paragraph inside every cell; the finished file has bare text there. */
  .page.paginated td > p, .page.paginated th > p { margin: 0; }
`
}

// Installed into the DocumentShell shadow root, where global CSS cannot reach.
const EDITOR_PAGE_BREAK_CSS = `
  .ProseMirror .page-break { position: relative; display: block; height: 24px; margin: 14px 0; border-top: 1px dashed #9ca3af; cursor: pointer; }
  .ProseMirror .page-break::after { content: '쪽 나누기'; position: absolute; top: -9px; right: 8px; padding: 0 6px; background: white; color: #777; font-size: 11px; line-height: 18px; }
  .ProseMirror .page-break.ProseMirror-selectednode { border-color: var(--accent, #5b5bd6); }
`

function PagedDocument({ html, css, settings, onSettings, settingsOpen, onEdit, onWebView }: { html: string; css: string; settings: Required<PageSettings>; onSettings: (next: Required<PageSettings>) => void; settingsOpen: boolean; onEdit: () => void; onWebView: () => void }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(true)
  const [pages, setPages] = useState(0)
  const [pageSize, setPageSize] = useState({ width: A4_WIDTH_PX, height: A4_HEIGHT_PX })
  const [pageScale, setPageScale] = useState(1)
  // 'fit' follows the viewport width; a number is a zoom the reader chose.
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const target = host.current
    if (!target) return
    let live = true
    setBusy(true)
    setFailure(null)
    target.replaceChildren()
    // Paged.js lays out at A4 width; the viewport scales the finished stack.
    target.style.width = `${A4_WIDTH_PX}px`
    const sheet = URL.createObjectURL(new Blob([`
      html, body { margin: 0; padding: 0; background: white; }
      h1 { string-set: document-title content(text); }
      ${css}
      /* After the template's css: its own @page (20mm 18mm) would otherwise outrank these
         margins, and the page settings would have no effect. */
      @page {
        size: A4;
        margin: ${settings.margins.top}mm ${settings.margins.right}mm ${settings.margins.bottom}mm ${settings.margins.left}mm;
        @top-left { content: ${settings.header ? `"${escapeCssContent(settings.header)}"` : 'string(document-title)'}; color: #777; font-size: 8pt; }
        @bottom-left { content: "${escapeCssContent(settings.footer)}"; color: #777; font-size: 8pt; }
        @bottom-right { content: ${settings.pageNumbers === 'none' ? 'none' : settings.pageNumbers === 'page' ? 'counter(page)' : 'counter(page) " / " counter(pages)'}; color: #777; font-size: 8pt; }
      }
      @page:first { @top-left { content: ${settings.firstPageHeader ? (settings.header ? `"${escapeCssContent(settings.header)}"` : 'string(document-title)') : 'none'}; } }
      /* The sheet's screen box (viewport-high, padded) must not reach Paged.js, or the cover
         inside it is pushed to page two and page one comes out blank. The cover keeps the
         seed's print size (232mm); what puts the first section on page two is a break
         *before* it — Paged.js honours break-before, as the manual page breaks below show,
         but not the cover's break-after. */
      .page { min-height: 0 !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }
      /* The seed repeats the document name on every printed sheet as a fixed element; Paged.js
         pulls fixed elements into the flow of each page and the running header above already
         carries the name, so the copy would only push the text down page by page. */
      .doc-foot { display: none !important; }
      .cover { margin: 0 !important; }
      .cover + * { break-before: page; }
      section { break-inside: auto; }
      h1, h2, h3, h4 { break-after: avoid; }
      p, li { orphans: 2; widows: 2; }
      table, tbody { break-inside: auto !important; page-break-inside: auto !important; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; page-break-inside: avoid; }
      figure, img, pre, blockquote { break-inside: avoid; }
      [data-page-break="true"] { break-before: page; height: 0; }
    `], { type: 'text/css' }))
    // Armed before Paged.js runs, which appends the template stylesheet to `document.head`.
    const unscope = scopePagedStyles(`.${PAGED_SCOPE}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutMs = (window as Window & { __KLOUDCHAT_PAGINATION_TIMEOUT_MS__?: number })
      .__KLOUDCHAT_PAGINATION_TIMEOUT_MS__ ?? 30_000
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pagination timed out')), timeoutMs)
    })
    const forceFailure = Boolean(
      (window as Window & { __KLOUDCHAT_FORCE_PAGINATION_FAILURE__?: boolean })
        .__KLOUDCHAT_FORCE_PAGINATION_FAILURE__,
    )
    void import('pagedjs')
      .then(({ Previewer }) => forceFailure
        ? Promise.reject(new Error('forced pagination failure'))
        : Promise.race([new Previewer().preview(html, [sheet], target), timedOut]))
      .then((flow) => {
        if (!live) return
        setPages(flow.total)
        setPageSize({
          width: Math.max(A4_WIDTH_PX, target.scrollWidth),
          height: Math.max(A4_HEIGHT_PX, target.scrollHeight),
        })
        setBusy(false)
      })
      .catch(() => {
        if (!live) return
        setFailure(t('페이지를 나누지 못했습니다. 편집 화면에서 내용을 확인해 주세요.'))
        setBusy(false)
      })
      .finally(() => {
        if (timer) clearTimeout(timer)
        URL.revokeObjectURL(sheet)
      })
    return () => { live = false; if (timer) clearTimeout(timer); URL.revokeObjectURL(sheet); unscope(); target.replaceChildren() }
  // `t` is a new function per render; depending on it would loop.
  }, [html, css, settings, attempt])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const fit = () => {
      if (zoom !== 'fit') {
        setPageScale(zoom)
        return
      }
      const gutter = node.clientWidth < 640 ? 16 : 48
      const room = Math.max(1, node.clientWidth - gutter)
      setPageScale(Math.min(1, room / pageSize.width))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    return () => observer.disconnect()
  }, [pageSize.width, zoom])

  const step = (direction: 1 | -1) =>
    setZoom(Math.min(2, Math.max(0.5, Math.round((pageScale + direction * 0.1) * 10) / 10)))

  return (
    <div ref={viewport} className="relative min-h-0 flex-1 overflow-auto bg-elevated p-6 max-sm:p-2">
      <div className="sticky top-0 z-20 mb-3 flex flex-wrap justify-end gap-2">
        {!busy && !failure && (
          <div className="flex items-center gap-0.5 rounded-control border border-line bg-panel p-0.5 shadow-sm" role="group" aria-label={t('확대/축소')}>
            <button type="button" aria-label={t('축소')} title={t('축소')} disabled={pageScale <= 0.5} onClick={() => step(-1)} className="grid size-8 place-items-center rounded-control text-muted hover:bg-elevated hover:text-fg disabled:opacity-40"><ZoomOut size={15} /></button>
            <button type="button" aria-label={t('폭에 맞춤')} title={t('폭에 맞춤')} onClick={() => setZoom((current) => (current === 'fit' ? 1 : 'fit'))} className={cn('h-8 min-w-14 rounded-control px-2 text-xs tabular-nums hover:bg-elevated', zoom === 'fit' ? 'text-muted' : 'text-fg')}>{Math.round(pageScale * 100)}%</button>
            <button type="button" aria-label={t('확대')} title={t('확대')} disabled={pageScale >= 2} onClick={() => step(1)} className="grid size-8 place-items-center rounded-control text-muted hover:bg-elevated hover:text-fg disabled:opacity-40"><ZoomIn size={15} /></button>
          </div>
        )}
        {settingsOpen && (
          <div className="basis-full rounded-card border border-line bg-panel p-3 shadow-sm" aria-label={t('페이지 설정 도구')}>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-xs text-muted">{t('머리말')}<input aria-label={t('머리말')} value={settings.header} onChange={(event) => onSettings({ ...settings, header: event.target.value })} className="mt-1 h-9 w-full rounded-control border border-line px-2 text-sm" /></label>
              <label className="text-xs text-muted">{t('꼬리말')}<input aria-label={t('꼬리말')} value={settings.footer} onChange={(event) => onSettings({ ...settings, footer: event.target.value })} className="mt-1 h-9 w-full rounded-control border border-line px-2 text-sm" /></label>
              <label className="text-xs text-muted">{t('쪽 번호')}<select aria-label={t('쪽 번호')} value={settings.pageNumbers} onChange={(event) => onSettings({ ...settings, pageNumbers: event.target.value as Required<PageSettings>['pageNumbers'] })} className="mt-1 h-9 w-full rounded-control border border-line px-2 text-sm"><option value="page-total">{t('현재 / 전체')}</option><option value="page">{t('현재 쪽')}</option><option value="none">{t('표시 안 함')}</option></select></label>
              <label className="flex items-end gap-2 pb-2 text-xs text-muted"><input type="checkbox" checked={settings.firstPageHeader} onChange={(event) => onSettings({ ...settings, firstPageHeader: event.target.checked })} />{t('첫 쪽에도 머리말 표시')}</label>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => <label key={side} className="text-xs text-muted">{t({ top: '위 여백', right: '오른쪽 여백', bottom: '아래 여백', left: '왼쪽 여백' }[side])}<input type="number" min={10} max={35} aria-label={t({ top: '위 여백', right: '오른쪽 여백', bottom: '아래 여백', left: '왼쪽 여백' }[side])} value={settings.margins[side]} onChange={(event) => onSettings({ ...settings, margins: { ...settings.margins, [side]: Math.min(35, Math.max(10, Number(event.target.value) || 10)) } })} className="ml-1 h-8 w-16 rounded-control border border-line px-2 text-sm" /> mm</label>)}
            </div>
          </div>
        )}
      </div>
      {busy && <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted"><Loader2 size={16} className="animate-spin" />{t('페이지를 나누는 중…')}</div>}
      {failure && (
        <div role="alert" className="mx-auto max-w-lg rounded-card border border-danger/30 bg-panel p-5 shadow-sm">
          <p className="font-semibold text-danger">{t('페이지뷰를 만들지 못했습니다')}</p>
          <p className="mt-1 text-sm text-muted">{failure} {t('문서 내용은 그대로 보존되어 있습니다.')}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setAttempt((value) => value + 1)} className="inline-flex h-9 items-center gap-1.5 rounded-control bg-accent px-3 text-sm font-medium text-white hover:opacity-90">
              <RefreshCw size={14} />{t('다시 시도')}
            </button>
            <button type="button" onClick={onEdit} className="inline-flex h-9 items-center gap-1.5 rounded-control border border-line px-3 text-sm hover:bg-elevated">
              <FilePenLine size={14} />{t('내용 편집')}
            </button>
            <button type="button" onClick={onWebView} className="inline-flex h-9 items-center gap-1.5 rounded-control border border-line px-3 text-sm hover:bg-elevated">
              <Globe2 size={14} />{t('웹뷰로 보기')}
            </button>
          </div>
        </div>
      )}
      <div
        className="mx-auto"
        style={{ width: pageSize.width * pageScale, height: pageSize.height * pageScale }}
      >
        <div
          ref={host}
          aria-label={t('실제 페이지 미리보기')}
          data-page-count={pages || undefined}
          data-page-scale={pageScale.toFixed(3)}
          className={PAGED_SCOPE}
          style={{
            width: pageSize.width,
            transform: `scale(${pageScale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </div>
  )
}

/** Page-view editor for a report; sections stay the stored unit. */
export function DocumentEditor({
  report,
  templateId,
  tokens,
  editable,
  layoutMode,
  settingsOpen,
  onLayoutMode,
  onWebView,
  onDirty,
  toolbarSlot,
}: {
  report: ReportArtifact
  /** Design template; empty renders the plain document seed. */
  templateId: string
  tokens?: DesignTokens | null
  editable: boolean
  layoutMode: 'pages' | 'edit'
  settingsOpen: boolean
  onLayoutMode?: (mode: 'pages' | 'edit') => void
  onWebView?: () => void
  /** Called with the edited sections on every change; title, page settings and comments when those changed. */
  onDirty?: (
    sections: ReportSection[],
    title?: string,
    pageSettings?: ReportArtifact['pageSettings'],
    reviewComments?: ReportArtifact['reviewComments'],
  ) => void
  /** Ribbon slot the formatting bar is portalled into; rendered in place when absent. */
  toolbarSlot?: HTMLElement | null
}) {
  const t = useT()
  const [style, setStyle] = useState<TemplateStyle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState<Editor | null>(null)
  const [focusedSection, setFocusedSection] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const sectionNodes = useRef<Record<string, HTMLElement | null>>({})
  const sectionEditors = useRef<Record<string, Editor | null>>({})
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [findStatus, setFindStatus] = useState('')
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [comments, setComments] = useState<NonNullable<ReportArtifact['reviewComments']>>(report.reviewComments ?? [])
  const [commentQuote, setCommentQuote] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  // State, not a ref: the page appears a render late, inside the shadow root.
  const [page, setPage] = useState<HTMLDivElement | null>(null)
  // Edited bodies by section id; absent means untouched.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const editsRef = useRef<Record<string, string>>({})
  // Re-measure when the stylesheet lands or the document is edited.
  const { usable, height, breaks } = usePagination(
    page,
    `${style?.css.length ?? 0}:${Object.keys(edits).length}`,
  )
  const viewport = useRef<HTMLDivElement>(null)
  // Zoom to fit the A4 page across the panel, capped at 1.
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const fit = () => {
      const room = node.clientWidth - (node.clientWidth < 640 ? 16 : 48)
      setScale(room > 0 ? Math.min(1, room / A4_WIDTH_PX) : 1)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let live = true
    if (!templateId) {
      setStyle(null)
      return
    }
    designTemplatesApi
      .style(templateId, tokens)
      .then((row) => live && setStyle(row))
      // Stored untranslated; `t` is a new function per render.
      .catch((err) => live && setError(errorMessage(err, '서식을 불러오지 못했습니다.')))
    return () => {
      live = false
    }
  }, [templateId, tokens])

  const pictures = useDiagramPictures(report.sections, report.id, page)
  const bodyOf = useCallback(
    (section: ReportSection) => edits[section.id] ?? htmlOf(section, pictures),
    [edits, pictures],
  )

  // Retyped headings and title; text, not markup, so kept apart from `edits`.
  const [renamed, setRenamed] = useState<Record<string, string>>({})
  const renamedRef = useRef<Record<string, string>>({})
  const [editedTitle, setTitle] = useState<string | null>(null)
  const [pageSettings, setPageSettings] = useState<Required<PageSettings>>({
    ...DEFAULT_PAGE_SETTINGS,
    ...report.pageSettings,
    margins: { ...DEFAULT_PAGE_SETTINGS.margins, ...report.pageSettings?.margins },
    footer: report.pageSettings?.footer ?? tokens?.footer ?? DEFAULT_PAGE_SETTINGS.footer,
  })

  const compose = (
    bodies: Record<string, string>,
    headings: Record<string, string>,
  ): ReportSection[] =>
    report.sections.map((s) => ({
      ...s,
      ...(headings[s.id] === undefined ? {} : { heading: headings[s.id] }),
      ...(bodies[s.id] === undefined
        ? {}
        : { content: bodies[s.id], format: 'html' as const }),
    }))

  const change = (section: ReportSection, html: string) => {
    // Several editors can update in one event (Replace all); the ref accumulates synchronously.
    const next = { ...editsRef.current, [section.id]: html }
    editsRef.current = next
    setEdits(next)
    onDirty?.(compose(next, renamedRef.current))
  }

  const rename = (section: ReportSection, heading: string) => {
    if (!heading || heading === (renamedRef.current[section.id] ?? section.heading)) return
    const next = { ...renamedRef.current, [section.id]: heading }
    renamedRef.current = next
    setRenamed(next)
    onDirty?.(compose(editsRef.current, next))
  }

  const retitle = (next: string) => {
    if (!next || next === (editedTitle ?? report.title)) return
    setTitle(next)
    onDirty?.(compose(edits, renamed), next)
  }

  const occurrences = (editor: Editor, needle: string) => {
    const found: { from: number; to: number }[] = []
    if (!needle) return found
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return
      let start = 0
      while ((start = node.text.indexOf(needle, start)) >= 0) {
        found.push({ from: pos + start, to: pos + start + needle.length })
        start += Math.max(needle.length, 1)
      }
    })
    return found
  }

  const findNext = () => {
    if (!query) return
    const current = focusedSection ? report.sections.findIndex((section) => section.id === focusedSection) : -1
    for (let step = 1; step <= report.sections.length; step += 1) {
      const section = report.sections[(current + step + report.sections.length) % report.sections.length]
      const editor = sectionEditors.current[section.id]
      if (!editor) continue
      const matches = occurrences(editor, query)
      if (!matches.length) continue
      const after = section.id === focusedSection ? editor.state.selection.to : 0
      const match = matches.find((one) => one.from >= after) ?? matches[0]
      editor.chain().focus().setTextSelection(match).run()
      setFocused(editor)
      setFocusedSection(section.id)
      sectionNodes.current[section.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const total = report.sections.reduce((sum, row) => {
        const candidate = sectionEditors.current[row.id]
        return sum + (candidate ? occurrences(candidate, query).length : 0)
      }, 0)
      setFindStatus(t('{n}개 찾음').replace('{n}', String(total)))
      return
    }
    setFindStatus(t('일치하는 내용이 없습니다'))
  }

  const replaceCurrent = () => {
    if (!focused || !query) return findNext()
    const { from, to } = focused.state.selection
    if (focused.state.doc.textBetween(from, to) === query) {
      focused.chain().focus().insertContentAt({ from, to }, replacement).run()
    }
    findNext()
  }

  const replaceAll = () => {
    if (!query) return
    let changed = 0
    for (const section of report.sections) {
      const editor = sectionEditors.current[section.id]
      if (!editor) continue
      const matches = occurrences(editor, query)
      if (!matches.length) continue
      let transaction = editor.state.tr
      for (const match of [...matches].reverse()) {
        transaction = transaction.insertText(replacement, match.from, match.to)
      }
      editor.view.dispatch(transaction)
      changed += matches.length
    }
    setFindStatus(t('{n}개 바꿈').replace('{n}', String(changed)))
  }

  const beginComment = () => {
    if (!focused || !focusedSection) return
    const { from, to } = focused.state.selection
    const quote = focused.state.doc.textBetween(from, to, ' ').trim()
    if (!quote) return
    setCommentQuote(quote)
    setCommentDraft('')
    setCommentsOpen(true)
  }

  const commitComments = (next: NonNullable<ReportArtifact['reviewComments']>) => {
    setComments(next)
    onDirty?.(compose(editsRef.current, renamedRef.current), editedTitle ?? undefined, pageSettings, next)
  }

  const addComment = () => {
    if (!focusedSection || !commentQuote || !commentDraft.trim()) return
    commitComments([...comments, {
      id: crypto.randomUUID(), sectionId: focusedSection, quote: commentQuote,
      body: commentDraft.trim(), status: 'open', createdAt: new Date().toISOString(),
    }])
    setCommentQuote('')
    setCommentDraft('')
  }

  const goToComment = (comment: NonNullable<ReportArtifact['reviewComments']>[number]) => {
    const editor = sectionEditors.current[comment.sectionId]
    if (!editor) return
    let match: { from: number; to: number } | undefined
    editor.state.doc.descendants((node, pos) => {
      if (match || !node.isText || !node.text) return
      const offset = node.text.indexOf(comment.quote)
      if (offset >= 0) match = { from: pos + offset, to: pos + offset + comment.quote.length }
    })
    if (match) editor.chain().focus().setTextSelection(match).run()
    setFocused(editor)
    setFocusedSection(comment.sectionId)
    sectionNodes.current[comment.sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const previewHtml = `<main class="page paginated-preview"><div class="cover"><h1>${escapePagedText(editedTitle ?? report.title)}</h1></div>${report.sections.map((section) => `<section><h2>${escapePagedText(renamed[section.id] ?? section.heading)}</h2>${bodyOf(section)}</section>`).join('')}</main>`
  const visualStyle = tokens?.visualStyle ?? 'editorial'
  const visualCss = visualStyle === 'poster'
    ? `.page .cover{background:linear-gradient(145deg,var(--accent),color-mix(in srgb,var(--accent) 48%,#111827));color:#fff;padding:30mm 22mm}.page .cover h1{color:#fff;font-size:30pt;max-width:15ch}.page section>h2{font-size:18pt;border:0;padding:0 0 4mm;color:var(--accent)}.page section{margin-bottom:14mm}.page blockquote,.page .callout{border-radius:3mm;background:color-mix(in srgb,var(--accent) 8%,#fff)}`
    : visualStyle === 'minimal'
      ? `.page .cover{min-height:92mm;padding-top:30mm;background:color-mix(in srgb,var(--accent) 7%,#fff)}.page .cover h1{font-size:22pt;font-weight:600;max-width:22ch}.page section>h2{font-size:12pt;font-weight:650;letter-spacing:.08em;border:0;color:var(--muted)}.page section{margin-bottom:9mm}`
      : ''
  const pageCss = `${style?.css ?? ''}\n${visualCss}`

  if (error) return <p className="p-4 text-sm text-danger">{t(error)}</p>
  if (templateId && !style) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  }

  const bar = (
    <>
      <div className="min-w-0 flex-1">{editable && <Toolbar editor={focused} sources={report.sources} onFind={() => setFindOpen((value) => !value)} onComment={beginComment} bare={Boolean(toolbarSlot)} />}</div>
      <button type="button" aria-pressed={commentsOpen} aria-label={t('검토 메모')} onClick={() => setCommentsOpen((value) => !value)} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-xs text-muted hover:bg-elevated hover:text-fg max-sm:w-8 max-sm:px-0">
        <MessagesSquare size={14} /><span className="max-sm:hidden">{t('검토')} {comments.filter((comment) => comment.status === 'open').length}</span>
      </button>
      <button type="button" aria-pressed={outlineOpen} aria-label={t('문서 개요')} onClick={() => setOutlineOpen((value) => !value)} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-xs text-muted hover:bg-elevated hover:text-fg max-sm:w-8 max-sm:px-0">
        <ListTree size={14} /><span className="max-sm:hidden">{t('개요')}</span>
      </button>
    </>
  )
  const tools = toolbarSlot
    ? createPortal(<div className="flex items-center">{bar}</div>, toolbarSlot)
    : <div className="flex min-w-0 items-center overflow-x-auto border-b border-line bg-panel pr-2 max-sm:pr-1">{bar}</div>

  if (layoutMode === 'pages') {
    return <PagedDocument html={previewHtml} css={pageCss} settings={pageSettings} settingsOpen={settingsOpen} onEdit={() => onLayoutMode?.('edit')} onWebView={() => onWebView?.()} onSettings={(next) => { setPageSettings(next); onDirty?.(compose(edits, renamed), editedTitle ?? undefined, next) }} />
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden">
      {tools}
      {findOpen && (
        <div role="search" aria-label={t('찾기 및 바꾸기')} className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
          <input autoFocus aria-label={t('찾을 내용')} value={query} onChange={(event) => { setQuery(event.target.value); setFindStatus('') }} onKeyDown={(event) => { if (event.key === 'Enter') findNext() }} placeholder={t('찾을 내용')} className="h-8 w-48 rounded-control border border-line px-2 text-sm" />
          <input aria-label={t('바꿀 내용')} value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t('바꿀 내용')} className="h-8 w-48 rounded-control border border-line px-2 text-sm" />
          <button type="button" onClick={findNext} className="h-8 rounded-control border border-line px-3 text-xs hover:bg-elevated">{t('다음 찾기')}</button>
          <button type="button" onClick={replaceCurrent} className="h-8 rounded-control border border-line px-3 text-xs hover:bg-elevated">{t('바꾸기')}</button>
          <button type="button" onClick={replaceAll} className="h-8 rounded-control border border-line px-3 text-xs hover:bg-elevated">{t('모두 바꾸기')}</button>
          <span role="status" className="text-xs text-muted">{findStatus}</span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {outlineOpen && (
          <nav aria-label={t('문서 개요')} className="w-56 shrink-0 overflow-auto border-r border-line bg-panel p-3 max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-20 max-sm:shadow-overlay">
            <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{t('문서 개요')}</p>
            <button type="button" onClick={() => viewport.current?.scrollTo({ top: 0, behavior: 'smooth' })} className="mb-1 block w-full truncate rounded-control px-2 py-2 text-left text-sm font-medium text-fg hover:bg-elevated">
              {editedTitle ?? report.title}
            </button>
            <ol className="space-y-0.5">
              {report.sections.map((section, index) => (
                <li key={section.id}>
                  <button
                    type="button"
                    aria-current={focusedSection === section.id ? 'location' : undefined}
                    title={renamed[section.id] ?? section.heading}
                    onClick={() => {
                      setFocusedSection(section.id)
                      sectionNodes.current[section.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                    className={cn('flex w-full gap-2 rounded-control px-2 py-1.5 text-left text-xs hover:bg-elevated', focusedSection === section.id ? 'bg-accent-soft text-accent' : 'text-muted')}
                  >
                    <span className="shrink-0 tabular-nums text-faint">{index + 1}</span>
                    <span className="truncate">{renamed[section.id] ?? section.heading}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div ref={viewport} aria-label={t('보고서 편집 페이지')} className="min-h-0 min-w-0 flex-1 overflow-auto bg-elevated p-6 max-sm:p-2">
        {/* The A4 sheet is scaled, never narrowed. The outer box carries the
            scaled size so the scrollbar matches. */}
        <div
          className="mx-auto"
          style={{ width: A4_WIDTH_PX * scale, height: Math.max(height, A4_HEIGHT_PX) * scale }}
        >
          <div
            className="relative bg-white shadow-sm ring-1 ring-black/5"
            style={{
              width: A4_WIDTH_PX,
              minHeight: A4_HEIGHT_PX,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
          <div className="relative">
            <DocumentShell css={`${pageCss}\n${EDITOR_PAGE_BREAK_CSS}\n${sheetGeometryCss(pageSettings.margins)}`} className="report-page-shell">
              {/* `paginated` tells the template the sheet is drawn here; `--sheet-h` is the usable page height. */}
              <div
                ref={setPage}
                className="page paginated"
                style={{ ['--sheet-h' as string]: `${usable}px` } as React.CSSProperties}
              >
                <div className="cover">
                  <EditableLine
                    as="h1"
                    value={editedTitle ?? report.title}
                    editable={editable}
                    onChange={retitle}
                  />
                </div>
                {report.sections.map((section) => (
                  <section key={section.id} ref={(node) => { sectionNodes.current[section.id] = node }}>
                    <EditableLine
                      value={renamed[section.id] ?? section.heading}
                      editable={editable}
                      onChange={(heading) => rename(section, heading)}
                    />
                    <SectionEditor
                      html={bodyOf(section)}
                      editable={editable}
                      onReady={(editor) => {
                        if (editor) {
                          setFocused(editor)
                          setFocusedSection(section.id)
                        } else if (focusedSection === section.id) {
                          setFocused(null)
                        }
                      }}
                      onMount={(editor) => {
                        sectionEditors.current[section.id] = editor
                        // The first editor becomes the toolbar target so it opens live.
                        setFocused((current) => current ?? editor)
                        setFocusedSection((current) => current ?? section.id)
                      }}
                      onChange={(html) => change(section, html)}
                    />
                  </section>
                ))}
              </div>
            </DocumentShell>
          </div>
          <PageGuides breaks={breaks} />
          </div>
        </div>
        {commentsOpen && (
          <aside aria-label={t('검토 메모')} className="w-72 shrink-0 overflow-auto border-l border-line bg-panel p-3 max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:z-20 max-sm:w-[calc(100%-2rem)] max-sm:max-w-72 max-sm:shadow-overlay">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('검토 메모')}</h3>
              <span className="text-xs text-faint">{t('{n}개 미해결').replace('{n}', String(comments.filter((comment) => comment.status === 'open').length))}</span>
            </div>
            {commentQuote && (
              <div className="mb-3 rounded-card border border-accent/30 bg-accent-soft p-2">
                <blockquote className="line-clamp-3 text-xs text-muted">“{commentQuote}”</blockquote>
                <textarea aria-label={t('메모 내용')} autoFocus value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder={t('검토 의견을 입력하세요')} className="mt-2 min-h-20 w-full resize-y rounded-control border border-line bg-panel p-2 text-sm" />
                <div className="mt-2 flex justify-end gap-1">
                  <button type="button" onClick={() => { setCommentQuote(''); setCommentDraft('') }} className="rounded-control px-2 py-1 text-xs text-muted hover:bg-elevated">{t('취소')}</button>
                  <button type="button" disabled={!commentDraft.trim()} onClick={addComment} className="rounded-control bg-accent px-2 py-1 text-xs text-white disabled:opacity-40">{t('메모 추가')}</button>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {comments.map((comment) => (
                <article key={comment.id} className={cn('rounded-card border p-2', comment.status === 'resolved' ? 'border-line bg-elevated/40 opacity-70' : 'border-line bg-panel')}>
                  <button type="button" onClick={() => goToComment(comment)} className="block w-full text-left">
                    <p className="truncate text-xs font-medium text-fg">“{comment.quote}”</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{comment.body}</p>
                  </button>
                  <button type="button" onClick={() => commitComments(comments.map((row) => row.id === comment.id ? { ...row, status: row.status === 'open' ? 'resolved' : 'open' } : row))} className="mt-2 text-xs font-medium text-accent hover:underline">
                    {comment.status === 'open' ? t('해결로 표시') : t('다시 열기')}
                  </button>
                </article>
              ))}
              {!comments.length && !commentQuote && <p className="py-8 text-center text-xs text-faint">{t('선택한 문장에 메모를 남겨 보세요.')}</p>}
            </div>
          </aside>
        )}
      </div>
      </div>
    </div>
  )
}

/** A section's body as HTML; a small Markdown subset (headings, lists, tables, quotes, images, fences). */
function htmlOf(section: ReportSection, pictures: Map<string, string>): string {
  if (section.format === 'html') return section.content
  // Escapes `"` too: the output goes into attribute values (`data-source`).
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const inline = (s: string) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')

  const out: string[] = []
  // Pending list items, table rows and fence lines; flushed when something else turns up.
  let items: string[] = []
  let ordered = false
  let rows: string[][] = []
  let fence: string[] | null = null
  let fenceLang = ''
  const flush = () => {
    if (items.length) {
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`)
      items = []
    }
    if (rows.length) {
      const width = Math.max(...rows.map((r) => r.length))
      const cell = (row: string[], c: number, tag: string) =>
        `<${tag}>${row[c] ?? ''}</${tag}>`
      const [head, ...body] = rows
      const headRow = `<tr>${Array.from({ length: width }, (_, c) => cell(head, c, 'th')).join('')}</tr>`
      const bodyRows = body
        .map(
          (row) =>
            `<tr>${Array.from({ length: width }, (_, c) => cell(row, c, 'td')).join('')}</tr>`,
        )
        .join('')
      out.push(`<table><thead>${headRow}</thead><tbody>${bodyRows}</tbody></table>`)
      rows = []
    }
  }
  for (const raw of (section.content || '').split('\n')) {
    const line = raw.trim()
    const fenceMark = /^```+\s*([A-Za-z0-9_-]*)\s*$/.exec(line)
    if (fence !== null) {
      if (fenceMark) {
        out.push(fenceHtml(fenceLang, fence.join('\n'), escape, pictures))
        fence = null
      } else {
        // Raw line: indentation inside a fence is content.
        fence.push(raw)
      }
      continue
    }
    if (fenceMark && fenceMark[1]) {
      flush()
      fence = []
      fenceLang = fenceMark[1].toLowerCase()
      continue
    }
    if (!line) {
      // A blank line does not end a table; models put one between rows.
      if (!rows.length) flush()
      continue
    }
    // A table row; the `| --- |` rule carries no cells.
    const row = /^\|(.+)\|$/.exec(line)
    if (row) {
      if (!/^[\s:|-]+$/.test(row[1])) {
        rows.push(row[1].split(/(?<!\\)\|/).map((c) => inline(c.replace(/\\\|/g, '|').trim())))
      }
      continue
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line)
    if (image) {
      flush()
      const caption = escape(image[1])
      out.push(
        `<figure><img src="${escape(image[2])}" alt="${caption}">` +
          (caption ? `<figcaption>${caption}</figcaption>` : '') +
          '</figure>',
      )
      continue
    }
    const heading = /^(#{2,6})\s+(.*)$/.exec(line)
    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\d{1,9}[.)]\s+(.*)$/.exec(line)
    const quote = /^>\s*(.*)$/.exec(line)
    if (heading) {
      flush()
      // The wrapper draws the section heading, so body headings start at h3.
      const level = Math.min(heading[1].length + 1, 6)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (bullet) {
      if (ordered) flush()
      ordered = false
      items.push(inline(bullet[1]))
    } else if (numbered) {
      if (!ordered) flush()
      ordered = true
      items.push(inline(numbered[1]))
    } else if (quote) {
      flush()
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
    } else {
      flush()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  // An unterminated fence (mid-stream) is drawn with what arrived.
  if (fence !== null) out.push(fenceHtml(fenceLang, fence.join('\n'), escape, pictures))
  flush()
  return out.join('')
}

/** One fenced block as the markup the template styles; unknown fences render nothing. */
function fenceHtml(
  lang: string,
  source: string,
  escape: (s: string) => string,
  pictures: Map<string, string>,
): string {
  if (lang === 'kpi') {
    const cells = parsePairs(source, 4)
      .map(
        ([value, label]) =>
          `<div><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`,
      )
      .join('')
    return cells ? `<div class="kpi">${cells}</div>` : ''
  }
  if (lang === 'steps') {
    const items = parsePairs(source, 8)
      .map(
        ([name, detail]) =>
          `<li><strong>${escape(name)}</strong>` +
          (detail ? ` <span>${escape(detail)}</span>` : '') +
          '</li>',
      )
      .join('')
    return items ? `<ol class="steps">${items}</ol>` : ''
  }
  if (lang === 'cards') {
    // `<section>`, not `<div>`: `richtext` reads this back with a lazy close,
    // so the wrapper tag must differ from its children's.
    const grid = parseCards(source)
      .map(
        (card) =>
          '<div>' +
          `<h3>${escape(card.title)}</h3>` +
          (card.items.length
            ? `<ul>${card.items.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>`
            : '') +
          '</div>',
      )
      .join('')
    return grid ? `<section class="cards">${grid}</section>` : ''
  }
  if (lang === 'callout') {
    const callout = parseCallout(source)
    if (!callout?.title) return ''
    return (
      '<section class="callout">' +
      `<h3>${escape(callout.title)}</h3>` +
      callout.items.map((line) => `<p>${escape(line)}</p>`).join('') +
      '</section>'
    )
  }
  if (lang === 'chart') {
    // Source only; the exporters build the chart from it.
    return `<figure class="chart" data-source="${escape(source)}"></figure>`
  }
  if (lang === 'mermaid') {
    const picture = pictures.get(source)
    return (
      `<figure class="diagram" data-source="${escape(source)}">` +
      (picture ? `<img src="${escape(picture)}" alt="">` : '') +
      '</figure>'
    )
  }
  return ''
}

/**
 * Picture per mermaid source in these sections, keyed by source text. Missing
 * ones are drawn off-screen (outside ProseMirror's subtree) and stored.
 */
function useDiagramPictures(
  sections: ReportSection[],
  artifactId: string,
  look: HTMLElement | null,
): Map<string, string> {
  const [pictures, setPictures] = useState<Map<string, string>>(() => new Map())
  // Signature of the last resolve; without it every keystroke would loop.
  const resolved = useRef('')

  useEffect(() => {
    const wanted = sections.flatMap((section) => {
      const sources = mermaidSources(section)
      return sources.length ? [[section, sources] as const] : []
    })
    const signature = JSON.stringify(
      wanted.map(([section, sources]) => [Object.keys(section.diagrams ?? {}), sources]),
    ) + String(Boolean(look))
    if (signature === resolved.current) return
    resolved.current = signature

    let live = true
    void (async () => {
      const found = new Map<string, string>()
      const missing: { section: ReportSection; source: string; key: string }[] = []
      for (const [section, sources] of wanted) {
        for (const source of sources) {
          const key = await diagramKey(source)
          const picture = section.diagrams?.[key]
          if (picture) found.set(source, picture)
          else missing.push({ section, source, key })
        }
      }
      if (!live) return
      setPictures(found)
      if (!missing.length || !look) return

      // Drawn off-screen inside the template's shadow root, so it takes the document's theme.
      const easel = document.createElement('div')
      easel.style.cssText = 'position:absolute;left:-99999px;top:0;width:700px'
      look.appendChild(easel)
      try {
        for (const { section, source, key } of missing) {
          const svg = await drawFitting(source, theme(easel), FRAMES.page)
          if (!live) return
          if (!svg) continue
          // The same frame the page view shows, so the export matches the screen.
          const png = await rasterise(framed(svg, FRAMES.page), 1)
          if (!live) return
          if (!png) continue
          found.set(source, png)
          setPictures(new Map(found))
          if (artifactId) {
            await artifactsApi.storeDiagram(artifactId, section.id, key, png).catch(() => undefined)
          }
        }
      } finally {
        easel.remove()
      }
    })()
    return () => {
      live = false
    }
  }, [sections, artifactId, look])

  return pictures
}

/** Every mermaid fence in a Markdown section body, in order. */
function mermaidSources(section: ReportSection): string[] {
  if (section.format === 'html') return []
  const out: string[] = []
  let collecting: string[] | null = null
  for (const raw of (section.content || '').split('\n')) {
    const mark = /^```+\s*([A-Za-z0-9_-]*)\s*$/.exec(raw.trim())
    if (collecting !== null) {
      if (mark) {
        out.push(collecting.join('\n'))
        collecting = null
      } else collecting.push(raw)
    } else if (mark && mark[1]?.toLowerCase() === 'mermaid') {
      collecting = []
    }
  }
  if (collecting !== null) out.push(collecting.join('\n'))
  return out
}
