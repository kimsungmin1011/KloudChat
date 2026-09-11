import {
  ArrowUp,
  Boxes,
  Columns2,
  Gauge,
  Globe,
  LayoutGrid,
  LayoutTemplate,
  Mic,
  MoreHorizontal,
  Paperclip,
  Plug,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileRow, PrivacyDecision, WebSearchSetting } from '@/lib/api'
import { transcriptionsApi } from '@/lib/api'
import { startWavRecording, type WavRecorder } from '@/lib/wavRecorder'
import { DesignGalleryModal, offersTemplates } from '@/components/chat/DesignGallery'
import { errorCode, errorMessage, PrivacyDecisionError, templateText } from '@/lib/api'
import { refusalSentence, startFailure } from '@/lib/failures'
import { handoffSurface } from '@/lib/documentRequest'
import { DICTATION_EVENT, isMac } from '@/lib/shortcuts'
import { currentLang } from '@/lib/i18n'
import { FINDING_LABEL } from '@/lib/privacy'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Dropdown, MenuItem, MenuLabel, MenuSeparator, Modal } from '@/components/ui'
import { cn } from '@/lib/utils'
import { effectiveModelId, useStore } from '@/store/useStore'
import type { ModelInfo, PrivacyAction, SessionKind, Skill, StartingPoint } from '@/types'
import { ASPECTS, servedAspect, servedAspects } from '@/lib/aspects'
import { ModelPicker } from './ModelPicker'
import { useFileDrop, usePasteFiles } from '@/lib/useFileDrop'
import { useT } from '@/lib/useT'

const placeholders: Record<SessionKind, string> = {
  chat: '무엇이든 물어보세요',
  report: '보고서 주제와 넣고 싶은 절을 적으세요',
  slides: '발표 주제와 시간을 적으세요',
  image: '만들고 싶은 이미지를 설명하세요',
  av: '만들고 싶은 영상이나 오디오를 설명하세요',
}

// Mirrors `imagegen.STYLE_CHOICES`.
const STYLES = ['자동', '도식', '인포그래픽', '차트', '사진', '일러스트', '미니멀', '3D 렌더', '수채화', '없음']
const LABELS: { id: 'auto' | 'ko' | 'en' | 'none'; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'ko', label: '한국어' },
  { id: 'en', label: '영어' },
  { id: 'none', label: '없음' },
]
const VIDEO_DURATIONS = [4, 6, 8, 10]
const AUDIO_DURATIONS = [15, 30, 60, 120]
// Nothing serves sound effects.
const AUDIO_KINDS = ['narration', 'music'] as const
const AUDIO_KIND_LABEL: Record<(typeof AUDIO_KINDS)[number], string> = {
  narration: '내레이션',
  music: '음악',
}

/** Voices the gateway accepts; anything else falls back to `alloy`. */
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

type PendingPrivacy = {
  decision: PrivacyDecision
  sessionId: string | null
  text: string
  attachments: FileRow[]
  activatedSkillIds: string[]
  startingTemplate: StartingPoint | null
  webSearch: WebSearchSetting
  restoreToken: number
}

const SOURCE_LABEL: Record<string, string> = {
  current_input: '현재 요청',
  conversation_history: '대화 기록',
  attachments: '첨부 파일',
  user_instructions: '개인 맞춤 설정',
  project_instructions: '프로젝트 지침',
  project_knowledge: '프로젝트 자료',
  memory: '메모리',
  agent: '에이전트 지침',
  skills: '스킬',
  tool_definitions: '도구 정의',
}

/** Compact chip-style selector used by the image and a/v option bars. */
function OptionGroup<T extends string | number>({
  label,
  value,
  options,
  onChange,
  format,
}: {
  label: string
  value: T
  options: readonly T[]
  onChange: (v: T) => void
  format?: (v: T) => string
}) {
  return (
    <Dropdown
      trigger={({ open }) => (
        <button
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-control border border-line px-2.5 text-sm transition-colors',
            open ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated hover:text-fg',
          )}
        >
          <span className="text-faint">{label}</span>
          <span className="font-medium">{format ? format(value) : value}</span>
        </button>
      )}
    >
      {options.map((o) => (
        <MenuItem key={String(o)} onClick={() => onChange(o)} checked={o === value}>
          {format ? format(o) : String(o)}
        </MenuItem>
      ))}
    </Dropdown>
  )
}

/** Names the media template whose values fill the option chips; gone once a chip is changed by hand. */
function TemplateOptionNote({ kinds }: { kinds: readonly string[] }) {
  const t = useT()
  const template = useStore((s) => s.optionTemplate)
  // Hidden while the template chip above already names it.
  const chipped = useStore((s) => s.pendingTemplate)
  if (!template || !kinds.includes(template.kind) || chipped?.id === template.id) return null
  return (
    <span
      className="flex items-center gap-1 text-xs text-faint"
      title={t('값을 직접 바꾸면 이 표시는 사라집니다')}
    >
      <LayoutGrid size={11} />
      {t('{name} 서식이 정한 값').replace(
        '{name}',
        templateText(template, currentLang() === 'en').name,
      )}
    </span>
  )
}

function ImageOptions({ model }: { model: ModelInfo | undefined }) {
  const t = useT()
  const { imageOptions, setImageOptions } = useStore()
  // Only the ratios this model can draw; the stored preference is kept.
  const offered = servedAspects(model)
  return (
    <>
      <OptionGroup
        label={t('비율')}
        value={servedAspect(imageOptions.aspect, model)}
        options={offered}
        onChange={(v) => setImageOptions({ aspect: v })}
      />
      <OptionGroup
        label={t('스타일')}
        value={imageOptions.style}
        options={STYLES}
        onChange={(v) => setImageOptions({ style: v })}
        format={t}
      />
      <OptionGroup
        label={t('글자')}
        value={imageOptions.labels}
        options={LABELS.map((row) => row.id)}
        onChange={(v) => setImageOptions({ labels: v })}
        format={(v) => t(LABELS.find((row) => row.id === v)?.label ?? v)}
      />
      <OptionGroup
        label={t('장수')}
        value={imageOptions.count}
        options={[1, 2, 4]}
        onChange={(v) => setImageOptions({ count: v })}
        format={(v) => t('{n}장').replace('{n}', String(v))}
      />
      <TemplateOptionNote kinds={['image']} />
    </>
  )
}

/** Nearest (resolution, sound) shape this model prices, or null; resolution outranks sound. */
function servedVideoShape(
  rates: Record<string, number>,
  resolution: '720p' | '1080p',
  withAudio: boolean,
): { resolution: '720p' | '1080p'; withAudio: boolean } | null {
  const keys = Object.keys(rates)
  if (keys.length === 0) return null
  const wanted = `${resolution}:${withAudio ? 'sound' : 'silent'}`
  const key =
    keys.find((candidate) => candidate === wanted) ??
    keys.find((candidate) => candidate.startsWith(`${resolution}:`)) ??
    keys.find((candidate) => candidate.endsWith(withAudio ? ':sound' : ':silent')) ??
    [...keys].sort((left, right) => rates[left] - rates[right])[0]
  const [served, sound] = key.split(':')
  return { resolution: served as '720p' | '1080p', withAudio: sound === 'sound' }
}

/** Video and audio option chips; `mode` decides which apply. */
function AvOptions() {
  const t = useT()
  const { avOptions, setAvOptions, models, modelByKind } = useStore()
  const audio = avOptions.mode === 'audio'
  const avModel = models.find((m) => m.id === modelByKind.av)
  const hasVideoModel = models.some((m) => m.kinds.includes('av') && m.modality === 'video')
  const shapedFor = useRef<string | null>(null)
  // When the model changes, snap the chips to a shape it prices; a chip
  // turned afterwards stands.
  useEffect(() => {
    if (audio || !avModel) return
    if (avModel.modality !== 'video') {
      if (hasVideoModel) setAvOptions({ mode: 'video' })
      return
    }
    if (shapedFor.current === avModel.id) return
    shapedFor.current = avModel.id
    const shape = servedVideoShape(
      avModel.creditPerSecond ?? {},
      avOptions.resolution,
      avOptions.withAudio,
    )
    if (!shape) return
    if (shape.resolution === avOptions.resolution && shape.withAudio === avOptions.withAudio) {
      return
    }
    setAvOptions(shape)
  }, [audio, avModel, hasVideoModel, avOptions.resolution, avOptions.withAudio, setAvOptions])
  return (
    <>
      <OptionGroup
        label={t('종류')}
        value={avOptions.mode}
        options={['video', 'audio'] as const}
        onChange={(v) => setAvOptions({ mode: v, durationSec: v === 'audio' ? 30 : 4 })}
        format={(v) => (v === 'audio' ? t('오디오') : t('영상'))}
      />
      {audio ? (
        <>
          <OptionGroup
            label={t('유형')}
            value={avOptions.audioKind}
            options={AUDIO_KINDS}
            onChange={(v) => setAvOptions({ audioKind: v })}
            format={(v) => t(AUDIO_KIND_LABEL[v])}
          />
          {avOptions.audioKind === 'narration' && (
            <OptionGroup
              label={t('목소리')}
              value={avOptions.voice}
              options={VOICES}
              onChange={(v) => setAvOptions({ voice: v })}
            />
          )}
        </>
      ) : (
        <>
          <OptionGroup
            label={t('비율')}
            value={avOptions.aspect}
            options={['16:9', '9:16', '1:1']}
            onChange={(v) => setAvOptions({ aspect: v })}
          />
          <OptionGroup
            label={t('해상도')}
            value={avOptions.resolution}
            options={['720p', '1080p'] as const}
            onChange={(v) => setAvOptions({ resolution: v })}
          />
          <OptionGroup
            label={t('소리')}
            value={avOptions.withAudio ? t('있음') : t('없음')}
            options={[t('없음'), t('있음')]}
            onChange={(v) => setAvOptions({ withAudio: v === t('있음') })}
          />
        </>
      )}
      <OptionGroup
        label={t('길이')}
        value={avOptions.durationSec}
        options={audio ? AUDIO_DURATIONS : VIDEO_DURATIONS}
        onChange={(v) => setAvOptions({ durationSec: v })}
        format={(v) => t('{n}초').replace('{n}', String(v))}
      />
      <TemplateOptionNote kinds={['video', 'audio']} />
    </>
  )
}

// Composer state carried across the remount that creating a session causes.
// Read once by the new composer and cleared.
/** The toggle's three positions; `auto` is sent as `'auto'`, the others as booleans. */
type WebSearchMode = 'auto' | 'on' | 'off'

let carriedComposer: {
  sessionId: string
  value: string
  attachments: FileRow[]
  startingTemplate: StartingPoint | null
  activatedSkillIds: string[]
  webSearchMode: WebSearchMode
} | null = null

// Unsent text keyed by session id, or `new:<kind>` on the home screen.
// Survives remounts, not reloads.
const drafts = new Map<string, string>()
const draftKeyFor = (sessionId: string | null, kind: SessionKind) => sessionId ?? `new:${kind}`

/** Whether a session has unsent text. */
export function hasUnsentDraft(sessionId: string) {
  return !!drafts.get(sessionId)?.trim()
}

export function Composer({
  sessionId,
  kind,
  projectId,
  autoFocus,
}: {
  sessionId: string | null
  kind: SessionKind
  projectId?: string | null
  autoFocus?: boolean
}) {
  const t = useT()
  const isMedia = kind === 'image' || kind === 'av'
  const canWebSearch = kind === 'chat' || kind === 'report' || kind === 'slides'
  const draftKey = draftKeyFor(sessionId, kind)
  const [value, setValue] = useState(() => drafts.get(draftKey) ?? '')
  const liveValue = useRef(value)
  liveValue.current = value
  const draftKeyRef = useRef(draftKey)
  useEffect(() => {
    if (draftKeyRef.current !== draftKey) {
      // The session changed under a mounted composer; load its own draft.
      draftKeyRef.current = draftKey
      const own = drafts.get(draftKey) ?? ''
      liveValue.current = own
      setValue(own)
      return
    }
    drafts.set(draftKey, value)
  }, [draftKey, value])
  const restoreSequence = useRef(0)
  const activeRestoreToken = useRef<number | null>(null)

  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  // A gallery sentence is appended to the box, never written over it, and
  // arrives selected so one keystroke removes it.
  // Selection applied after React commits the value.
  const pendingSelection = useRef<[number, number] | null>(null)
  useEffect(() => {
    if (!draft) return
    activeRestoreToken.current = null
    const kept = liveValue.current.replace(/\s*$/, '')
    const next = kept ? `${kept}\n\n${draft}` : draft
    liveValue.current = next
    setValue(next)
    setDraft('')
    ref.current?.focus()
    // Into an empty box the caret goes to the end. Applied in the layout
    // effect: the controlled textarea's next commit collapses an earlier selection.
    pendingSelection.current = [kept ? next.length - draft.length : next.length, next.length]
  }, [draft, setDraft])
  useLayoutEffect(() => {
    const range = pendingSelection.current
    if (!range) return
    pendingSelection.current = null
    ref.current?.setSelectionRange(range[0], range[1])
  }, [value])
  /** Uploaded files; the turn sends their ids. */
  const [attachments, setAttachments] = useState<FileRow[]>([])
  const liveAttachments = useRef(attachments)
  liveAttachments.current = attachments
  const [pendingPrivacy, setPendingPrivacy] = useState<PendingPrivacy | null>(null)
  const [reusableSessionId, setReusableSessionId] = useState<string | null>(null)
  const [privacyRetrying, setPrivacyRetrying] = useState(false)
  const [modelSelectionPending, setModelSelectionPending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  // A form a picked template brought with it; taken once and cleared.
  const pendingAttachment = useStore((s) => s.pendingAttachment)
  // Held here, not in the store, so a refused turn can be handed back whole.
  const [startingTemplate, setStartingTemplate] = useState<StartingPoint | null>(null)
  const liveStartingTemplate = useRef(startingTemplate)
  liveStartingTemplate.current = startingTemplate
  const pendingStartingTemplate = useStore((s) => s.pendingStartingTemplate)
  const setPendingStartingTemplate = useStore((s) => s.setPendingStartingTemplate)
  const pendingTemplate = useStore((s) => s.pendingTemplate)
  const setPendingTemplate = useStore((s) => s.setPendingTemplate)
  const livePendingTemplate = useRef(pendingTemplate)
  livePendingTemplate.current = pendingTemplate
  const designTemplates = useStore((s) => s.designTemplates)
  const promptTemplates = useStore((s) => s.promptTemplates)
  const [galleryOpen, setGalleryOpen] = useState(false)
  // A phone shows attach, dictation and web search; the rest sits behind 「더보기」,
  // and model comparison — answers side by side — is not offered at all.
  const phone = useMediaQuery('(pointer: coarse) and (max-width: 64rem), (max-width: 40rem)')
  const [moreOpen, setMoreOpen] = useState(false)
  const folded = phone && !moreOpen
  const setSessionTemplate = useStore((s) => s.setSessionTemplate)
  const setPendingAttachment = useStore((s) => s.setPendingAttachment)
  const composerRestore = useStore((s) => s.composerRestore)
  const setComposerRestore = useStore((s) => s.setComposerRestore)
  useEffect(() => {
    if (!pendingAttachment) return
    // Media surfaces take no attachments; drop it rather than leave it for the next chat turn.
    if (isMedia) {
      setPendingAttachment(null)
      return
    }
    activeRestoreToken.current = null
    setAttachments((current) => {
      const next = current.some((f) => f.id === pendingAttachment.id)
        ? current
        : [...current, pendingAttachment]
      liveAttachments.current = next
      return next
    })
    setPendingAttachment(null)
  }, [isMedia, pendingAttachment, setPendingAttachment])
  /** Refused-turn restoration without overwriting newer input. */
  useEffect(() => {
    if (!composerRestore || composerRestore.sessionId !== sessionId) return
    setComposerRestore(null)
    if (composerRestore.error) setChatError(composerRestore.error)
    if (
      liveValue.current ||
      liveAttachments.current.length > 0 ||
      liveActivatedSkillIds.current.length > 0 ||
      liveStartingTemplate.current
    ) {
      return
    }
    activeRestoreToken.current = null
    liveValue.current = composerRestore.value
    liveAttachments.current = composerRestore.attachments
    liveActivatedSkillIds.current = composerRestore.activatedSkillIds
    liveStartingTemplate.current = composerRestore.startingTemplate
    setValue(composerRestore.value)
    setAttachments(composerRestore.attachments)
    setActivatedSkillIds(composerRestore.activatedSkillIds)
    setStartingTemplate(composerRestore.startingTemplate)
    requestAnimationFrame(() => ref.current?.focus())
  }, [composerRestore, sessionId, setComposerRestore])

  // Values typed into the starting point's blanks, keyed by blank index.
  const [startingValues, setStartingValues] = useState<Record<number, string>>({})

  useEffect(() => {
    if (!pendingStartingTemplate) return
    activeRestoreToken.current = null
    liveStartingTemplate.current = pendingStartingTemplate
    setStartingTemplate(pendingStartingTemplate)
    setStartingValues({})
    setPendingStartingTemplate(null)
    if (pendingStartingTemplate.text) setValue(pendingStartingTemplate.text)
    // A starting point turns on what it declares it needs; both stay switchable.
    if (pendingStartingTemplate.needs?.includes('web')) setWebSearchMode('on')
    const wanted = pendingStartingTemplate.skills ?? []
    if (wanted.length) {
      const ids = usableSkills
        .filter((skill) => wanted.includes(skill.name))
        .map((skill) => skill.id)
        .slice(0, 3)
      if (ids.length) setActivatedSkillIds(ids)
    }
    requestAnimationFrame(() => ref.current?.focus())
    // usableSkills is stable between a pick and this effect; listing it would re-apply the pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStartingTemplate, setPendingStartingTemplate])
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // Dictation goes to the deployment's own Whisper, never to the browser
  // vendor's recognizer; the recording is not kept.
  const dictationEnabled = useStore((s) => s.dictationEnabled)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorder = useRef<WavRecorder | null>(null)
  const canRecord =
    dictationEnabled && typeof AudioContext !== 'undefined' && Boolean(navigator.mediaDevices)
  const stopRecording = async (): Promise<string> => {
    const active = recorder.current
    if (!active) return ''
    recorder.current = null
    setRecording(false)
    setTranscribing(true)
    try {
      const blob = await active.stop()
      // 16 kHz 16-bit mono = 32,000 bytes/s; under 0.3 s is a key tap, not speech.
      if (blob.size <= 44 + 32_000 * 0.3) return ''
      // The last answer primes Whisper's vocabulary; no language is pinned.
      const lastAnswer = [...(session?.messages ?? [])]
        .reverse()
        .find((m) => m.role === 'assistant' && m.content?.trim())
      const { text } = await transcriptionsApi.transcribe(blob, 'speech.wav', {
        prompt: lastAnswer?.content.replace(/\s+/g, ' ').slice(0, 300),
      })
      if (text) {
        setValue((v) => (v.trim() ? `${v.replace(/\s+$/, '')} ${text}` : text))
        requestAnimationFrame(() => ref.current?.focus())
      }
      return text ?? ''
    } catch (err) {
      setChatError(errorMessage(err, t('받아쓰지 못했습니다.')))
      return ''
    } finally {
      setTranscribing(false)
    }
  }
  const startRecording = async () => {
    setChatError(null)
    try {
      recorder.current = await startWavRecording()
      setRecording(true)
    } catch {
      setChatError(t('마이크를 쓸 수 없습니다. 브라우저의 마이크 권한을 확인해 주세요.'))
    }
  }
  // Push to talk: hold space in an empty box, release to transcribe and send.
  // `pushToTalk` marks a held-key recording; the mic button's recording waits for send.
  const pushToTalk = useRef(false)
  const holdToTalk = (e: { key: string; repeat: boolean; preventDefault: () => void }) => {
    if (e.key !== ' ' || !canRecord || busy || transcribing) return false
    if (liveValue.current.trim()) return false
    e.preventDefault()
    if (e.repeat || recorder.current) return true
    pushToTalk.current = true
    void startRecording()
    return true
  }
  const releaseToTalk = (e: { key: string; preventDefault: () => void }) => {
    if (e.key !== ' ' || !pushToTalk.current) return false
    e.preventDefault()
    pushToTalk.current = false
    void stopRecording().then((text) => {
      if (text.trim()) submit(text)
    })
    return true
  }
  // Cmd/Ctrl+Shift+M toggles the mic; unlike push-to-talk it waits for send.
  useEffect(() => {
    if (!canRecord) return
    const toggle = () => {
      if (transcribing) return
      pushToTalk.current = false
      void (recorder.current ? stopRecording() : startRecording())
    }
    window.addEventListener(DICTATION_EVENT, toggle)
    return () => window.removeEventListener(DICTATION_EVENT, toggle)
  })
  useEffect(() => {
    if (!canRecord) return
    // Also outside any field, but never on a control, where space is a click.
    const idle = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el || el === document.body) return true
      if (el.isContentEditable) return false
      return !['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A', 'SUMMARY'].includes(el.tagName)
    }
    const down = (e: KeyboardEvent) => {
      if (idle(e.target)) holdToTalk(e)
    }
    const up = (e: KeyboardEvent) => {
      if (idle(e.target)) releaseToTalk(e)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  })
  // 「자동」 by default: the web tools are offered and the server searches when the words
  // call for it; 「켬」 searches every turn, 「끔」 offers nothing. `searchBlocked` still
  // overrides per turn.
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>('auto')
  const webSearch = webSearchMode !== 'off'
  const webSearchModeLabel = { auto: t('자동'), on: t('켬'), off: t('끔') }[webSearchMode]
  const [activatedSkillIds, setActivatedSkillIds] = useState<string[]>([])
  const liveActivatedSkillIds = useRef(activatedSkillIds)
  liveActivatedSkillIds.current = activatedSkillIds
  const liveWebSearchMode = useRef(webSearchMode)
  liveWebSearchMode.current = webSearchMode
  // Built from live refs: `onSession` callbacks fire after the arming render.
  const heldComposer = (id: string) => ({
    sessionId: id,
    value: liveValue.current,
    attachments: liveAttachments.current,
    startingTemplate: liveStartingTemplate.current,
    activatedSkillIds: liveActivatedSkillIds.current,
    webSearchMode: liveWebSearchMode.current,
  })
  // Per-turn state resets when the surface or session changes; the typed sentence stays.
  const initializedScope = useRef<{ sessionId: string | null; kind: SessionKind } | null>(null)
  useEffect(() => {
    // StrictMode replays setup; a consumed handoff must not become a reset.
    const previous = initializedScope.current
    if (previous?.sessionId === sessionId && previous.kind === kind) return
    initializedScope.current = { sessionId, kind }
    if (sessionId && carriedComposer?.sessionId === sessionId) {
      // Only non-empty fields are put back: on a send the composer was cleared
      // before the session existed, and a refusal may already have restored
      // the real draft through the store.
      const held = carriedComposer
      carriedComposer = null
      if (held.value) {
        liveValue.current = held.value
        setValue(held.value)
      }
      if (held.attachments.length) {
        liveAttachments.current = held.attachments
        setAttachments(held.attachments)
      }
      if (held.startingTemplate) {
        liveStartingTemplate.current = held.startingTemplate
        setStartingTemplate(held.startingTemplate)
      }
      if (held.activatedSkillIds.length) {
        liveActivatedSkillIds.current = held.activatedSkillIds
        setActivatedSkillIds(held.activatedSkillIds)
      }
      setWebSearchMode(held.webSearchMode)
      return
    }
    liveActivatedSkillIds.current = []
    setActivatedSkillIds([])
    liveStartingTemplate.current = null
    setStartingTemplate(null)
    liveAttachments.current = []
    setAttachments([])
    setWebSearchMode('auto')
  }, [sessionId, kind])
  const ref = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const {
    send,
    stopStreaming,
    running,
    setNotice,
    skills,
    availableTools,
    sessions,
    projects,
    agents,
    connectors,
    toggleConnector,
    compareMode,
    compareModels,
    toggleCompareMode,
    toggleCompareModel,
    models,
    modelByKind,
    imageOptions,
    setImageOptions,
    jobs,
    uploadFile,
    newSession,
    setSessionRoutingMode,
    generateImages,
    generateAudio,
    generateVideo,
    avOptions,
    mediaError,
    clearMediaError,
  } = useStore()

  const project = projects.find((p) => p.id === projectId)
  const effectiveSessionId = sessionId ?? reusableSessionId
  const session = sessions.find((candidate) => candidate.id === effectiveSessionId)
  // A generation awaiting an answer or approval (document surfaces only).
  const pending = session?.pending ?? null
  const sessionAgent = agents.find((agent) => agent.id === session?.agentId)
  // The picked template, else the one the session already wears. Derived:
  // the server is what makes the choice sticky.
  const shownTemplate =
    (pendingTemplate?.surface === kind ? pendingTemplate : null) ??
    designTemplates.find((row) => row.id === session?.renderTemplateId) ??
    null
  // Same gate as the gallery button.
  const hasTemplates =
    offersTemplates(kind) &&
    (designTemplates.some((row) => row.surface === kind) ||
      promptTemplates.some((row) => row.kind === kind))
  // The empty screen, with its own gallery button, is gone.
  const started = (session?.messages.length ?? 0) > 0
  const model = models.find(
    (candidate) => candidate.id === effectiveModelId(session, kind, agents, modelByKind),
  )
  // A strict-local model gets no network tool and a comparison sends no flag;
  // the control follows the turn, not the stored preference.
  const searchBlocked = (compareMode && kind === 'chat') || Boolean(model?.strictLocal)
  const effectiveWebSearch = webSearch && !searchBlocked
  // What this turn sends: the mode, unless something blocks search altogether.
  const sentWebSearch: WebSearchSetting = !effectiveWebSearch
    ? false
    : webSearchMode === 'auto'
      ? 'auto'
      : true
  const agentSkillAllowlist = sessionAgent?.skillIds
  const agentToolAllowlist = sessionAgent?.tools
  const recommended = new Set(project?.skillIds ?? [])
  const usableSkills = skills
    .filter(
      (skill) =>
        skill.enabled &&
        (skill.kinds.length === 0 || skill.kinds.includes(kind)) &&
        (agentSkillAllowlist === undefined ||
          agentSkillAllowlist === null ||
          agentSkillAllowlist.includes(skill.id)),
    )
    .sort((left, right) => Number(recommended.has(right.id)) - Number(recommended.has(left.id)))

  const skillUnavailableReason = (skill: Skill): string | null => {
    if (skill.requiredTools.length === 0) return null
    if (kind !== 'chat' || compareMode) {
      return t('이 화면에서는 도구가 필요한 스킬을 실행할 수 없습니다.')
    }
    if (!model?.supportsTools) {
      return t('선택한 모델이 도구 호출을 지원하지 않습니다.')
    }
    if (agentToolAllowlist !== undefined && agentToolAllowlist !== null) {
      const denied = skill.requiredTools.filter((name) => !agentToolAllowlist.includes(name))
      if (denied.length > 0) {
        return t('에이전트가 필수 도구를 허용하지 않습니다: {tools}').replace(
          '{tools}',
          denied.join(', '),
        )
      }
    }
    if (skill.requiredTools.includes('web_search') && !effectiveWebSearch) {
      return searchBlocked
        ? t('strict-local 모델은 웹 검색 도구를 쓸 수 없습니다.')
        : t('먼저 웹 검색을 켜야 합니다.')
    }
    const unavailable = skill.requiredTools.filter((name) => {
      if (name === 'search_knowledge') return !sessionAgent?.hasKnowledge
      return !availableTools.some((tool) => tool.name === name && tool.available)
    })
    return unavailable.length > 0
      ? t('필수 도구를 사용할 수 없습니다: {tools}').replace(
          '{tools}',
          unavailable.join(', '),
        )
      : null
  }
  const activeSkills = activatedSkillIds
    .map((id) => usableSkills.find((skill) => skill.id === id))
    .filter(
      (skill): skill is Skill =>
        skill !== undefined && skillUnavailableReason(skill) === null,
    )
    .slice(0, 3)
  const autoActive =
    kind === 'chat' && (session?.routingMode === 'auto' || session?.routingMode === 'auto_quality')
  const autoBypassPreview =
    autoActive &&
    !compareMode &&
    Boolean(
      project ||
        sessionAgent ||
        attachments.length > 0 ||
        (effectiveWebSearch && webSearchMode === 'on') ||
        activeSkills.length > 0,
    )
  const autoPausedForCompare = autoActive && compareMode
  // Empty `kinds` means every surface.
  const usableAgents = agents.filter(
    (a) => a.enabled && (a.kinds.length === 0 || a.kinds.includes(kind)),
  )
  const usableConnectors = connectors.filter(
    (c) => c.installed && (c.kinds.length === 0 || c.kinds.includes(kind)),
  )
  const activeConnectors = usableConnectors.filter((c) => c.enabled && c.status === 'connected')
  // Per picture, per second by (resolution, sound), or per call; never
  // `creditCost`, which is per 1k output tokens.
  const videoRate =
    model?.creditPerSecond?.[`${avOptions.resolution}:${avOptions.withAudio ? 'sound' : 'silent'}`]
  // The submit endpoint refuses shapes the model does not price (Sora has no silent price).
  const unsupportedVideo =
    kind === 'av' && avOptions.mode === 'video' && videoRate === undefined
  const estimate = isMedia
    ? kind === 'image'
      ? (model?.creditPerImage ?? 0) * imageOptions.count
      : avOptions.mode === 'video'
        ? (videoRate ?? 0) * avOptions.durationSec
        : (model?.creditPerCall ?? model?.creditCost ?? 0)
    : 0
  const jobRunning = jobs.some(
    (j) => j.sessionId === sessionId && (j.status === 'running' || j.status === 'queued'),
  )
  // This session's own turn only.
  const streaming = !!sessionId && !!running[sessionId]
  const busy = isMedia ? jobRunning : streaming

  const deliverChat = async (
    targetSessionId: string | null,
    text: string,
    files: FileRow[],
    search: WebSearchSetting,
    skillIds: string[],
    startedFrom: StartingPoint | null,
    action?: PrivacyAction,
    decisionToken?: string,
    restoreToken?: number,
  ) => {
    setChatError(null)
    const resolvedSessionId = targetSessionId ?? reusableSessionId
    let attemptedSessionId = resolvedSessionId
    try {
      const acceptedSessionId = await send(resolvedSessionId, 'chat', text, {
        projectId,
        webSearch: search,
        attachments: files.map((file) => file.id),
        attachmentNames: files.map((file) => file.name),
        activatedSkillIds: skillIds,
        startingTemplate: startedFrom ?? undefined,
        privacyAction: action,
        privacyDecisionToken: decisionToken,
        onSession: (id) => {
          attemptedSessionId = id
          carriedComposer = heldComposer(id)
          navigate(`/s/${id}`, { replace: true })
        },
      })
      if (!sessionId) navigate(`/s/${acceptedSessionId}`, { replace: true })
      activeRestoreToken.current = null
      setReusableSessionId(null)
      setPendingPrivacy(null)
    } catch (error) {
      if (error instanceof PrivacyDecisionError) {
        const decisionSessionId = error.sessionId ?? resolvedSessionId
        setReusableSessionId(decisionSessionId)
        setPendingPrivacy({
          decision: error.decision,
          sessionId: decisionSessionId,
          text,
          attachments: files,
          activatedSkillIds: skillIds,
          startingTemplate: startedFrom,
          webSearch: search,
          restoreToken: restoreToken ?? ++restoreSequence.current,
        })
        return
      }
      setReusableSessionId((current) => current ?? attemptedSessionId)
      // Branch on the code: `errorMessage` swallows machine strings.
      const notice =
        errorCode(error) === 'auto_quality_model_required'
          ? t('Auto에 사용할 품질 모델을 다시 선택하세요. 초안과 첨부 파일은 그대로 보관했습니다.')
          : (refusalSentence(errorCode(error), t) ??
            errorMessage(error, t('요청을 전송하지 못했습니다. 잠시 후 다시 시도하세요.')))
      // Through the store: the composer that sent a session-creating turn is
      // unmounted by the time a refusal lands.
      setComposerRestore({
        sessionId: attemptedSessionId,
        value: text,
        attachments: files,
        activatedSkillIds: skillIds,
        startingTemplate: startedFrom,
        error: notice,
      })
      throw error
    }
  }

  const dismissPrivacyDecision = () => {
    if (!pendingPrivacy || privacyRetrying) return
    // Only the submission that still owns the cleared composer may restore it;
    // a newer edit or upload revokes that.
    if (activeRestoreToken.current === pendingPrivacy.restoreToken) {
      activeRestoreToken.current = null
      liveValue.current = pendingPrivacy.text
      liveAttachments.current = pendingPrivacy.attachments
      liveActivatedSkillIds.current = pendingPrivacy.activatedSkillIds
      liveStartingTemplate.current = pendingPrivacy.startingTemplate
      setValue(pendingPrivacy.text)
      setAttachments(pendingPrivacy.attachments)
      setActivatedSkillIds(pendingPrivacy.activatedSkillIds)
      setStartingTemplate(pendingPrivacy.startingTemplate)
    }
    setReusableSessionId(pendingPrivacy.sessionId)
    setPendingPrivacy(null)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`
  }, [value])

  /** Shared picker, drop, and paste upload path. */
  const addFiles = async (picked: File[]) => {
    if (!picked.length || isMedia) return
    setUploading(true)
    try {
      for (const file of picked) {
        const row = await uploadFile(file, {
          projectId: projectId ?? undefined,
          sessionId: sessionId ?? undefined,
        }).catch(() => null)
        if (row) {
          setAttachments((current) => {
            activeRestoreToken.current = null
            const next = [...current, row]
            liveAttachments.current = next
            return next
          })
        }
      }
    } finally {
      setUploading(false)
    }
  }

  // Media surfaces take no attachments.
  const { over: dragging, handlers: dropHandlers } = useFileDrop(
    (files) => void addFiles(files),
    !isMedia,
  )
  const onPasteFiles = usePasteFiles((files) => void addFiles(files))

  // Prefixes the filled blanks to the request; empty blanks are omitted.
  const withStartingValues = (typed: string) => {
    if (!startingTemplate) return typed
    // A media template fills one sentence; an empty blank keeps its example.
    if (startingTemplate.examplePrompt && startingTemplate.blanks) {
      const values = Object.fromEntries(
        startingTemplate.blanks.map((blank, index) => [
          blank.name,
          (startingValues[index] ?? '').trim() || startingTemplate.examples?.[index] || '',
        ]),
      )
      const sentence = startingTemplate.examplePrompt.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in values ? values[name] : whole,
      )
      return [sentence, typed].filter(Boolean).join('\n')
    }
    const lines = startingTemplate.fills
      .map((fill, index) => [fill, (startingValues[index] ?? '').trim()] as const)
      .filter(([, filled]) => filled)
      .map(([fill, filled]) => `${fill}: ${filled}`)
    if (!lines.length) return typed
    return [startingTemplate.title, ...lines, typed].filter(Boolean).join('\n')
  }
  // A media template's sentence is whole even with empty blanks.
  const startingFilled =
    Object.values(startingValues).some((one) => one.trim()) ||
    Boolean(startingTemplate?.examplePrompt)

  const submit = (spoken?: string) => {
    const text = withStartingValues((spoken ?? value).trim())
    if (!text || busy || modelSelectionPending || unsupportedVideo) return
    clearMediaError()
    const attachmentIds = attachments.map((f) => f.id)
    const attachmentLabels = attachments.map((f) => f.name)
    const sentAttachments = attachments
    const sentSkillIds = activeSkills.map((skill) => skill.id)
    const sentStartingTemplate = startingTemplate
    setChatError(null)
    const restoreToken = ++restoreSequence.current
    activeRestoreToken.current = kind === 'chat' ? restoreToken : null
    // Clear the composer first: the session is created server-side, so awaiting
    // the round trip would leave the sent text sitting in the box.
    liveValue.current = ''
    liveAttachments.current = []
    liveActivatedSkillIds.current = []
    // A starting point is spent on one turn, unlike the template chip.
    liveStartingTemplate.current = null
    setValue('')
    setAttachments([])
    setActivatedSkillIds([])
    setStartingTemplate(null)
    setStartingValues({})
    if (kind === 'av' && avOptions.mode === 'video') {
      // Video is a job; the card tracks it.
      void generateVideo(sessionId, text, {
        projectId,
        onSession: (id) => navigate(`/s/${id}`, { replace: true }),
      })
      return
    }
    if (kind === 'av' && avOptions.mode === 'audio') {
      // Audio returns inside its call; only video becomes a job.
      void generateAudio(sessionId, text, {
        projectId,
        onSession: (id) => navigate(`/s/${id}`, { replace: true }),
      })
      return
    }
    if (kind === 'image') {
      // Not streamed: `generateImages` writes both halves from one call.
      void generateImages(sessionId, text, {
        projectId,
        onSession: (id) => navigate(`/s/${id}`, { replace: true }),
      })
      return
    }
    // A document request typed into chat starts a new conversation on the
    // report or slides surface; agent chats and starting points keep it here.
    const handoff = kind === 'chat' && !sessionAgent && !sentStartingTemplate ? handoffSurface(text) : null
    if (handoff) {
      let landedHandoffSessionId = sessionId
      void send(null, handoff, text, {
        projectId,
        webSearch: sentWebSearch,
        attachments: attachmentIds,
        attachmentNames: attachmentLabels,
        onSession: (id) => {
          landedHandoffSessionId = id
          carriedComposer = heldComposer(id)
          navigate(`/s/${id}`, { replace: !sessionId })
        },
      }).catch((error: unknown) => {
        const freshnessRefusal = errorCode(error) === 'freshness_verification_unavailable'
        setComposerRestore({
          sessionId: freshnessRefusal ? landedHandoffSessionId : sessionId,
          value: text,
          attachments: sentAttachments,
          activatedSkillIds: sentSkillIds,
          startingTemplate: sentStartingTemplate,
          error: freshnessRefusal ? refusalSentence(errorCode(error), t) ?? '' : '',
        })
      })
      return
    }
    if (kind === 'chat') {
      void deliverChat(
        sessionId ?? reusableSessionId,
        text,
        sentAttachments,
        sentWebSearch,
        sentSkillIds,
        sentStartingTemplate,
        undefined,
        undefined,
        restoreToken,
      ).catch(() => undefined)
      return
    }
    // The pick is spent on this turn; the session row is the record from here.
    const sentTemplate = pendingTemplate?.surface === kind ? pendingTemplate : null
    setPendingTemplate(null)
    // Reassigned by `onSession` when this turn creates the session.
    let landedSessionId = sessionId
    void send(sessionId, kind, text, {
      projectId,
      webSearch: sentWebSearch,
      attachments: attachmentIds,
      attachmentNames: attachmentLabels,
      activatedSkillIds: sentSkillIds,
      // Writing surfaces only; an image template is applied by `generateImages`.
      renderTemplateId:
        shownTemplate && shownTemplate.kind !== 'image' ? shownTemplate.id : undefined,
      startingTemplate: sentStartingTemplate ?? undefined,
      // Sending from /new/:kind creates a session; the URL has to follow it.
      onSession: (id) => {
        landedSessionId = id
        carriedComposer = heldComposer(id)
        navigate(`/s/${id}`, { replace: true })
      },
    })
      .catch((error: unknown) => {
        // A refusal happens before the server stores the turn; restore the
        // draft through the store (see `deliverChat`).
        setComposerRestore({
          sessionId: landedSessionId,
          value: text,
          attachments: sentAttachments,
          activatedSkillIds: sentSkillIds,
          startingTemplate: sentStartingTemplate,
          error:
            errorCode(error) === 'freshness_verification_unavailable'
              ? refusalSentence(errorCode(error), t) ?? ''
              : '',
        })
        // The session row was rolled back with the refused turn; hand the
        // pick back unless a newer one was chosen meanwhile.
        if (sentTemplate && !livePendingTemplate.current) setPendingTemplate(sentTemplate)
      })
  }

  return (
    <div className="relative mx-auto w-full max-w-3xl px-4 pb-4" {...dropHandlers}>
      {dragging && (
        <div className="pointer-events-none absolute inset-x-4 inset-y-0 z-10 grid place-items-center rounded-panel border-2 border-dashed border-accent bg-accent-soft/90 text-base font-medium text-accent">
          <span className="flex items-center gap-2">
            <Paperclip size={15} />
            {t('여기에 놓으면 첨부됩니다')}
          </span>
        </div>
      )}
      <div className="rounded-panel border border-line bg-panel shadow-raised transition-colors focus-within:border-line-strong">
        {(project ||
          attachments.length > 0 ||
          webSearch ||
          activeSkills.length > 0 ||
          autoBypassPreview ||
          autoPausedForCompare ||
          startingTemplate ||
          // Same rule as the chip below: the session's own shape survives a reload.
          shownTemplate ||
          (compareMode && kind === 'chat')) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            {autoBypassPreview && (
              <Badge tone="warn" className="max-w-full whitespace-normal!">
                <Gauge size={11} />
                {session?.routingMode === 'auto_quality'
                  ? t('Auto · 품질 우선 · 이번 요청은 기능 사용으로 현재 모델 유지')
                  : t('Auto · 이번 요청은 기능 사용으로 품질 모델 유지')}
              </Badge>
            )}
            {autoPausedForCompare && (
              <Badge tone="warn" className="max-w-full whitespace-normal!">
                <Gauge size={11} />
                {t('Auto 일시 중지 · 비교할 모델을 직접 실행')}
              </Badge>
            )}
            {compareMode && kind === 'chat' && (
              <Badge tone="accent">
                <Columns2 size={11} />
                {compareModels
                  .map((id) => models.find((m) => m.id === id)?.label ?? id)
                  .join(' vs ')}
                <button
                  type="button"
                  onClick={toggleCompareMode}
                  aria-label={t('모델 비교 끄기')}
                  title={t('모델 비교 끄기')}
                  className="ml-0.5 text-faint hover:text-fg"
                >
                  <X size={10} />
                </button>
              </Badge>
            )}
            {webSearch &&
              (searchBlocked ? (
                <Badge tone="warn">
                  <Globe size={11} />
                  {compareMode && kind === 'chat'
                    ? t('웹 검색 안 함 · 모델 비교는 검색 없이 실행합니다')
                    : t('웹 검색 안 함 · 이 모델은 외부에 연결하지 않습니다')}
                </Badge>
              ) : (
                <Badge tone="accent">
                  <Globe size={11} />
                  {t('웹 검색')}
                </Badge>
              ))}
            {project && (
              <Badge tone="accent">
                <Boxes size={11} />
                {project.emoji} {project.name}
              </Badge>
            )}
            {shownTemplate && (
              <Badge tone="accent">
                <LayoutGrid size={11} />
                {templateText(shownTemplate, currentLang() === 'en').name}
                <button
                  type="button"
                  onClick={() => {
                    setPendingTemplate(null)
                    // The template's questions go with it.
                    if (startingTemplate?.examplePrompt) {
                      liveStartingTemplate.current = null
                      setStartingTemplate(null)
                      setStartingValues({})
                    }
                    // Sticky server-side once used, so clear the session row too.
                    if (session?.renderTemplateId) {
                      void setSessionTemplate(session.id, null)
                    }
                  }}
                  aria-label={t('{name} 서식 해제').replace(
                    '{name}',
                    templateText(shownTemplate, currentLang() === 'en').name,
                  )}
                  className="ml-0.5 text-faint hover:text-fg"
                >
                  <X size={10} />
                </button>
              </Badge>
            )}
            {/* Hidden for a media template, whose chip above already names it. */}
            {startingTemplate && (!startingTemplate.examplePrompt || !pendingTemplate) && (
              <Badge tone="accent">
                <LayoutTemplate size={11} />
                {startingTemplate.title}
                <button
                  type="button"
                  onClick={() => {
                    activeRestoreToken.current = null
                    liveStartingTemplate.current = null
                    setStartingTemplate(null)
                  }}
                  aria-label={t('{name} 시작점 해제').replace('{name}', startingTemplate.title)}
                  className="ml-0.5 text-faint hover:text-fg"
                >
                  <X size={10} />
                </button>
              </Badge>
            )}
            {startingTemplate?.needs?.includes('file') && attachments.length === 0 && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-2 text-xs text-warn hover:bg-warn/20"
              >
                <Paperclip size={11} />
                {t('이 일에는 파일이 필요합니다 — 첨부하기')}
              </button>
            )}
            {activeSkills.map((skill) => (
              <Badge key={skill.id} tone="accent">
                <Sparkles size={11} />
                {skill.name}
                <button
                  type="button"
                  onClick={() => {
                    activeRestoreToken.current = null
                    const next = activeSkills
                      .filter((candidate) => candidate.id !== skill.id)
                      .map((candidate) => candidate.id)
                    liveActivatedSkillIds.current = next
                    setActivatedSkillIds(next)
                  }}
                  aria-label={t('{name} 제거').replace('{name}', skill.name)}
                  className="ml-0.5 text-faint hover:text-fg"
                >
                  <X size={10} />
                </button>
              </Badge>
            ))}
            {attachments.map((f) => (
              <span
                key={f.id}
                className={cn(
                  'flex items-center gap-1.5 rounded-control border px-1.5 py-0.5 text-xs',
                  f.error
                    ? 'border-warn/40 bg-warn/5 text-warn'
                    : 'border-line bg-elevated',
                )}
                title={f.error ?? t('{n} 토큰').replace('{n}', f.tokens.toLocaleString())}
              >
                <Paperclip size={10} className={f.error ? '' : 'text-faint'} />
                {f.name}
                {f.error && <TriangleAlert size={10} />}
                <button
                  onClick={() =>
                    setAttachments((current) => {
                      activeRestoreToken.current = null
                      const next = current.filter((item) => item.id !== f.id)
                      liveAttachments.current = next
                      return next
                    })
                  }
                  className="text-faint hover:text-fg"
                  aria-label={t('{name} 제거').replace('{name}', f.name)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {uploading && (
              <span className="flex items-center gap-1.5 rounded-control border border-line bg-elevated px-1.5 py-0.5 text-xs text-faint">
                <Loader2 size={10} className="animate-spin" />
                {t('업로드 중')}
              </span>
            )}
            {attachments.some((f) => f.error) && (
              <p role="status" className="w-full text-xs text-warn">
                {attachments
                  .filter((f) => f.error)
                  .map((f) => `${f.name} — ${f.error}`)
                  .join(' · ')}
              </p>
            )}
          </div>
        )}

        {isMedia && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2.5 py-2">
            {kind === 'image' ? <ImageOptions model={model} /> : <AvOptions />}
            <span
              className={cn(
                'ml-auto pr-1 text-xs',
                unsupportedVideo ? 'text-warn' : 'text-faint',
              )}
            >
              {unsupportedVideo
                ? t('이 모델은 이 조합을 만들지 않습니다')
                : pendingTemplate?.kind === 'image' && pendingTemplate.figure
                  // A figure is drawn by the text model, not priced as a picture.
                  ? t('도식은 글 모델이 씁니다 · 그림 요금이 아닙니다')
                  : t('예상 {n} 크레딧').replace('{n}', estimate.toLocaleString())}
            </span>
          </div>
        )}

        {/* Starting-point blanks; filled ones are prefixed to the request. */}
        {!pending && startingTemplate && startingTemplate.fills.length > 0 && (
          <div
            role="group"
            aria-label={t('{name} 시작점 질문').replace('{name}', startingTemplate.title)}
            className="grid gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 sm:grid-cols-2"
          >
            {startingTemplate.fills.map((fill, index) => {
              const blank = startingTemplate.blanks?.[index]
              const set = (next: string) => {
                setStartingValues((all) => ({ ...all, [index]: next }))
                // An aspect blank also sets the aspect chip, which is what the request reads.
                if (blank?.name === 'aspect') {
                  const ratio = /^\s*(\d+:\d+)/.exec(next)?.[1]
                  if (ratio && ASPECTS.includes(ratio)) setImageOptions({ aspect: ratio })
                }
              }
              return (
                <label key={`${fill}-${index}`} className={cn('block min-w-0', blank?.long && 'sm:col-span-2')}>
                  <span className="mb-0.5 block text-xs font-medium text-muted">{fill}</span>
                  {blank?.options?.length ? (
                    <select
                      // Unpicked, the template default shows and is sent.
                      value={startingValues[index] ?? startingTemplate.examples?.[index] ?? ''}
                      onChange={(e) => set(e.target.value)}
                      aria-label={`${startingTemplate.title} · ${fill}`}
                      className="h-8 w-full rounded-control border border-line bg-panel px-2 text-sm focus:border-accent focus:outline-none"
                    >
                      {blank.options.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  ) : blank?.long ? (
                    <textarea
                      value={startingValues[index] ?? ''}
                      onChange={(e) => set(e.target.value)}
                      rows={4}
                      placeholder={startingTemplate.examples?.[index] || ''}
                      aria-label={`${startingTemplate.title} · ${fill}`}
                      className="w-full resize-y rounded-control border border-line bg-panel px-2 py-1.5 text-sm leading-relaxed placeholder:text-faint focus:border-accent focus:outline-none"
                    />
                  ) : (
                    <input
                      value={startingValues[index] ?? ''}
                      onChange={(e) => set(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          submit()
                        }
                      }}
                      placeholder={startingTemplate.examples?.[index] || ''}
                      aria-label={`${startingTemplate.title} · ${fill}`}
                      className="h-8 w-full rounded-control border border-line bg-panel px-2 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
                    />
                  )}
                </label>
              )
            })}
          </div>
        )}
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          rows={1}
          value={value}
          onChange={(e) => {
            activeRestoreToken.current = null
            liveValue.current = e.target.value
            // Written synchronously: picking a starting point navigates before an effect would run.
            drafts.set(draftKey, e.target.value)
            setValue(e.target.value)
          }}
          onKeyDown={(e) => {
            if (holdToTalk(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          onKeyUp={releaseToTalk}
          // File pastes only; text pastes are untouched.
          onPaste={onPasteFiles}
          placeholder={
            recording && pushToTalk.current
              ? t('듣고 있습니다. 스페이스를 떼면 보냅니다')
              : transcribing
                ? t('받아쓰는 중…')
                : pending
                  ? pending.stage === 'clarify'
                    ? t('답을 적거나, 위에서 고르세요')
                    : t('고칠 곳을 적어 주세요. 그대로 좋으면 위 버튼을 누르세요')
                  : startingTemplate && startingTemplate.fills.length > 0
                    ? t('덧붙일 말이 있으면 여기에 적으세요')
                    : t(placeholders[kind])
          }
          aria-label={t('프롬프트 입력')}
          data-composer=""
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-md leading-relaxed text-fg placeholder:text-faint focus:outline-none phone:min-h-[3.25rem] phone:text-[1rem] phone:leading-[1.6]"
        />

        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          {/* Media surfaces take no attachments. */}
          {!isMedia && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                aria-label={t('파일 선택')}
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? [])
                  // Reset immediately so picking the same file twice still fires.
                  e.target.value = ''
                  void addFiles(picked)
                }}
              />
              <button
                onClick={() => fileInput.current?.click()}
                className="grid size-9 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-elevated hover:text-fg"
                aria-label={t('첨부')}
                title={t('파일을 올려 답변의 근거로 씁니다')}
              >
                <Paperclip size={16} />
              </button>
            </>
          )}
          {canRecord && (
            <button
              onClick={() => void (recording ? stopRecording() : startRecording())}
              disabled={transcribing}
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-control transition-colors hover:bg-elevated hover:text-fg',
                recording ? 'text-danger' : 'text-muted',
              )}
              aria-label={recording ? t('녹음 끝내기') : t('말로 쓰기')}
              aria-pressed={recording}
              title={
                recording
                  ? t('누르면 녹음을 끝내고 받아씁니다')
                  : `${t('마이크로 말하면 글로 받아 적습니다. 보내기 전에 고칠 수 있습니다. 빈 입력창에서 스페이스를 누른 채 말하면 떼는 순간 보냅니다')} (${isMac() ? '⌘' : 'Ctrl'}+Shift+M)`
              }
            >
              {transcribing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Mic size={16} className={recording ? 'animate-pulse' : undefined} />
              )}
            </button>
          )}

          {/* Only once the conversation has started; the empty screen offers the same button. */}
          {hasTemplates && started && !folded && (
            <button
              onClick={() => setGalleryOpen(true)}
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-control transition-colors hover:bg-elevated hover:text-fg',
                shownTemplate ? 'text-accent' : 'text-muted',
              )}
              aria-label={t('작업 시작하기')}
              title={t('업무 시작점이나 결과 서식을 고릅니다')}
            >
              <LayoutGrid size={16} />
            </button>
          )}

          {/* Media models are never handed a skill. */}
          {!isMedia && usableSkills.length > 0 && !folded && (
            <Dropdown
              className="min-w-64"
              trigger={() => (
                <button
                  aria-label={t('스킬')}
                  title={t('이번 요청에만 적용할 스킬을 고릅니다')}
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-base transition-colors hover:bg-elevated',
                    activeSkills.length ? 'text-accent' : 'text-muted hover:text-fg',
                  )}
                >
                  <Sparkles size={15} />
                  {activeSkills.length > 0 && <span>{activeSkills.length}</span>}
                </button>
              )}
            >
              <MenuLabel>{t('이번 요청에 적용할 스킬 (최대 3개)')}</MenuLabel>
              {usableSkills.map((s) => {
                const selected = activeSkills.some((skill) => skill.id === s.id)
                const unavailable = skillUnavailableReason(s)
                const limitReached = !selected && activeSkills.length >= 3
                return (
                  <MenuItem
                    key={s.id}
                    checked={selected}
                    keepOpen
                    disabled={!!unavailable || limitReached}
                    title={limitReached ? t('최대 3개까지 선택할 수 있습니다.') : undefined}
                    hint={
                      unavailable
                        ? unavailable
                        : recommended.has(s.id)
                          ? t('프로젝트 추천')
                          : t('약 {n} 토큰').replace('{n}', s.estimatedTokens.toLocaleString())
                    }
                    onClick={() => {
                      activeRestoreToken.current = null
                      const next = selected
                        ? activeSkills
                            .filter((skill) => skill.id !== s.id)
                            .map((skill) => skill.id)
                        : [...activeSkills.map((skill) => skill.id), s.id]
                      liveActivatedSkillIds.current = next
                      setActivatedSkillIds(next)
                    }}
                  >
                    {s.name}
                  </MenuItem>
                )
              })}
              <MenuSeparator />
              <MenuItem icon={<Plus size={14} />} onClick={() => navigate('/skills')}>
                {t('스킬 관리')}
              </MenuItem>
            </Dropdown>
          )}

          {kind === 'chat' && !phone && (
            <Dropdown
              className="min-w-72"
              trigger={() => (
                <button
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-base transition-colors hover:bg-elevated',
                    compareMode ? 'text-accent' : 'text-muted hover:text-fg',
                  )}
                  aria-label={t('모델 비교')}
                  title={t('같은 질문을 여러 모델에 동시에 보내고 답변을 나란히 비교합니다')}
                >
                  <Columns2 size={15} />
                  {compareMode && <span>{compareModels.length}</span>}
                </button>
              )}
            >
              <MenuLabel>{t('모델 비교')}</MenuLabel>
              <MenuItem
                icon={<Columns2 size={14} />}
                hint={compareMode ? t('켜짐') : t('꺼짐')}
                onClick={toggleCompareMode}
              >
                {t('비교 모드')}
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>{t('비교할 모델 (2~3개)')}</MenuLabel>
              {models
                .filter((m) => m.kinds.includes('chat'))
                .map((m) => (
                  <MenuItem
                    key={m.id}
                    checked={compareModels.includes(m.id)}
                    hint={t('출력 1k당 {n} 크레딧').replace('{n}', m.creditCost.toLocaleString())}
                    onClick={() => toggleCompareModel(m.id)}
                    keepOpen
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{m.label}</span>
                      {m.strictLocal ? (
                        <Badge tone="success">
                          <ShieldCheck size={10} />
                          strict-local
                        </Badge>
                      ) : (
                        <Badge tone="warn">
                          {t(
                            m.dataBoundary === 'hybrid'
                              ? '외부 전환 가능'
                              : m.dataBoundary === 'external'
                                ? '외부 제공'
                                : m.dataBoundary === 'self_hosted'
                                  ? 'self-hosted · strict 미확인'
                                  : '경계 미확인',
                          )}
                        </Badge>
                      )}
                    </span>
                  </MenuItem>
                ))}
            </Dropdown>
          )}

          {canWebSearch && (
            <button
              onClick={() =>
                setWebSearchMode((m) => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto'))
              }
              aria-pressed={effectiveWebSearch}
              disabled={searchBlocked}
              className={cn(
                'flex h-9 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-base transition-colors hover:bg-elevated',
                !effectiveWebSearch
                  ? 'text-faint hover:text-muted'
                  : webSearchMode === 'on'
                    ? 'text-accent'
                    : 'text-muted hover:text-fg',
                searchBlocked && 'opacity-55 hover:bg-transparent hover:text-muted',
              )}
              aria-label={`${t('웹 검색')}: ${webSearchModeLabel}`}
              title={
                searchBlocked
                  ? compareMode && kind === 'chat'
                    ? t('모델 비교는 웹 검색 없이 실행합니다')
                    : t('이 모델은 외부에 연결하지 않아 웹 검색을 쓸 수 없습니다')
                  : webSearchMode === 'auto'
                    ? t('웹 검색 자동: 최신 사실이나 날씨를 물으면 찾아봅니다. 누르면 매번 검색')
                    : webSearchMode === 'on'
                      ? t('웹 검색 켬: 매번 검색합니다. 누르면 끔')
                      : t('웹 검색 끔: 찾아보지 않습니다. 누르면 자동')
              }
            >
              <Globe size={15} />
              <span className="text-sm">{webSearchModeLabel}</span>
            </button>
          )}

          {phone &&
            ((hasTemplates && started) ||
              (!isMedia && usableSkills.length > 0) ||
              usableConnectors.length > 0 ||
              usableAgents.length > 0) && (
              <button
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-control transition-colors hover:bg-elevated hover:text-fg',
                  moreOpen ? 'bg-elevated text-fg' : 'text-muted',
                )}
                aria-label={moreOpen ? t('도구 접기') : t('도구 더보기')}
                title={t('시작점·스킬·커넥터·에이전트')}
              >
                <MoreHorizontal size={16} />
              </button>
            )}

          {usableConnectors.length > 0 && !folded && (
            <Dropdown
              className="min-w-72"
              trigger={() => (
                <button
                  className={cn(
                    'flex h-9 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-base transition-colors hover:bg-elevated',
                    activeConnectors.length ? 'text-accent' : 'text-muted hover:text-fg',
                  )}
                  aria-label={
                    activeConnectors.length
                      ? t('커넥터 {n}개').replace('{n}', String(activeConnectors.length))
                      : t('커넥터')
                  }
                >
                  <Plug size={15} />
                  {activeConnectors.length > 0 && <span>{activeConnectors.length}</span>}
                </button>
              )}
            >
              <MenuLabel>{t('커넥터')}</MenuLabel>
              {/* Account-wide, unlike the per-turn controls beside it. */}
              <p className="px-2.5 pb-1.5 text-xs text-faint">
                {t('계정 전체 설정입니다. 여기서 끄면 모든 대화에서 꺼집니다.')}
              </p>
              {usableConnectors.map((c) => (
                <MenuItem
                  key={c.id}
                  icon={<span className="text-base">{c.icon}</span>}
                  hint={c.status === 'connected' ? (c.enabled ? t('켜짐') : t('꺼짐')) : t('인증 필요')}
                  onClick={() => c.status === 'connected' && toggleConnector(c.id)}
                >
                  {c.name}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem icon={<Plus size={14} />} onClick={() => navigate('/connectors')}>
                {t('커넥터 관리')}
              </MenuItem>
            </Dropdown>
          )}

          {usableAgents.length > 0 && !folded && (
            <Dropdown
              className="min-w-64"
              trigger={() => (
                <button
                  className="flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-control px-2.5 text-base text-muted transition-colors hover:bg-elevated hover:text-fg"
                  title={t('에이전트를 골라 새 대화를 시작합니다')}
                >
                  @
                </button>
              )}
            >
              <MenuLabel>{t('에이전트로 새 대화')}</MenuLabel>
              {usableAgents.map((a) => (
                <MenuItem
                  key={a.id}
                  hint={a.model ? a.model.split('/').pop() : undefined}
                  onClick={() =>
                    // An agent belongs to the session, so choosing one starts a conversation.
                    void newSession(kind, { agentId: a.id, projectId })
                      .then((id) => navigate(`/s/${id}`))
                      .catch((err: unknown) => setNotice(startFailure(err, t)))
                  }
                >
                  {a.name}
                </MenuItem>
              ))}
            </Dropdown>
          )}

          <div className="ml-auto flex min-w-0 items-center gap-1">
            {!(compareMode && kind === 'chat') && (
              <ModelPicker
                kind={kind}
                sessionId={sessionId ?? reusableSessionId}
                modality={kind === 'av' ? (avOptions.mode === 'video' ? 'video' : 'audio') : undefined}
                onEnableAuto={async (mode) => {
                  setChatError(null)
                  try {
                    let id = sessionId ?? reusableSessionId
                    if (!id) {
                      id = await newSession(kind, { projectId, routingMode: mode })
                      carriedComposer = heldComposer(id)
                      setReusableSessionId(id)
                      navigate(`/s/${id}`, { replace: true })
                    } else {
                      await setSessionRoutingMode(id, mode)
                    }
                  } catch (error) {
                    setChatError(
                      errorMessage(error, t('Auto를 켜지 못했습니다. 잠시 후 다시 시도하세요.')),
                    )
                  }
                }}
                onBusyChange={setModelSelectionPending}
              />
            )}
            <button
              onClick={streaming && sessionId ? () => stopStreaming(sessionId) : () => submit()}
              disabled={(!value.trim() && !startingFilled && !streaming) || modelSelectionPending}
              className={cn(
                'grid size-9 place-items-center rounded-full transition-colors',
                streaming
                  ? 'bg-elevated text-fg'
                  : 'bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-elevated disabled:text-faint',
              )}
              aria-label={streaming ? t('중지') : t('전송')}
              title={
                streaming
                  ? t('생성을 멈춥니다')
                  : modelSelectionPending
                    ? t('모델 설정 저장 중…')
                  : !value.trim() && !startingFilled
                    ? t('보낼 내용을 먼저 입력하세요')
                    : unsupportedVideo
                      ? t('이 모델은 이 조합을 만들지 않습니다')
                      : t('Enter 로도 보낼 수 있습니다')
              }
            >
              {streaming ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
      </div>
      {mediaError && (
        <p
          role="status"
          className="mt-2 flex items-start gap-2 rounded-card border border-danger/30 bg-danger/5 px-3 py-2 text-base text-danger"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{mediaError}</span>
          <button onClick={clearMediaError} aria-label={t('닫기')} className="shrink-0">
            <X size={13} />
          </button>
        </p>
      )}
      {chatError && !pendingPrivacy && (
        <p
          role="alert"
          className="mt-2 flex items-start gap-2 rounded-card border border-danger/30 bg-danger/5 px-3 py-2 text-base text-danger"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{chatError}</span>
          <button onClick={() => setChatError(null)} aria-label={t('닫기')} className="shrink-0">
            <X size={13} />
          </button>
        </p>
      )}
      {/* Keyboard hints mean nothing on a phone. */}
      <p className="mt-2 text-center text-xs text-faint phone:hidden">
        {busy && isMedia
            ? t('생성 중입니다 — 완료되면 위 카드가 결과로 바뀝니다')
            : kind === 'image'
              ? t('Enter 로 생성 · 만든 그림은 아티팩트에 쌓입니다')
              : kind === 'av' && avOptions.mode === 'audio'
                ? t('Enter 로 생성 · 음성과 음악은 아티팩트에 쌓입니다')
                : kind === 'av'
                  ? t('Enter 로 생성 · 영상은 몇 분 걸리고 진행은 카드에 표시됩니다')
                  : kind === 'slides'
                    ? t('Enter 로 생성 · 구성을 잡은 뒤 한 장씩 채웁니다')
                    : `${t('Enter 전송, Shift+Enter 줄바꿈')}, ${isMac() ? 'Cmd' : 'Ctrl'}+/ ${t('단축키 보기')}`}
      </p>

      <Modal
        open={pendingPrivacy !== null}
        onClose={dismissPrivacyDecision}
        title={t('개인정보가 포함된 요청입니다')}
        description={t('외부 모델로 보내기 전에 처리 방법을 선택하세요. 탐지된 실제 값은 표시하거나 기록하지 않습니다.')}
        width="max-w-xl"
        footer={
          <Button
            disabled={privacyRetrying}
            onClick={dismissPrivacyDecision}
          >
            {t('편집으로 돌아가기')}
          </Button>
        }
      >
        {pendingPrivacy && (
          <>
            {chatError && (
              <p role="alert" className="rounded-control bg-danger/10 px-3 py-2 text-sm text-danger">
                {chatError}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5" aria-label={t('탐지된 개인정보 범주')}>
              {pendingPrivacy.decision.findings.map((finding) => (
                <Badge key={`${finding.source}:${finding.category}`} tone="warn">
                  {t(SOURCE_LABEL[finding.source] ?? finding.source)} ·{' '}
                  {t(FINDING_LABEL[finding.category] ?? finding.category)} {finding.count}
                </Badge>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {pendingPrivacy.decision.allowedActions.includes('route_strict_local') && (
                <Button
                  variant="primary"
                  disabled={privacyRetrying}
                  onClick={() => {
                    setPrivacyRetrying(true)
                    void deliverChat(
                      pendingPrivacy.sessionId,
                      pendingPrivacy.text,
                      pendingPrivacy.attachments,
                      false,
                      pendingPrivacy.activatedSkillIds,
                      pendingPrivacy.startingTemplate,
                      'route_strict_local',
                      pendingPrivacy.decision.decisionToken,
                      pendingPrivacy.restoreToken,
                    )
                      .catch(() => undefined)
                      .finally(() => setPrivacyRetrying(false))
                  }}
                >
                  {t('안전한 로컬 모델로 전환')}
                </Button>
              )}
              <Button
                disabled={privacyRetrying}
                onClick={() => {
                  setPrivacyRetrying(true)
                  void deliverChat(
                    pendingPrivacy.sessionId,
                    pendingPrivacy.text,
                    pendingPrivacy.attachments,
                    pendingPrivacy.webSearch,
                    pendingPrivacy.activatedSkillIds,
                    pendingPrivacy.startingTemplate,
                    'mask_external',
                    pendingPrivacy.decision.decisionToken,
                    pendingPrivacy.restoreToken,
                  )
                    .catch(() => undefined)
                    .finally(() => setPrivacyRetrying(false))
                }}
              >
                {t('가린 뒤 기존 모델 사용')}
              </Button>
              {pendingPrivacy.decision.allowedActions.includes('send_raw_external') && (
                <Button
                  variant="danger"
                  disabled={privacyRetrying}
                  onClick={() => {
                    setPrivacyRetrying(true)
                    void deliverChat(
                      pendingPrivacy.sessionId,
                      pendingPrivacy.text,
                      pendingPrivacy.attachments,
                      pendingPrivacy.webSearch,
                      pendingPrivacy.activatedSkillIds,
                      pendingPrivacy.startingTemplate,
                      'send_raw_external',
                      pendingPrivacy.decision.decisionToken,
                      pendingPrivacy.restoreToken,
                    )
                      .catch(() => undefined)
                      .finally(() => setPrivacyRetrying(false))
                  }}
                >
                  {t('원문을 외부 모델로 전송')}
                </Button>
              )}
            </div>
            {pendingPrivacy.webSearch &&
              pendingPrivacy.decision.allowedActions.includes('route_strict_local') && (
                <p className="text-sm text-warn">
                  {t('안전한 로컬 모델은 외부에 연결하지 않습니다. 그 버튼을 고르면 이 요청은 웹 검색 없이 실행됩니다.')}
                </p>
              )}
            {pendingPrivacy.decision.requestedModels.length > 1 &&
              pendingPrivacy.decision.allowedActions.includes('route_strict_local') && (
                <p className="text-sm text-muted">
                  {t('모델 비교는 아직 시작되지 않았습니다. 안전 모델을 선택하면 비교 대신 strict-local 모델 1개로 실행합니다.')}
                </p>
              )}
            {pendingPrivacy.decision.safeModels.length === 0 && (
              <p className="text-sm text-warn">
                {t('관리자가 설정한 strict-local 모델이 없어 마스킹하거나 내용을 편집해야 합니다.')}
              </p>
            )}
          </>
        )}
      </Modal>

      <DesignGalleryModal
        kind={kind}
        sessionId={sessionId}
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
      />
    </div>
  )
}
