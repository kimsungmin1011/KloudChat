import type { WebSearchSetting } from '@/lib/api'
import { create } from 'zustand'
import { applyBrand } from '@/lib/brand'
import {
  errorCode,
  errorMessage,
} from '@/lib/api'
import { servedAspect } from '@/lib/aspects'
import { refusalSentence, streamFailureSentence } from '@/lib/failures'
import {
  ApiError,
  PrivacyDecisionError,
  StreamStalledError,
  UnauthorizedError,
  adminApi,
  agentsApi,
  artifactsApi,
  jobsApi,
  authConfig,
  auth,
  connectorsApi,
  designsApi,
  designTemplatesApi,
  promptTemplatesApi,
  keysApi,
  filesApi,
  memoryApi,
  modelsApi,
  projectsApi,
  sessionsApi,
  setAccessToken,
  skillsApi,
  streamComparison,
  streamSession,
  toolsApi,
  usageApi,
} from '@/lib/api'
import type {
  AgentRow,
  ApiKeyRow,
  AuthSession,
  ArtifactRow,
  AuditRow,
  GovernancePolicy,
  CatalogEntry,
  ConnectorRow,
  DesignRow,
  DesignTemplateRow,
  JobRow,
  FileRow,
  MemoryRow,
  MessageRow,
  ModelCatalogue,
  ProjectRow,
  PromptTemplateRow,
  SessionRow,
  SkillRow,
  StoreSkillRow,
  UsageReport,
} from '@/lib/api'
import type {
  Agent,
  Artifact,
  Connector,
  Job,
  MemoryEntry,
  Message,
  ModelInfo,
  Project,
  ProjectFile,
  PendingPlan,
  Session,
  Preferences,
  PrivacyAction,
  PrivacyRouting,
  DeckArtifact,
  ReportArtifact,
  ReportSection,
  SessionKind,
  StartingPoint,
  Variant,
  Skill,
  Step,
  StoreSkill,
  ToolCatalogEntry,
  User,
} from '@/types'
import { uid } from '@/lib/utils'
import { currentLang, translate, type Lang } from '@/lib/i18n'

/** Store-side translation (no hooks here); only strings that reach the screen. */
const tr = (text: string) => translate(currentLang(), text)

/** Send options per user-message id, so 다시 시도 resends the same turn. Not persisted. */
const sentWith = new Map<string, SendOptions>()

type Theme = 'light' | 'dark' | 'system'
type SidebarMode = 'full' | 'rail' | 'hidden'

/** A client refusal is returned before send/compare writes its first Message. */
const isClientRefusal = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status >= 400 && error.status < 500

/** Per-session PATCH queue for model/routing changes; a send waits for the latest one. */
const sessionPersistence = new Map<string, Promise<void>>()

/** Jobs already polled by this tab, so opening the session does not start a second loop. */
const followedJobs = new Set<string>()

function queueSessionPersistence(sessionId: string, persist: () => Promise<void>): Promise<void> {
  const previous = sessionPersistence.get(sessionId) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(persist)
  sessionPersistence.set(sessionId, queued)
  const cleanup = () => {
    if (sessionPersistence.get(sessionId) === queued) sessionPersistence.delete(sessionId)
  }
  void queued.then(cleanup, cleanup)
  return queued
}

const noop = () => {}

/** Marks a session as having a turn in flight, with the abort for that turn. */
function beginRun(set: Set, sessionId: string, abort: () => void = noop) {
  set((s) => ({ running: { ...s.running, [sessionId]: abort } }))
}

/** Ends a session's run and reconciles the transcript with the server. */
function endRun(set: Set, sessionId: string) {
  set((s) => {
    if (!(sessionId in s.running)) return {}
    const { [sessionId]: _done, ...rest } = s.running
    return { running: rest }
  })
  void reconcileSession(set, sessionId)
}

/**
 * Merges the stored transcript over the on-screen one: the server decides which
 * messages exist and what they say; a field it left empty keeps the screen's value
 * (streamed steps and privacy notices are not all stored).
 */
async function reconcileSession(set: Set, sessionId: string) {
  const row = await sessionsApi.get(sessionId).catch(() => null)
  if (!row) return
  const fresh = toSession(row)
  set((s) => {
    const held = s.sessions.find((c) => c.id === sessionId)
    if (!held || sessionId in s.running) return {}
    // Pair by id where one matches, else by position from the front: only the
    // chat path adopts server ids, and a short server list is short at the end.
    const byId = new Map(held.messages.map((m) => [m.id, m]))
    const mineAt = (index: number) => held.messages[index]
    const paired = fresh.messages.map((message, index) => {
      const mine = byId.get(message.id) ?? mineAt(index)
      if (!mine || mine.role !== message.role) return message
      const overlay = Object.fromEntries(
        Object.entries(message).filter(([, value]) => {
          if (value === undefined || value === null) return false
          if (Array.isArray(value)) return value.length > 0
          if (typeof value === 'string') return value.length > 0
          return true
        }),
      )
      return { ...mine, ...overlay }
    })
    // Messages only the screen has stay.
    const extra = held.messages.slice(fresh.messages.length)
    const merged = { ...fresh, messages: [...paired, ...extra] }
    // No new object identity when nothing changed: `watchForTheAnswer` calls this on a timer.
    if (same(held, merged)) return {}
    return { sessions: s.sessions.map((c) => (c.id === sessionId ? merged : c)) }
  })
}

/** Whether a reconcile found anything worth writing. */
function same(held: Session, merged: Session): boolean {
  if (held.messages.length !== merged.messages.length) return false
  if (held.title !== merged.title) return false
  return held.messages.every((mine, index) => {
    const theirs = merged.messages[index]
    return (
      mine.id === theirs.id &&
      mine.role === theirs.role &&
      mine.content === theirs.content &&
      (mine.steps?.length ?? 0) === (theirs.steps?.length ?? 0) &&
      (mine.attachments?.length ?? 0) === (theirs.attachments?.length ?? 0) &&
      Boolean(mine.variants) === Boolean(theirs.variants)
    )
  })
}

async function waitForSessionPersistence(sessionId: string): Promise<void> {
  // Loop until the awaited promise is still the last one queued for this session.
  while (true) {
    const pending = sessionPersistence.get(sessionId)
    if (!pending) return
    await pending
    if (sessionPersistence.get(sessionId) === pending) return
  }
}

type SendOptions = {
  projectId?: string | null
  webSearch?: WebSearchSetting
  /** Ids of already-uploaded files. */
  attachments?: string[]
  /** Their names, for the optimistic bubble. */
  attachmentNames?: string[]
  /** Skills selected for this turn only. */
  activatedSkillIds?: string[]
  /** Sent with the turn (the session may not exist yet); the server makes it sticky. */
  renderTemplateId?: string
  /** Only the id goes on the wire; the title names the bubble until the server's copy arrives. */
  startingTemplate?: StartingPoint
  privacyAction?: PrivacyAction
  privacyDecisionToken?: string
  /** Write the pending outline instead of planning again (이대로 생성). */
  approve?: boolean
  /** The figure card's answer; absent means it was not asked. */
  includeFigures?: boolean
  /** The outline as edited on the proposal card. */
  plan?: Record<string, unknown>
  /** Answers to a stopped turn's questions, keyed by question id. */
  answers?: Record<string, string>
  /** Chat only: rerun this failed user message in place instead of appending. */
  retryOf?: string
  /** One-turn model override (다른 모델로 다시 생성). */
  model?: string
  /** Called as soon as a session id exists, before the stream finishes. */
  onSession?: (id: string) => void
}

interface State {
  // ── auth ──────────────────────────────────────────────────────────────
  user: User | null
  authenticated: boolean
  /** True until the boot-time session check finishes. */
  authLoading: boolean
  /** Backend `detail` code from the last failed auth call. */
  authError: string | null
  /** Set when the session ended by idle timeout rather than 로그아웃. */
  signedOutReason: 'idle' | null
  /** Minutes of inactivity allowed; 0 is off. */
  idleTimeoutMinutes: number
  /** Whether a speech-to-text backend is configured. */
  dictationEnabled: boolean
  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name: string) => Promise<void>
  adoptSession: (session: AuthSession) => void
  logout: (reason?: 'idle') => Promise<void>
  refreshMe: () => Promise<void>
  updateProfile: (patch: {
    name?: string
    avatarColor?: string
    preferences?: Partial<Preferences>
  }) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>

  // ── chrome ────────────────────────────────────────────────────────────
  theme: Theme
  toggleTheme: () => void
  lang: Lang
  toggleLang: () => void
  sidebar: SidebarMode
  /** full → rail → hidden → full. On a narrow layout there is no rail. */
  cycleSidebar: () => void

  // ── data ──────────────────────────────────────────────────────────────
  users: User[]
  sessions: Session[]
  jobs: Job[]
  projects: Project[]
  artifacts: Artifact[]
  skills: Skill[]
  /** Shared skills not yet copied into this account; loaded separately from the workspace. */
  skillStore: StoreSkill[]
  skillStoreLoading: boolean
  /** The last listing failed; distinct from empty. */
  skillStoreError: boolean
  designs: DesignRow[]
  /** Server-shipped, read-only. */
  designTemplates: DesignTemplateRow[]
  /** Built-in 시작점. */
  promptTemplates: PromptTemplateRow[]
  availableTools: ToolCatalogEntry[]
  memories: MemoryEntry[]
  agents: Agent[]

  // ── models ────────────────────────────────────────────────────────────
  models: ModelInfo[]
  modelsLoading: boolean
  /** Per collection: still loading (an empty list alone cannot say). */
  workspaceLoading: boolean
  artifactsLoading: boolean
  sessionsLoading: boolean
  /** Per collection: the last refresh failed and the list may be stale. */
  workspaceFailed: boolean
  artifactsFailed: boolean
  sessionsFailed: boolean
  /** False when the proxy did not answer and only adapter models are listed. */
  litellmAvailable: boolean
  autoRouting: ModelCatalogue['autoRouting']
  loadModels: () => Promise<void>

  // ── session / generation ──────────────────────────────────────────────
  activeSessionId: string | null
  /** Sessions with a turn in flight, each holding the abort for its own stream. */
  running: Record<string, () => void>
  modelByKind: Record<SessionKind, string>
  setModel: (kind: SessionKind, id: string) => void
  /** One remembered model per av mode; `modelByKind.av` mirrors the current mode's. */
  avModelByMode: Record<AvMode, string>
  /** Changes one conversation's model; the surface default is left alone. */
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>
  /** Auto is stored as a session mode, never as a synthetic model id. */
  setSessionRoutingMode: (sessionId: string, mode: Session['routingMode']) => Promise<void>
  setActiveSession: (id: string | null) => void
  /** Titles only; transcripts arrive with `openSession`. */
  loadSessions: () => Promise<void>
  openSession: (id: string) => Promise<void>
  newSession: (
    kind: SessionKind,
    opts?: {
      projectId?: string | null
      agentId?: string | null
      routingMode?: Session['routingMode']
    },
  ) => Promise<string>
  send: (
    sessionId: string | null,
    kind: SessionKind,
    text: string,
    opts?: SendOptions,
  ) => Promise<string>
  stopStreaming: (sessionId: string) => void
  renameSession: (id: string, title: string) => Promise<void>
  setSessionTemplate: (id: string, templateId: string | null) => Promise<void>
  moveSessionToProject: (id: string, projectId: string | null) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** Returns how many the server removed. */
  deleteSessions: (payload: {
    ids?: string[]
    all?: boolean
    /** Delete their artifacts too. */
    artifacts?: boolean
  }) => Promise<number>
  /** Polls one job until it settles. */
  followJob: (sessionId: string, jobId: string) => Promise<void>
  generateVideo: (
    sessionId: string | null,
    prompt: string,
    opts?: { projectId?: string | null; onSession?: (id: string) => void },
  ) => Promise<void>
  retryJob: (job: Job) => Promise<void>
  /** Sends a failed picture or narration prompt again, as a second turn. */
  retryMediaTurn: (sessionId: string, prompt: string) => Promise<void>
  generateAudio: (
    sessionId: string | null,
    prompt: string,
    opts?: { projectId?: string | null; onSession?: (id: string) => void },
  ) => Promise<void>
  generateImages: (
    sessionId: string | null,
    prompt: string,
    opts?: {
      projectId?: string | null
      onSession?: (id: string) => void
      /** Send the prompt as it stands, without planning. */
      raw?: boolean
    },
  ) => Promise<void>
  togglePinSession: (id: string) => Promise<void>
  rateMessage: (
    sessionId: string,
    messageId: string,
    rating: 'up' | 'down' | null,
  ) => Promise<void>

  // ── model comparison ──────────────────────────────────────────────────
  compareMode: boolean
  compareModels: string[]
  toggleCompareMode: () => void
  toggleCompareModel: (id: string) => void
  /** Keeps one variant's answer and continues the conversation from it. */
  chooseVariant: (sessionId: string, messageId: string, model: string) => Promise<void>

  // ── governance (admin) ────────────────────────────────────────────────
  /** Null until fetched. */
  usage: UsageReport | null
  audit: AuditRow[] | null
  loadUsage: (days?: number) => Promise<void>
  loadAudit: () => Promise<void>
  /** Null until fetched. */
  apiKeys: ApiKeyRow[] | null
  loadApiKeys: () => Promise<void>
  createApiKey: (name: string) => Promise<string | null>
  revokeApiKey: (id: string) => Promise<void>
  governance: GovernancePolicy | null
  loadGovernance: () => Promise<void>
  setGovernance: (patch: Partial<GovernancePolicy>) => Promise<number>
  /** Non-optimistic save, throws on failure. */
  saveGovernance: (patch: Partial<GovernancePolicy>) => Promise<number>

  // ── image / audio-video ───────────────────────────────────────────────
  /** The media 서식 whose defaults the option chips show; any manual chip change clears it. */
  optionTemplate: DesignTemplateRow | null
  setOptionTemplate: (template: DesignTemplateRow | null) => void
  imageOptions: { aspect: string; style: string; labels: 'auto' | 'ko' | 'en' | 'none'; count: number }
  setImageOptions: (patch: Partial<State['imageOptions']>) => void
  /** Text to drop into the composer; never sent on the user's behalf. */
  draft: string
  setDraft: (text: string) => void
  /** Form file a picked template carries to the composer. Consumed once. */
  pendingAttachment: FileRow | null
  setPendingAttachment: (file: FileRow | null) => void
  /** A refused turn's draft, addressed to the session it was sent to; the sending composer may already be unmounted. */
  composerRestore: {
    sessionId: string | null
    value: string
    attachments: FileRow[]
    activatedSkillIds: string[]
    startingTemplate: StartingPoint | null
    error: string
  } | null
  setComposerRestore: (restore: State['composerRestore']) => void
  /** Shell-level failure sentence for actions with no screen of their own. Cleared by the bar that shows it. */
  notice: string | null
  setNotice: (notice: string | null) => void
  /** Rendering template picked in the gallery, waiting for the turn that will use it. */
  pendingTemplate: DesignTemplateRow | null
  setPendingTemplate: (template: DesignTemplateRow | null) => void
  /** 시작점 picked in the gallery, handed to the composer. Consumed once. */
  pendingStartingTemplate: StartingPoint | null
  setPendingStartingTemplate: (template: StartingPoint | null) => void
  /** An empty logo draws the default mark. */
  brand: { name: string; logo: string }
  /** Re-reads `/auth/config` — brand, enabled surfaces and the rest of what
   *  `bootstrap` seeded from it — so a change an admin just saved shows up
   *  in this tab without a reload. */
  refreshConfig: () => Promise<void>
  /** Chat is always among them. */
  enabledKinds: SessionKind[]
  avOptions: {
    mode: 'video' | 'audio'
    aspect: string
    durationSec: number
    audioKind: 'narration' | 'music'
    /** Narration only. */
    voice: string
    /** Video only; priced separately. */
    resolution: '720p' | '1080p'
    withAudio: boolean
  }
  setAvOptions: (patch: Partial<State['avOptions']>) => void
  cancelJob: (id: string) => Promise<void>

  // ── artifact panel ────────────────────────────────────────────────────
  openArtifactId: string | null
  openArtifact: (id: string | null) => void
  /** A delete waiting out its undo window. */
  pendingDelete: { label: string; undo: () => void } | null
  mediaError: string | null
  clearMediaError: () => void
  /** Replaces the store's copy with the server's, and returns it. */
  refreshArtifact: (id: string) => Promise<Artifact | null>

  // ── workspace ─────────────────────────────────────────────────────────
  /** One call after sign-in; each screen also refreshes its own slice. */
  loadWorkspace: () => Promise<void>
  /** The server defaults `emoji` to 📁. */
  createProject: (
    p: Pick<Project, 'name' | 'description' | 'instructions'> & Partial<Pick<Project, 'emoji'>>,
  ) => Promise<string>
  updateProject: (id: string, patch: Partial<Project>) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  /** Bulk delete behind a confirm; no undo window. */
  deleteMany: (
    kind: 'projects' | 'artifacts' | 'skills' | 'agents' | 'designs' | 'connectors',
    ids: string[],
  ) => Promise<number>
  uploadFile: (file: File, opts?: { projectId?: string; sessionId?: string }) => Promise<FileRow>
  addProjectUrl: (projectId: string, url: string) => Promise<FileRow>
  deleteFile: (id: string) => Promise<void>
  /** Fetches the template list only if it is not already held. */
  ensureDesignTemplates: () => Promise<void>
  /** Page one, for the current filter or the one passed in. */
  loadArtifacts: (filter?: ArtifactFilter) => Promise<void>
  /** The page after the oldest row on screen. */
  loadMoreArtifacts: () => Promise<void>
  artifactFilter: ArtifactFilter
  artifactsHasMore: boolean
  artifactsLoadingMore: boolean
  /** Per-kind totals for this filter, from a separate count query. */
  artifactCounts: Record<string, number> | null
  deleteArtifact: (id: string) => Promise<void>

  // ── MCP connectors ────────────────────────────────────────────────────
  connectors: Connector[]
  connectorCatalog: CatalogEntry[]
  toggleConnector: (id: string) => Promise<void>
  /** Credential values are write-only server-side. */
  updateConnectorEnv: (id: string, env: Record<string, string>) => Promise<void>
  toggleConnectorTool: (id: string, tool: string) => Promise<void>
  installConnector: (slug: string, env?: Record<string, string>) => Promise<void>
  uninstallConnector: (id: string) => Promise<void>
  syncConnector: (id: string) => Promise<void>
  addCustomConnector: (
    c: Pick<Connector, 'name' | 'transport' | 'endpoint' | 'auth'> & {
      /** Write-only credentials for the server process. */
      env?: Record<string, string>
    },
  ) => Promise<void>

  // ── workspace ─────────────────────────────────────────────────────────
  toggleSkill: (id: string) => Promise<void>
  upsertSkill: (s: Skill) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  loadSkillStore: () => Promise<void>
  installSkill: (id: string) => Promise<void>
  upsertMemory: (m: MemoryEntry) => Promise<void>
  deleteMemory: (id: string) => Promise<void>
  togglePinMemory: (id: string) => Promise<void>
  upsertAgent: (a: Agent) => Promise<void>
  /** Copies a shared agent and the skills it runs on. */
  installAgent: (a: Agent) => Promise<void>
  deleteAgent: (id: string) => Promise<void>

  // ── admin ─────────────────────────────────────────────────────────────
  usersLoading: boolean
  loadUsers: () => Promise<void>
  approveUser: (id: string, monthlyCredits?: number) => Promise<void>
  rejectUser: (id: string) => Promise<void>
  suspendUser: (id: string) => Promise<void>
  reinstateUser: (id: string) => Promise<void>
  rotateLitellmKey: (id: string) => Promise<void>
  removeUser: (id: string, purgeFiles?: boolean) => Promise<void>
  /** Empty means the whole catalogue. */
  setUserModels: (id: string, models: string[]) => Promise<void>
  setUserCredits: (id: string, monthlyCredits: number) => Promise<void>
  updateUser: (id: string, patch: { name?: string; email?: string }) => Promise<void>
  resetUserPassword: (id: string, password: string) => Promise<void>
  replaceLitellmKey: (id: string, key: string) => Promise<void>
}

/** Bumped on every workspace write, so a stale fetch cannot overwrite newer state. */
let workspaceEpoch = 0
const touchWorkspace = () => ++workspaceEpoch

/** Matches the server's page size. */
const ARTIFACT_PAGE = 60

type ArtifactFilter = { kind?: string; q?: string }

/** Which artifact fetch is current; a stale reply must not overwrite a newer one. */
let artifactsEpoch = 0
/** Serialised filter currently being fetched; dedupes same-tick requests. */
let artifactsInFlight: string | null = null

/** Canonical filter shape, so equal filters serialise identically. */
function sameFilter(filter: ArtifactFilter): ArtifactFilter {
  const kind = filter.kind || undefined
  const q = filter.q?.trim() || undefined
  return { ...(kind ? { kind } : {}), ...(q ? { q } : {}) }
}

const MODEL_STORAGE_KEY = 'kchat-models'

/** The picks this browser kept, under the account's own where it has any. */
function readRememberedModels(
  account: Partial<Record<SessionKind, string>> = {},
): Partial<Record<SessionKind, string>> | null {
  let local: Partial<Record<SessionKind, string>> = {}
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY)
    local = raw ? (JSON.parse(raw) as Partial<Record<SessionKind, string>>) : {}
  } catch {
    local = {}
  }
  const merged = { ...local, ...account }
  return Object.keys(merged).length ? merged : null
}

/** Keeps the picks on the account; a failure leaves the browser copy, which still works here. */
function rememberOnAccount(patch: Partial<Preferences>) {
  void auth.updateMe({ preferences: patch }).catch(() => {})
}

type AvMode = 'audio' | 'video'
const AV_MODEL_STORAGE_KEY = 'kchat-av-models'

function readRememberedAvModels(
  account: Partial<Record<AvMode, string>> = {},
): Partial<Record<AvMode, string>> {
  try {
    const raw = localStorage.getItem(AV_MODEL_STORAGE_KEY)
    return { ...(raw ? (JSON.parse(raw) as Partial<Record<AvMode, string>>) : {}), ...account }
  } catch {
    return { ...account }
  }
}

const initialAvModelByMode: Record<AvMode, string> = {
  audio: '',
  video: '',
  ...readRememberedAvModels(),
}

/** Per av mode: the remembered pick if still served, else the instance default, else the cheapest. Storage is never rewritten here. */
function reconcileAvModels(
  available: ModelInfo[],
  byMode: Partial<Record<AvMode, string>> = {},
  account: Partial<Record<AvMode, string>> = {},
): Record<AvMode, string> {
  const remembered = readRememberedAvModels(account)
  const next = { audio: '', video: '' }
  for (const mode of ['audio', 'video'] as const) {
    const usable = available
      .filter((m) => m.kinds.includes('av') && m.modality === mode)
      .sort((a, b) => a.creditCost - b.creditCost)
    const kept = remembered[mode]
    next[mode] =
      (kept && usable.some((m) => m.id === kept) ? kept : '') ||
      usable.find((m) => m.id === byMode[mode])?.id ||
      usable[0]?.id ||
      ''
  }
  return next
}

const initialModelByKind: Record<SessionKind, string> = (() => {
  const blank = { chat: '', report: '', slides: '', image: '', av: '' }
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || '{}') }
  } catch {
    return blank
  }
})()

// `system` is stored as-is, never the resolved colour, so the OS setting keeps applying.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

const initialTheme: Theme = (localStorage.getItem('kchat-theme') as Theme | null) ?? 'system'

let currentTheme: Theme = initialTheme

function applyTheme(theme: Theme) {
  currentTheme = theme
  const dark = theme === 'system' ? darkQuery.matches : theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  localStorage.setItem('kchat-theme', theme)
}
applyTheme(initialTheme)

darkQuery.addEventListener('change', () => {
  if (currentTheme === 'system') applyTheme('system')
})

const initialLang: Lang =
  (localStorage.getItem('kchat-lang') as Lang | null) ??
  (navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en')

function applyLang(lang: Lang) {
  document.documentElement.lang = lang
  localStorage.setItem('kchat-lang', lang)
}
applyLang(initialLang)

/** Silent refresh timer; the access token is memory-only and short-lived. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** Collapses concurrent refreshes: presenting the refresh cookie twice reads as token reuse. */
let inFlight: Promise<void> | null = null

function scheduleRefresh(expiresIn: number, run: () => void) {
  if (refreshTimer) clearTimeout(refreshTimer)
  // 60s of headroom, and never busier than once a minute.
  const delayMs = Math.max(30, expiresIn - 60) * 1000
  refreshTimer = setTimeout(run, delayMs)
}

function cancelRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
}

// Idle sign-out: the silent refresh would otherwise keep a session alive forever.
// `pointerdown`/`keydown`/`scroll` count as activity; `mousemove` does not.
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleTeardown: (() => void) | null = null

function armIdleWatch(minutes: number, onIdle: () => void) {
  disarmIdleWatch()
  if (minutes <= 0) return
  const limitMs = minutes * 60_000
  let lastSeen = Date.now()

  const fire = () => {
    disarmIdleWatch()
    onIdle()
  }
  const restart = () => {
    lastSeen = Date.now()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(fire, limitMs)
  }
  const onWake = () => {
    // Timers do not run while suspended; measure elapsed time on return.
    if (Date.now() - lastSeen >= limitMs) fire()
    else restart()
  }

  const events = ['pointerdown', 'keydown', 'scroll'] as const
  for (const name of events) window.addEventListener(name, restart, { passive: true })
  document.addEventListener('visibilitychange', onWake)
  window.addEventListener('focus', onWake)
  restart()

  idleTeardown = () => {
    for (const name of events) window.removeEventListener(name, restart)
    document.removeEventListener('visibilitychange', onWake)
    window.removeEventListener('focus', onWake)
  }
}

function disarmIdleWatch() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  idleTeardown?.()
  idleTeardown = null
}

/** A prompt sent to a job surface through chat goes back to the composer, where its options live. */
function handToTheComposer(set: Set, text: string) {
  set({ draft: text })
}

/**
 * Per surface: the remembered pick if the catalogue still serves it there, else the
 * surface/instance default, else the cheapest. Storage is never rewritten here.
 */
function reconcileDefaults(
  current: Record<SessionKind, string>,
  available: ModelInfo[],
  instanceDefault = '',
  byKind: Partial<Record<SessionKind, string>> = {},
  account: Partial<Record<SessionKind, string>> = {},
): Record<SessionKind, string> {
  const next = { ...current }
  const remembered = readRememberedModels(account)
  for (const kind of Object.keys(next) as SessionKind[]) {
    const kept = remembered?.[kind]
    if (kept && available.some((m) => m.id === kept && m.kinds.includes(kind))) {
      next[kind] = kept
      continue
    }
    if (available.some((m) => m.id === next[kind] && m.kinds.includes(kind))) continue
    const usable = available
      .filter((m) => m.kinds.includes(kind))
      // Cheapest first; a strict-local model only when nothing else serves the surface.
      .sort(
        (a, b) =>
          Number(a.strictLocal ?? false) - Number(b.strictLocal ?? false) ||
          a.creditCost - b.creditCost,
      )
    const preferred =
      usable.find((m) => m.id === byKind[kind]) ?? usable.find((m) => m.id === instanceDefault)
    if (preferred) next[kind] = preferred.id
    else if (usable.length) next[kind] = usable[0].id
  }
  return next
}

/** The model a turn will run on: session, then agent, then surface default (turn overrides excluded). */
export function effectiveModelId(
  session: Pick<Session, 'model' | 'agentId'> | undefined,
  kind: SessionKind,
  agents: Agent[],
  modelByKind: Record<SessionKind, string>,
): string {
  if (session?.model) return session.model
  const agent = session?.agentId ? agents.find((a) => a.id === session.agentId) : undefined
  return agent?.model || modelByKind[kind]
}

/** The model a media turn is sent with, honouring the conversation's own pick. */
function pickedModel(
  s: Pick<State, 'sessions' | 'agents' | 'modelByKind'>,
  sessionId: string,
  kind: SessionKind,
): string | undefined {
  const session = s.sessions.find((c) => c.id === sessionId)
  return effectiveModelId(session, kind, s.agents, s.modelByKind) || undefined
}

function reconcileCompareModels(current: string[], available: ModelInfo[]): string[] {
  const chatIds = available.filter((model) => model.kinds.includes('chat')).map((model) => model.id)
  const valid = current.filter((id, index) => chatIds.includes(id) && current.indexOf(id) === index)
  for (const id of chatIds) {
    if (valid.length >= 2) break
    if (!valid.includes(id)) valid.push(id)
  }
  return valid.slice(0, 3)
}

export const useStore = create<State>((set, get) => ({
  user: null,
  pendingDelete: null,
  mediaError: null,
  authenticated: false,
  authLoading: true,
  authError: null,
  signedOutReason: null,
  idleTimeoutMinutes: 0,
  dictationEnabled: false,

  bootstrap: async () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const session = await auth.refresh()
        setAccessToken(session.accessToken)
        set({ authenticated: true, user: session.user, authLoading: false, authError: null })
        void authConfig
          .get()
          .then((c) => {
            applyBrand(c.brand)
            set({
              brand: c.brand,
              enabledKinds: (c.enabledKinds ?? ['chat']) as SessionKind[],
              idleTimeoutMinutes: c.idleTimeoutMinutes ?? 0,
              dictationEnabled: Boolean(c.dictationEnabled),
            })
            armIdleWatch(c.idleTimeoutMinutes ?? 0, () => void get().logout('idle'))
          })
          .catch(() => {})
        scheduleRefresh(session.expiresIn, () => void get().bootstrap())
        void get().loadModels()
        void get().loadSessions()
        void get().loadWorkspace()
      } catch {
        cancelRefresh()
        disarmIdleWatch()
        setAccessToken(null)
        set({ authenticated: false, user: null, authLoading: false })
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  },

  login: async (email, password) => {
    set({ authError: null })
    try {
      const session = await auth.login(email, password)
      setAccessToken(session.accessToken)
      set({ authenticated: true, user: session.user, authLoading: false, signedOutReason: null })
      scheduleRefresh(session.expiresIn, () => void get().bootstrap())
      armIdleWatch(get().idleTimeoutMinutes, () => void get().logout('idle'))
      // `/models`, `/sessions` and the workspace are gated on `active`.
      if (session.user.status === 'active') {
        void get().loadModels()
        void get().loadSessions()
        void get().loadWorkspace()
      }
    } catch (err) {
      set({ authError: err instanceof ApiError ? err.detail : 'network_error' })
      throw err
    }
  },

  /** Session handed over by a mailed signup-verification link. */
  adoptSession: (session) => {
    setAccessToken(session.accessToken)
    set({ authenticated: true, user: session.user, authLoading: false, authError: null })
    scheduleRefresh(session.expiresIn, () => void get().bootstrap())
    void get().loadModels()
  },

  signup: async (email, password, name) => {
    set({ authError: null })
    try {
      const { user, session } = await auth.signup(email, password, name)
      if (session) {
        // `open` signup mode, or the bootstrap admin.
        setAccessToken(session.accessToken)
        set({ authenticated: true, user: session.user, authLoading: false })
        scheduleRefresh(session.expiresIn, () => void get().bootstrap())
        void get().loadModels()
      } else {
        // Pending: log in so the waiting screen has an identity to show.
        await get().login(email, password)
        set({ user })
      }
    } catch (err) {
      set({ authError: err instanceof ApiError ? err.detail : 'network_error' })
      throw err
    }
  },

  logout: async (reason) => {
    try {
      await auth.logout()
    } catch {
      // Already gone server-side; the local teardown is what matters.
    }
    cancelRefresh()
    disarmIdleWatch()
    setAccessToken(null)
    // Invalidates any workspace load still in flight for the previous account.
    touchWorkspace()
    set({
      authenticated: false,
      user: null,
      activeSessionId: null,
      authError: null,
      signedOutReason: reason ?? null,
      // Never leave one account's work on screen for the next.
      sessions: [],
      users: [],
      projects: [],
      artifacts: [],
      skills: [],
      skillStore: [],
      designs: [],
      designTemplates: [],
      promptTemplates: [],
      availableTools: [],
      memories: [],
      agents: [],
      connectors: [],
      connectorCatalog: [],
    })
  },

  refreshMe: async () => {
    try {
      const before = get().user?.status
      const user = await auth.me()
      set({ user })
      // The approval-waiting screen polls this; the screen it advances to needs a workspace.
      if (before !== 'active' && user.status === 'active') {
        void get().loadModels()
        void get().loadSessions()
        void get().loadWorkspace()
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) await get().bootstrap()
    }
  },

  updateProfile: async (patch) => {
    set({ user: await auth.updateMe(patch) })
  },
  changePassword: async (currentPassword, newPassword) => {
    await auth.changePassword(currentPassword, newPassword)
  },

  theme: initialTheme,
  toggleTheme: () => {
    const order: Theme[] = ['system', 'light', 'dark']
    const next = order[(order.indexOf(get().theme) + 1) % order.length]
    applyTheme(next)
    set({ theme: next })
  },
  lang: initialLang,
  toggleLang: () => {
    const next: Lang = get().lang === 'ko' ? 'en' : 'ko'
    applyLang(next)
    set({ lang: next })
  },
  // Three columns do not fit under ~1024px; start hidden there.
  sidebar: window.matchMedia('(min-width: 1024px)').matches ? 'full' : 'hidden',
  cycleSidebar: () =>
    set((s) => {
      // No rail on a narrow layout.
      const order: SidebarMode[] = window.matchMedia('(min-width: 1024px)').matches
        ? ['full', 'rail', 'hidden']
        : ['full', 'hidden']
      const at = order.indexOf(s.sidebar)
      return { sidebar: order[(at + 1) % order.length] ?? 'full' }
    }),

  users: [],
  usersLoading: false,
  models: [],
  modelsLoading: false,
  workspaceLoading: true,
  artifactsLoading: true,
  artifactsLoadingMore: false,
  artifactsHasMore: false,
  artifactFilter: {},
  artifactCounts: null,
  sessionsLoading: true,
  workspaceFailed: false,
  artifactsFailed: false,
  sessionsFailed: false,
  litellmAvailable: true,
  autoRouting: {
    enabled: false,
    available: false,
    reason: 'disabled',
    classifierModelId: null,
    economyModelIds: [],
    qualityAvailable: false,
    qualityReason: 'disabled',
    qualityModelIds: [],
  },

  sessions: [],
  jobs: [],
  projects: [],
  artifacts: [],
  skills: [],
  skillStore: [],
  skillStoreLoading: false,
  skillStoreError: false,
  designs: [],
  designTemplates: [],
  promptTemplates: [],
  availableTools: [],
  memories: [],
  agents: [],
  connectorCatalog: [],

  /** A partial failure still renders the rest. */
  loadWorkspace: async () => {
    const epoch = ++workspaceEpoch
    // Artifacts load through their own (deduplicated) action.
    void get().loadArtifacts({})
    const results = await Promise.allSettled([
      projectsApi.list(),
      skillsApi.list(),
      designsApi.list(),
      designTemplatesApi.list(),
      promptTemplatesApi.list(),
      memoryApi.list(),
      agentsApi.list(),
      connectorsApi.list(),
      connectorsApi.catalog(),
      toolsApi.list(),
    ])
    const [
      projects,
      skills,
      designs,
      designTemplates,
      promptTemplates,
      memories,
      agents,
      connectors,
      catalog,
      tools,
    ] = results
    if (epoch !== workspaceEpoch) return
    set((s) => ({
      workspaceLoading: false,
      workspaceFailed: results.some((r) => r.status === 'rejected'),
      projects: projects.status === 'fulfilled' ? projects.value.map(toProject) : s.projects,
      skills: skills.status === 'fulfilled' ? skills.value.map(toSkill) : s.skills,
      designs: designs.status === 'fulfilled' ? designs.value : s.designs,
      designTemplates:
        designTemplates.status === 'fulfilled' ? designTemplates.value : s.designTemplates,
      promptTemplates:
        promptTemplates.status === 'fulfilled' ? promptTemplates.value : s.promptTemplates,
      availableTools: tools.status === 'fulfilled' ? tools.value : s.availableTools,
      memories: memories.status === 'fulfilled' ? memories.value.map(toMemory) : s.memories,
      agents: agents.status === 'fulfilled' ? agents.value.map(toAgent) : s.agents,
      connectors:
        connectors.status === 'fulfilled' ? connectors.value.map(toConnector) : s.connectors,
      connectorCatalog: catalog.status === 'fulfilled' ? catalog.value : s.connectorCatalog,
    }))
  },

  usage: null,
  audit: null,
  loadUsage: async (days = 7) => {
    const report = await usageApi.report(days).catch(() => null)
    if (report) set({ usage: report })
  },
  apiKeys: null,
  loadApiKeys: async () => {
    const rows = await keysApi.list().catch(() => null)
    if (rows) set({ apiKeys: rows })
  },
  createApiKey: async (name) => {
    const row = await keysApi.create(name)
    set((s) => ({ apiKeys: [{ ...row, secret: null }, ...(s.apiKeys ?? [])] }))
    // The secret is returned once and never stored.
    return row.secret ?? null
  },
  revokeApiKey: async (id) => {
    await keysApi.revoke(id)
    set((s) => ({ apiKeys: (s.apiKeys ?? []).filter((k) => k.id !== id) }))
  },
  governance: null,
  loadGovernance: async () => {
    const policy = await usageApi.governance().catch(() => null)
    if (policy) set({ governance: policy })
  },
  setGovernance: async (patch) => {
    // Optimistic; the reload below is what the screen trusts.
    set((s) => (s.governance ? { governance: { ...s.governance, ...patch } } : s))
    const result = await usageApi.setGovernance(patch).catch(() => null)
    await get().loadGovernance()
    return result?.clearedMessages ?? 0
  },
  saveGovernance: async (patch) => {
    const result = await usageApi.setGovernance(patch)
    await get().loadGovernance()
    return result.clearedMessages
  },
  loadAudit: async () => {
    const rows = await usageApi.audit(200).catch(() => null)
    if (rows) set({ audit: rows })
  },

  loadModels: async () => {
    set({ modelsLoading: true })
    try {
      const {
        models: live,
        litellmAvailable,
        defaultChatModel,
        defaultModelByKind,
        defaultAvModelByMode,
        autoRouting,
      } = await modelsApi.list()
      set((s) => ({
        models: live,
        avModelByMode: reconcileAvModels(
          live,
          defaultAvModelByMode,
          s.user?.preferences.avModelByMode,
        ),
        litellmAvailable,
        autoRouting: autoRouting ?? {
          enabled: false,
          available: false,
          reason: 'disabled',
          classifierModelId: null,
          economyModelIds: [],
          qualityAvailable: false,
          qualityReason: 'disabled',
          qualityModelIds: [],
        },
        modelsLoading: false,
        modelByKind: reconcileDefaults(
          s.modelByKind,
          live,
          defaultChatModel,
          defaultModelByKind,
          s.user?.preferences.modelByKind,
        ),
        compareModels: reconcileCompareModels(s.compareModels, live),
      }))
      // An account with no picks of its own adopts this browser's, once; from then
      // on the account copy leads and every browser opens on the same model.
      const prefs = get().user?.preferences
      if (prefs && !Object.keys(prefs.modelByKind ?? {}).length) {
        const local = readRememberedModels()
        if (local) rememberOnAccount({ modelByKind: local, avModelByMode: readRememberedAvModels() })
      }
    } catch {
      // Keep what is loaded. `litellmAvailable` describes the list, not this request.
      set((s) => ({
        modelsLoading: false,
        litellmAvailable: s.models.length > 0 ? s.litellmAvailable : false,
      }))
    }
  },

  loadUsers: async () => {
    set({ usersLoading: true })
    try {
      set({ users: await adminApi.users(), usersLoading: false })
    } catch {
      set({ usersLoading: false })
    }
  },

  activeSessionId: null,
  running: {},
  modelByKind: initialModelByKind,
  avModelByMode: initialAvModelByMode,
  setModel: (kind, id) =>
    set((s) => {
      const next = { ...s.modelByKind, [kind]: id }
      localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(next))
      // An av pick is also remembered for its own mode.
      const modality = kind === 'av' ? s.models.find((m) => m.id === id)?.modality : undefined
      const byMode =
        modality === 'audio' || modality === 'video'
          ? { ...readRememberedAvModels(), [modality]: id }
          : undefined
      if (byMode) localStorage.setItem(AV_MODEL_STORAGE_KEY, JSON.stringify(byMode))
      // The pick follows the account, so the next browser opens on it too.
      const kept = { modelByKind: next, ...(byMode ? { avModelByMode: byMode } : {}) }
      if (s.user) rememberOnAccount(kept)
      return {
        modelByKind: next,
        ...(byMode ? { avModelByMode: { ...s.avModelByMode, ...byMode } } : {}),
        ...(s.user ? { user: { ...s.user, preferences: { ...s.user.preferences, ...kept } } } : {}),
      }
    }),
  setSessionModel: async (sessionId, modelId) => {
    const previous = get().sessions.find((session) => session.id === sessionId)
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === sessionId ? { ...c, model: modelId, routingMode: 'manual' } : c,
      ),
    }))
    try {
      await queueSessionPersistence(sessionId, () =>
        sessionsApi
          .update(sessionId, { model: modelId, routingMode: 'manual' })
          .then(() => undefined),
      )
    } catch {
      const current = get().sessions.find((session) => session.id === sessionId)
      if (previous && current?.model === modelId && current.routingMode === 'manual') {
        set((s) => ({
          sessions: s.sessions.map((session) =>
            session.id === sessionId ? previous : session,
          ),
        }))
      }
      void get().loadSessions()
    }
  },
  setSessionRoutingMode: async (sessionId, mode) => {
    const previous = get().sessions.find((session) => session.id === sessionId)?.routingMode
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === sessionId ? { ...session, routingMode: mode } : session,
      ),
    }))
    try {
      await queueSessionPersistence(sessionId, () =>
        sessionsApi.update(sessionId, { routingMode: mode }).then(() => undefined),
      )
    } catch (error) {
      const current = get().sessions.find((session) => session.id === sessionId)
      if (previous && current?.routingMode === mode) {
        set((s) => ({
          sessions: s.sessions.map((session) =>
            session.id === sessionId ? { ...session, routingMode: previous } : session,
          ),
        }))
      }
      void get().loadSessions()
      throw error
    }
  },
  setActiveSession: (id) => {
    const session = id ? get().sessions.find((s) => s.id === id) : null
    // Media already shown in the transcript does not also open the panel;
    // sessions with no messages predate message recording and still do.
    const shownInTranscript =
      (session?.kind === 'image' || session?.kind === 'av') && session.messageCount > 0
    const artifactId = shownInTranscript ? null : (session?.artifactId ?? null)
    set((state) => ({
      activeSessionId: id,
      openArtifactId: artifactId,
      // Comparison mode belongs to the conversation it was turned on in.
      compareMode: id === state.activeSessionId ? state.compareMode : false,
    }))
    // The panel needs the whole document, not the listing's card.
    const held = artifactId ? get().artifacts.find((a) => a.id === artifactId) : null
    if (artifactId && (!held || held.partial)) void get().refreshArtifact(artifactId)
  },

  loadSessions: async () => {
    try {
      const rows = await sessionsApi.list()
      set((s) => ({
        sessionsLoading: false,
        sessionsFailed: false,
        // The list carries no transcripts, so held messages are kept.
        sessions: rows.map((row) =>
          toSession(row, s.sessions.find((c) => c.id === row.id)?.messages),
        ),
      }))
    } catch {
      set({ sessionsLoading: false, sessionsFailed: true })
    }
  },

  openSession: async (id) => {
    try {
      const row = await sessionsApi.get(id)
      const session = toSession(row)
      set((s) => ({
        sessions: s.sessions.some((c) => c.id === id)
          ? s.sessions.map((c) => (c.id === id ? session : c))
          : [session, ...s.sessions],
      }))

      // A turn still running server-side is polled until its answer lands.
      void watchForTheAnswer(set, get, id)

      // Job cards are server rows, so a reload has to fetch them.
      const jobRows = await jobsApi.list(id).catch(() => null)
      if (jobRows) {
        set((s) => ({
          jobs: [
            ...jobRows.map(toJob),
            ...s.jobs.filter((j) => !jobRows.some((row) => row.id === j.id)),
          ],
        }))
        for (const job of jobRows) {
          if (job.status === 'running' || job.status === 'queued') void get().followJob(id, job.id)
        }
      }

      // Artifacts the transcript names by id must be in the store.
      const wanted = new Set<string>()
      if (session.artifactId) wanted.add(session.artifactId)
      for (const m of session.messages) for (const a of m.artifactIds ?? []) wanted.add(a)
      const missing = [...wanted].filter((a) => !get().artifacts.some((x) => x.id === a))
      if (missing.length === 0) return
      const rows = await Promise.all(missing.map((a) => artifactsApi.get(a).catch(() => null)))
      const found = rows.filter((r) => r !== null).map(toArtifact)
      if (found.length) set((s) => ({ artifacts: [...found, ...s.artifacts] }))
    } catch {
      // Deleted or not ours; the page renders its empty state.
    }
  },

  newSession: async (
    kind,
    { projectId = null, agentId = null, routingMode = 'manual' } = {},
  ) => {
    touchWorkspace()
    const row = await sessionsApi.create({
      kind,
      projectId,
      agentId,
      // A session model outranks the agent's, so an agent that pins one gets none here.
      model: get().agents.find((a) => a.id === agentId)?.model ? null : get().modelByKind[kind],
      routingMode,
    })
    const session = toSession(row, [])
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: session.id,
      openArtifactId: null,
      projects: projectId
        ? s.projects.map((p) =>
            p.id === projectId ? { ...p, sessionIds: [session.id, ...p.sessionIds] } : p,
          )
        : s.projects,
    }))
    return session.id
  },

  /** Entry point for all five surfaces; image and av hand off to their job/media paths. */
  send: async (sessionId, kind, text, opts = {}) => {
    // A retry resends the original turn's options, not just its sentence.
    const again = opts.retryOf ? sentWith.get(opts.retryOf) : undefined
    if (again) opts = { ...again, ...opts }
    const id = sessionId ?? (await get().newSession(kind, { projectId: opts.projectId ?? null }))
    await waitForSessionPersistence(id)
    // Chat keeps the originating composer until the first SSE event; other surfaces navigate at once.
    const acceptSession = () => opts.onSession?.(id)
    if (kind !== 'chat') acceptSession()

    // Snapshot before the optimistic turn: a 4xx means nothing was stored, so it is rolled back.
    const before = get().sessions.find((session) => session.id === id)
    const beforeArtifactIds = new Set(get().artifacts.map((artifact) => artifact.id))
    const beforeOpenArtifactId = get().openArtifactId
    const now = new Date().toISOString()
    const model =
      opts.model ??
      effectiveModelId(
        get().sessions.find((c) => c.id === id),
        kind,
        get().agents,
        get().modelByKind,
      )
    const userMsg: Message = {
      id: uid('m'),
      role: 'user',
      content: text,
      createdAt: now,
      attachments: opts.attachmentNames?.map((name, i) => ({
        id: opts.attachments?.[i],
        name,
        size: '',
        type: '',
      })),
      startedFrom: opts.startingTemplate
        ? { templateId: opts.startingTemplate.id, title: opts.startingTemplate.title }
        : undefined,
    }

    // A retry replaces what failed under the question; a stale id falls back to appending.
    const retryOf =
      opts.retryOf && before?.messages.some((m) => m.id === opts.retryOf)
        ? opts.retryOf
        : undefined
    sentWith.set(retryOf ?? userMsg.id, {
      webSearch: opts.webSearch,
      attachments: opts.attachments,
      attachmentNames: opts.attachmentNames,
      activatedSkillIds: opts.activatedSkillIds,
      renderTemplateId: opts.renderTemplateId,
      startingTemplate: opts.startingTemplate,
      approve: opts.approve,
      includeFigures: opts.includeFigures,
      plan: opts.plan,
      answers: opts.answers,
    })
    const rerun = (messages: Message[]): Message[] => {
      const at = messages.findIndex((m) => m.id === retryOf)
      return [
        ...messages.slice(0, at),
        { ...messages[at], failure: undefined, error: undefined },
      ]
    }

    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === id
          // `model` is not written back: empty means "deferring to the agent".
          ? {
              ...c,
              title: c.messages.length === 0 ? text.slice(0, 40) : c.title,
              updatedAt: now,
              messages: retryOf ? rerun(c.messages) : [...c.messages, userMsg],
              ...(opts.renderTemplateId ? { renderTemplateId: opts.renderTemplateId } : {}),
            }
          : c,
      ),
    }))

    const perform = async () => {
      if (kind === 'report') {
        await streamReport(
          set,
          get,
          id,
          text,
          model,
          opts.activatedSkillIds,
          opts.startingTemplate?.id,
          {
            approve: opts.approve,
            answers: opts.answers,
            webSearch: opts.webSearch,
            includeFigures: opts.includeFigures,
            attachments: opts.attachments,
            plan: opts.plan,
            renderTemplateId: opts.renderTemplateId,
          },
        )
        return id
      }

      if (kind === 'slides') {
        await streamDeck(
          set,
          get,
          id,
          text,
          model,
          opts.activatedSkillIds,
          opts.startingTemplate?.id,
          {
            approve: opts.approve,
            answers: opts.answers,
            webSearch: opts.webSearch,
            includeFigures: opts.includeFigures,
            attachments: opts.attachments,
            plan: opts.plan,
            renderTemplateId: opts.renderTemplateId,
          },
        )
        return id
      }

      if (kind === 'image') {
        // `generateImages` puts up its own turn; drop the optimistic bubble.
        dropMediaTurn(set, id, userMsg.id)
        await get().generateImages(id, text, { projectId: opts.projectId ?? null })
        return id
      }

      if (kind !== 'chat') {
        handToTheComposer(set, text)
        return id
      }

      if (get().running[id]) return id

      if (get().compareMode && get().compareModels.length >= 2) {
        await runComparison(set, get, id, text, {
          activatedSkillIds: opts.activatedSkillIds,
          startingTemplateId: opts.startingTemplate?.id,
          attachments: opts.attachments,
          attachmentNames: opts.attachmentNames,
          privacyAction: opts.privacyAction,
          privacyDecisionToken: opts.privacyDecisionToken,
          onAccepted: acceptSession,
        })
        return id
      }

      await streamTurn(set, get, id, text, model, {
        model: opts.model,
        retryOf,
        webSearch: opts.webSearch,
        attachments: opts.attachments,
        attachmentNames: opts.attachmentNames,
        activatedSkillIds: opts.activatedSkillIds,
        startingTemplateId: opts.startingTemplate?.id,
        privacyAction: opts.privacyAction,
        privacyDecisionToken: opts.privacyDecisionToken,
        onAccepted: acceptSession,
      })
      return id
    }

    try {
      return await perform()
    } catch (err) {
      if (err instanceof PrivacyDecisionError) err.sessionId = id
      if (isClientRefusal(err) && before) {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === id ? before : session,
          ),
          artifacts: state.artifacts.filter(
            (artifact) =>
              beforeArtifactIds.has(artifact.id) ||
              artifact.sessionId !== id ||
              !artifact.id.startsWith('a_'),
          ),
          openArtifactId: beforeOpenArtifactId,
        }))
      } else if (kind === 'chat') {
        // Other failures may already have server-side output; keep the session reachable.
        acceptSession()
      }
      throw err
    }
  },

  stopStreaming: (sessionId) => {
    // Told to the server first: it cannot otherwise tell 중단 from a closed tab.
    const abort = get().running[sessionId]
    if (!abort) return
    void sessionsApi.stop(sessionId).catch(() => undefined)
    abort()
  },

  setSessionTemplate: async (id, templateId) => {
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === id ? { ...c, renderTemplateId: templateId } : c,
      ),
    }))
    // `''` clears it; `null` on the wire reads as "field not mentioned".
    await sessionsApi
      .update(id, { renderTemplateId: templateId ?? '' })
      .catch(() => get().loadSessions())
  },

  moveSessionToProject: async (id, projectId) => {
    set((s) => ({
      sessions: s.sessions.map((c) => (c.id === id ? { ...c, projectId } : c)),
    }))
    await sessionsApi.update(id, { projectId }).catch(() => get().loadSessions())
  },

  renameSession: async (id, title) => {
    set((s) => ({ sessions: s.sessions.map((c) => (c.id === id ? { ...c, title } : c)) }))
    await sessionsApi.update(id, { title }).catch(() => get().loadSessions())
  },
  retryJob: async (job) => {
    // Jobs are video only; the failed card is dropped rather than duplicated.
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== job.id) }))
    await get().generateVideo(job.sessionId, job.prompt)
  },

  retryMediaTurn: async (sessionId, prompt) => {
    const kind = get().sessions.find((c) => c.id === sessionId)?.kind
    if (kind === 'image') await get().generateImages(sessionId, prompt)
    else if (kind === 'av') await get().generateAudio(sessionId, prompt)
  },

  generateVideo: async (sessionId, prompt, opts = {}) => {
    const { avOptions } = get()
    let id = sessionId
    if (!id) {
      try {
        id = await get().newSession('av', { projectId: opts.projectId ?? null })
      } catch (err) {
        set({ mediaError: errorMessage(err, '영상 작업을 시작하지 못했습니다.') })
        return
      }
      opts.onSession?.(id)
    }
    const { promptId } = beginMediaTurn(set, id, prompt, false)
    try {
      const job = await jobsApi.create(id, {
        prompt,
        model: pickedModel(get(), id, 'av'),
        resolution: avOptions.resolution,
        seconds: avOptions.durationSec,
        audio: avOptions.withAudio,
        aspect: avOptions.aspect,
      })
      set((s) => ({ jobs: [toJob(job), ...s.jobs.filter((j) => j.id !== job.id)] }))
      void get().followJob(id!, job.id)
    } catch (err) {
      dropMediaTurn(set, id!, promptId)
      set((s) => ({
        jobs: [
          {
            id: uid('j'),
            sessionId: id!,
            kind: 'av',
            status: 'failed',
            progress: 0,
            stage: '실패',
            creditsUsed: 0,
            creditsEstimated: 0,
            prompt,
            model: pickedModel(get(), id, 'av') ?? '',
            params: {
              resolution: avOptions.resolution,
              seconds: avOptions.durationSec,
              audio: avOptions.withAudio,
            },
            error: errorMessage(err, tr('영상 작업을 시작하지 못했습니다.')),
            createdAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          },
          ...s.jobs,
        ],
      }))
    }
  },
  followJob: async (sessionId, jobId) => {
    if (followedJobs.has(jobId)) return
    followedJobs.add(jobId)
    try {
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 4000))
        const rows = await jobsApi.list(sessionId).catch(() => null)
        if (!rows) continue
        const job = rows.find((j) => j.id === jobId)
        if (!job) return
        set((s) => ({
          jobs: s.jobs.map((j) => (j.id === jobId ? toJob(job) : j)),
        }))
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
          await get().loadArtifacts()
          // The worker wrote the delivery turn; re-read the transcript. The panel stays shut.
          if (job.artifactId) await get().openSession(sessionId)
          return
        }
      }
    } finally {
      followedJobs.delete(jobId)
    }
  },
  generateAudio: async (sessionId, prompt, opts = {}) => {
    const { avOptions } = get()
    let id = sessionId
    if (!id) {
      id = await get().newSession('av', { projectId: opts.projectId ?? null })
      opts.onSession?.(id)
    }
    // Audio returns inside this call: no job card.
    const { promptId, answerId } = beginMediaTurn(set, id, prompt, true)
    beginRun(set, id)
    try {
      const row = await sessionsApi.audio(id, {
        prompt,
        model: pickedModel(get(), id, 'av'),
        audioKind: avOptions.audioKind === 'music' ? 'music' : 'narration',
        voice: avOptions.voice,
        seconds: avOptions.durationSec,
      })
      set((s) => ({ artifacts: [toArtifact(row), ...s.artifacts] }))
      finishMediaTurn(set, id, answerId, [row.id], false)
      await get().loadSessions()
      // The server's rows carry the message ids and the settled charge.
      await get().openSession(id)
    } catch (err) {
      failMediaTurn(set, id, promptId, answerId, errorMessage(err, tr('오디오를 만들지 못했습니다.')))
    } finally {
      endRun(set, id)
    }
  },
  generateImages: async (sessionId, prompt, opts = {}) => {
    const { imageOptions, modelByKind } = get()
    let id = sessionId
    if (!id) {
      try {
        id = await get().newSession('image', { projectId: opts.projectId ?? null })
      } catch (err) {
        set({ mediaError: errorMessage(err, '이미지를 만들지 못했습니다.') })
        return
      }
      opts.onSession?.(id)
    }
    const { promptId, answerId } = beginMediaTurn(set, id, prompt, true)
    beginRun(set, id)
    // An image template is consumed by the turn; no session row ever holds it.
    const picked = get().pendingTemplate
    const templateId = picked?.kind === 'image' ? picked.id : undefined
    if (picked) set({ pendingTemplate: null })
    try {
      // A `figure` template goes to a language model as mermaid, drawn here with its source kept.
      const figure = picked?.kind === 'image' ? picked.figure : undefined
      if (figure) {
        try {
          const rows = [await drawFigure(id, prompt, figure, modelByKind.chat || undefined)]
          set((s) => ({ artifacts: [...rows.map(toArtifact), ...s.artifacts] }))
          finishMediaTurn(set, id, answerId, rows.map((row) => row.id), false)
          await get().loadSessions()
          await get().openSession(id)
        } catch (err) {
          // The drawing step's own sentences are ours to show; server text is not.
          const said =
            err instanceof ApiError
              ? errorMessage(err, tr('도식을 만들지 못했습니다.'))
              : err instanceof Error && err.message
                ? err.message
                : tr('도식을 만들지 못했습니다.')
          failMediaTurn(set, id, promptId, answerId, said)
        }
        return
      }
      const imageModel = pickedModel(get(), id, 'image')
      const rows = await sessionsApi.images(id, {
        prompt,
        model: imageModel,
        aspect: servedAspect(
          imageOptions.aspect,
          get().models.find((m) => m.id === imageModel),
        ),
        style: opts.raw ? '없음' : imageOptions.style,
        labels: imageOptions.labels,
        count: imageOptions.count,
        templateId,
        raw: opts.raw,
      })
      set((s) => ({ artifacts: [...rows.map(toArtifact), ...s.artifacts] }))
      finishMediaTurn(
        set,
        id,
        answerId,
        rows.map((row) => row.id),
        rows.length < imageOptions.count,
      )
      await get().loadSessions()
      // The server's rows carry the message ids and the settled charge.
      await get().openSession(id)
    } catch (err) {
      failMediaTurn(set, id, promptId, answerId, errorMessage(err, tr('이미지를 만들지 못했습니다.')))
    } finally {
      endRun(set, id)
    }
  },
  deleteSessions: async (payload) => {
    const { deleted } = await sessionsApi.deleteMany(payload)
    // `all` is resolved server-side. The artifacts those conversations made went with them.
    await get().loadSessions()
    set((s) => ({
      activeSessionId: null,
      jobs: payload.all ? [] : s.jobs,
    }))
    await get().loadArtifacts()
    return deleted
  },
  deleteSession: async (id) => {
    touchWorkspace()
    set((s) => ({
      sessions: s.sessions.filter((c) => c.id !== id),
      jobs: s.jobs.filter((j) => j.sessionId !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      projects: s.projects.map((p) => ({
        ...p,
        sessionIds: p.sessionIds.filter((x) => x !== id),
      })),
      // What the conversation made goes with it.
      artifacts: s.artifacts.filter((a) => a.sessionId !== id),
    }))
    await sessionsApi.remove(id).catch(() => get().loadSessions())
  },
  togglePinSession: async (id) => {
    const pinned = !get().sessions.find((c) => c.id === id)?.pinned
    set((s) => ({ sessions: s.sessions.map((c) => (c.id === id ? { ...c, pinned } : c)) }))
    await sessionsApi.update(id, { pinned }).catch(() => get().loadSessions())
  },
  /** Pressing the lit thumb withdraws it, so `null` travels as a value. */
  rateMessage: async (sessionId, messageId, rating) => {
    const before =
      get()
        .sessions.find((c) => c.id === sessionId)
        ?.messages.find((m) => m.id === messageId)?.liked ?? null
    const next = before === rating ? null : rating
    const show = (liked: 'up' | 'down' | null) =>
      set((s) => ({
        sessions: s.sessions.map((c) =>
          c.id === sessionId
            ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, liked } : m)),
              }
            : c,
        ),
      }))
    show(next)
    await sessionsApi.rate(messageId, next).catch(() => show(before))
  },

  compareMode: false,
  compareModels: [],
  toggleCompareMode: () => set((s) => ({ compareMode: !s.compareMode })),
  toggleCompareModel: (id) =>
    set((s) => {
      const has = s.compareModels.includes(id)
      if (has && s.compareModels.length <= 2) return s
      if (!has && s.compareModels.length >= 3) return s
      return {
        compareModels: has
          ? s.compareModels.filter((m) => m !== id)
          : [...s.compareModels, id],
      }
    }),
  chooseVariant: async (sessionId, messageId, model) => {
    // Sets this conversation's model only, never the surface default.
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === sessionId
          ? {
              ...c,
              model,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      model,
                      content: m.variants?.find((v) => v.model === model)?.content ?? m.content,
                      variants: m.variants?.map((v) => ({ ...v, chosen: v.model === model })),
                    }
                  : m,
              ),
            }
          : c,
      ),
    }))
    await sessionsApi
      .chooseVariant(sessionId, messageId, model)
      .catch(() => get().openSession(sessionId))
  },

  optionTemplate: null,
  setOptionTemplate: (optionTemplate) => set({ optionTemplate }),
  imageOptions: { aspect: '16:9', style: '자동', labels: 'auto', count: 1 },
  // A manual chip change drops the 서식 that authored the values.
  setImageOptions: (patch) =>
    set((s) => ({ imageOptions: { ...s.imageOptions, ...patch }, optionTemplate: null })),
  draft: '',
  setDraft: (draft) => set({ draft }),
  pendingAttachment: null,
  setPendingAttachment: (pendingAttachment) => set({ pendingAttachment }),
  composerRestore: null,
  setComposerRestore: (composerRestore) => set({ composerRestore }),
  notice: null,
  setNotice: (notice) => set({ notice }),
  pendingTemplate: null,
  setPendingTemplate: (pendingTemplate) => set({ pendingTemplate }),
  pendingStartingTemplate: null,
  setPendingStartingTemplate: (pendingStartingTemplate) => set({ pendingStartingTemplate }),
  brand: { name: 'KloudChat', logo: '' },
  refreshConfig: async () => {
    const c = await authConfig.get().catch(() => null)
    if (!c) return
    applyBrand(c.brand)
    set({
      brand: c.brand,
      enabledKinds: (c.enabledKinds ?? ['chat']) as SessionKind[],
      idleTimeoutMinutes: c.idleTimeoutMinutes ?? 0,
      dictationEnabled: Boolean(c.dictationEnabled),
    })
  },
  enabledKinds: ['chat', 'report', 'slides'],
  avOptions: {
    mode: 'video',
    aspect: '16:9',
    durationSec: 4,
    audioKind: 'narration',
    voice: 'alloy',
    resolution: '720p',
    withAudio: false,
  },
  setAvOptions: (patch) =>
    set((s) => {
      const avOptions = { ...s.avOptions, ...patch }
      // A manual chip change drops the 서식 that authored the values.
      const next = { avOptions, optionTemplate: null }
      if (!patch.mode) return next
      // The av model follows the mode unless the current one already suits it.
      const wanted = patch.mode === 'video' ? 'video' : 'audio'
      const current = s.models.find((m) => m.id === s.modelByKind.av)
      if (current?.modality === wanted) return next
      const usable = s.models
        .filter((m) => m.kinds.includes('av') && m.modality === wanted)
        .sort((a, b) => a.creditCost - b.creditCost)
      const chosen = usable.find((m) => m.id === s.avModelByMode[wanted]) ?? usable[0]
      if (!chosen) return next
      return { ...next, modelByKind: { ...s.modelByKind, av: chosen.id } }
    }),
  cancelJob: async (id) => {
    const before = get().jobs.find((j) => j.id === id)
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id
          ? { ...j, status: 'canceled', stage: '취소됨', finishedAt: new Date().toISOString() }
          : j,
      ),
    }))
    // Only a video job (has `resolution`) is a server row that can be cancelled.
    if (!before?.params || !('resolution' in before.params)) return
    try {
      const row = await jobsApi.cancel(id)
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? toJob(row) : j)) }))
    } catch (err) {
      set((s) => ({
        jobs: s.jobs.map((j) => (j.id === id ? before : j)),
        mediaError: errorMessage(err, '작업을 취소하지 못했습니다.'),
      }))
    }
  },

  openArtifactId: null,
  clearMediaError: () => set({ mediaError: null }),

  /** Refetches on open, so the panel never edits a stale copy. */
  openArtifact: (id) => {
    set({ openArtifactId: id })
    if (id) void get().refreshArtifact(id)
  },

  refreshArtifact: async (id) => {
    const row = await artifactsApi.get(id).catch(() => null)
    if (!row) return null
    const fresh = toArtifact(row)
    set((s) => ({
      artifacts: s.artifacts.some((a) => a.id === id)
        ? s.artifacts.map((a) => (a.id === id ? fresh : a))
        : [fresh, ...s.artifacts],
    }))
    return fresh
  },

  createProject: async (p) => {
    touchWorkspace()
    const row = await projectsApi.create(p)
    set((s) => ({ projects: [toProject(row), ...s.projects] }))
    return row.id
  },
  updateProject: async (id, patch) => {
    touchWorkspace()
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
    const row = await projectsApi.update(id, patch as never).catch(() => null)
    if (row) set((s) => ({ projects: s.projects.map((p) => (p.id === id ? toProject(row) : p)) }))
  },
  deleteMany: async (kind, ids) => {
    if (ids.length === 0) return 0
    touchWorkspace()
    const api = {
      projects: projectsApi,
      artifacts: artifactsApi,
      skills: skillsApi,
      agents: agentsApi,
      designs: designsApi,
      connectors: connectorsApi,
    }[kind]
    const { deleted } = await api.removeMany(ids)
    const gone = new Set(ids)
    set((s) => ({
      projects: kind === 'projects' ? s.projects.filter((r) => !gone.has(r.id)) : s.projects,
      artifacts: kind === 'artifacts' ? s.artifacts.filter((r) => !gone.has(r.id)) : s.artifacts,
      skills: kind === 'skills' ? s.skills.filter((r) => !gone.has(r.id)) : s.skills,
      agents: kind === 'agents' ? s.agents.filter((r) => !gone.has(r.id)) : s.agents,
      designs: kind === 'designs' ? s.designs.filter((r) => !gone.has(r.id)) : s.designs,
      connectors:
        kind === 'connectors' ? s.connectors.filter((r) => !gone.has(r.id)) : s.connectors,
      // The server detaches sessions rather than deleting them.
      sessions:
        kind === 'projects'
          ? s.sessions.map((c) => (c.projectId && gone.has(c.projectId) ? { ...c, projectId: null } : c))
          : s.sessions,
    }))
    if (kind === 'projects' || kind === 'designs') {
      // Projects and designs reference each other.
      await get().loadWorkspace()
    }
    // Gallery counts come from a separate query.
    if (kind === 'artifacts') await get().loadArtifacts()
    return deleted
  },

  deleteProject: async (id) => {
    touchWorkspace()
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      // The server detaches sessions rather than deleting them.
      sessions: s.sessions.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)),
    }))
    await projectsApi.remove(id).catch(() => get().loadWorkspace())
  },

  uploadFile: async (file, opts) => {
    touchWorkspace()
    const row = await filesApi.upload(file, opts)
    if (opts?.projectId) {
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === opts.projectId ? { ...p, files: [toProjectFile(row), ...p.files] } : p,
        ),
      }))
    }
    return row
  },
  addProjectUrl: async (projectId, url) => {
    touchWorkspace()
    const row = await filesApi.addProjectUrl(projectId, url)
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, files: [toProjectFile(row), ...p.files] } : p,
      ),
    }))
    return row
  },
  deleteFile: async (id) => {
    touchWorkspace()
    set((s) => ({
      projects: s.projects.map((p) => ({ ...p, files: p.files.filter((f) => f.id !== id) })),
    }))
    await filesApi.remove(id).catch(() => get().loadWorkspace())
  },

  ensureDesignTemplates: async () => {
    if (get().designTemplates.length > 0) return
    const rows = await designTemplatesApi.list().catch(() => null)
    if (rows) set({ designTemplates: rows })
  },
  loadArtifacts: async (filter) => {
    const next = sameFilter(filter ?? get().artifactFilter)
    const key = JSON.stringify(next)
    if (artifactsInFlight === key) return
    artifactsInFlight = key
    const epoch = ++artifactsEpoch
    // A new filter clears the grid at once rather than showing the old kind's cards.
    if (JSON.stringify(get().artifactFilter) !== key) {
      set({ artifacts: [], artifactsLoading: true, artifactFilter: next })
    }
    const [rows, counts] = await Promise.all([
      artifactsApi.list({ ...next, limit: ARTIFACT_PAGE }).catch(() => null),
      artifactsApi.counts(next.q).catch(() => null),
    ])
    if (artifactsInFlight === key) artifactsInFlight = null
    if (epoch !== artifactsEpoch) return
    set((s) => ({
      artifacts: rows ? mergeArtifacts(rows.map(toArtifact), s.artifacts) : s.artifacts,
      artifactFilter: next,
      artifactsHasMore: rows ? rows.length === ARTIFACT_PAGE : s.artifactsHasMore,
      artifactCounts: counts ? counts.counts : s.artifactCounts,
      artifactsLoading: false,
      artifactsFailed: rows === null,
    }))
  },
  /** Keyset paging: the order key moves on edit, so an offset would skip or repeat rows. */
  loadMoreArtifacts: async () => {
    const held = get().artifacts
    const last = held.at(-1)
    if (!last || get().artifactsLoadingMore) return
    set({ artifactsLoadingMore: true })
    const rows = await artifactsApi
      .list({
        ...get().artifactFilter,
        limit: ARTIFACT_PAGE,
        beforeAt: last.updatedAt,
        beforeId: last.id,
      })
      .catch(() => null)
    set((s) => ({
      artifacts: rows
        ? [
            ...s.artifacts,
            ...mergeArtifacts(rows.map(toArtifact), s.artifacts).filter(
              (row) => !s.artifacts.some((a) => a.id === row.id),
            ),
          ]
        : s.artifacts,
      artifactsHasMore: rows ? rows.length === ARTIFACT_PAGE : s.artifactsHasMore,
      artifactsLoadingMore: false,
    }))
  },
  deleteArtifact: async (id) => {
    touchWorkspace()
    const removed = get().artifacts.find((x) => x.id === id)
    set((s) => ({ artifacts: s.artifacts.filter((a) => a.id !== id) }))
    if (!removed) return
    const restore = () =>
      set((s) => ({
        artifacts: s.artifacts.some((x) => x.id === id) ? s.artifacts : [removed, ...s.artifacts],
        pendingDelete: null,
      }))
    await holdDelete(set, get, {
      label: nameOf(removed),
      restore,
      // Gallery counts come from a separate query.
      commit: () => artifactsApi.remove(id).then(() => get().loadArtifacts()).catch(() => get().loadArtifacts()),
    })
  },

  connectors: [],
  updateConnectorEnv: async (id, env) => {
    touchWorkspace()
    const row = await connectorsApi.update(id, { env }).catch(() => null)
    if (row) set((s) => ({ connectors: s.connectors.map((c) => (c.id === id ? toConnector(row) : c)) }))
    await get().syncConnector(id)
  },
  toggleConnector: async (id) => {
    touchWorkspace()
    const enabled = !get().connectors.find((c) => c.id === id)?.enabled
    set((s) => ({ connectors: s.connectors.map((c) => (c.id === id ? { ...c, enabled } : c)) }))
    const row = await connectorsApi.update(id, { enabled }).catch(() => null)
    if (row) set((s) => ({ connectors: s.connectors.map((c) => (c.id === id ? toConnector(row) : c)) }))
  },
  toggleConnectorTool: async (id, tool) => {
    touchWorkspace()
    const current = get()
      .connectors.find((c) => c.id === id)
      ?.tools.find((t) => t.name === tool)
    const row = await connectorsApi.toggleTool(id, tool, !current?.enabled).catch(() => null)
    if (row) set((s) => ({ connectors: s.connectors.map((c) => (c.id === id ? toConnector(row) : c)) }))
  },
  installConnector: async (slug, env) => {
    touchWorkspace()
    const row = await connectorsApi.install(slug, env)
    set((s) => ({
      connectors: [toConnector(row), ...s.connectors.filter((c) => c.id !== row.id)],
      connectorCatalog: s.connectorCatalog.map((e) =>
        e.slug === slug ? { ...e, installed: true } : e,
      ),
    }))
  },
  uninstallConnector: async (id) => {
    touchWorkspace()
    const slug = get().connectors.find((c) => c.id === id)?.slug
    set((s) => ({
      connectors: s.connectors.filter((c) => c.id !== id),
      connectorCatalog: s.connectorCatalog.map((e) =>
        e.slug === slug ? { ...e, installed: false } : e,
      ),
    }))
    await connectorsApi.uninstall(id).catch(() => get().loadWorkspace())
  },
  syncConnector: async (id) => {
    touchWorkspace()
    const row = await connectorsApi.sync(id).catch(() => null)
    if (row) set((s) => ({ connectors: s.connectors.map((c) => (c.id === id ? toConnector(row) : c)) }))
  },
  addCustomConnector: async (c) => {
    touchWorkspace()
    const row = await connectorsApi.addCustom({
      name: c.name,
      transport: c.transport,
      endpoint: c.endpoint,
      auth: c.auth,
      env: c.env,
      description: '직접 등록한 MCP 서버',
    })
    set((s) => ({ connectors: [toConnector(row), ...s.connectors] }))
  },

  toggleSkill: async (id) => {
    touchWorkspace()
    set((s) => ({
      skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)),
    }))
    const row = await skillsApi.toggle(id).catch(() => null)
    if (row) set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? toSkill(row) : sk)) }))
  },
  upsertSkill: async (skill) => {
    touchWorkspace()
    const payload = {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      body: (skill as Skill & { body?: string }).body ?? '',
      kinds: skill.kinds,
      requiredTools: skill.requiredTools,
      enabled: skill.enabled,
      visibility: skill.visibility,
    }
    const exists = get().skills.some((s) => s.id === skill.id)
    const row = exists ? await skillsApi.update(skill.id, payload) : await skillsApi.create(payload)
    set((s) => ({
      skills: exists
        ? s.skills.map((x) => (x.id === skill.id ? toSkill(row) : x))
        : [toSkill(row), ...s.skills],
    }))
  },
  loadSkillStore: async () => {
    set({ skillStoreLoading: true, skillStoreError: false })
    const rows = await skillsApi.store().catch(() => null)
    set((st) => ({
      skillStore: rows ? rows.map(toStoreSkill) : st.skillStore,
      skillStoreError: rows === null,
      skillStoreLoading: false,
    }))
  },
  installSkill: async (id) => {
    touchWorkspace()
    const row = await skillsApi.install(id)
    const copy = toSkill(row)
    set((st) => ({
      // Install is idempotent server-side; a double press returns the held copy.
      skills: st.skills.some((x) => x.id === copy.id)
        ? st.skills.map((x) => (x.id === copy.id ? copy : x))
        : [copy, ...st.skills],
      skillStore: st.skillStore.map((x) => (x.id === id ? { ...x, installed: true } : x)),
    }))
  },
  deleteSkill: async (id) => {
    touchWorkspace()
    const removed = get().skills.find((x) => x.id === id)
    set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) }))
    if (!removed) return
    const restore = () =>
      set((s) => ({
        skills: s.skills.some((x) => x.id === id) ? s.skills : [removed, ...s.skills],
        pendingDelete: null,
      }))
    await holdDelete(set, get, {
      label: nameOf(removed),
      restore,
      commit: () => skillsApi.remove(id).catch(() => get().loadWorkspace()),
    })
  },

  upsertMemory: async (m) => {
    touchWorkspace()
    const payload = {
      name: m.name,
      description: m.description,
      type: m.type,
      body: m.body,
      scope: m.scope,
      links: m.links,
      pinned: m.pinned,
    }
    const exists = get().memories.some((x) => x.id === m.id)
    const row = exists ? await memoryApi.update(m.id, payload) : await memoryApi.create(payload)
    set((s) => ({
      memories: exists
        ? s.memories.map((x) => (x.id === m.id ? toMemory(row) : x))
        : [toMemory(row), ...s.memories],
    }))
  },
  deleteMemory: async (id) => {
    touchWorkspace()
    const removed = get().memories.find((x) => x.id === id)
    set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }))
    if (!removed) return
    const restore = () =>
      set((s) => ({
        memories: s.memories.some((x) => x.id === id) ? s.memories : [removed, ...s.memories],
        pendingDelete: null,
      }))
    await holdDelete(set, get, {
      label: nameOf(removed),
      restore,
      commit: () => memoryApi.remove(id).catch(() => get().loadWorkspace()),
    })
  },
  togglePinMemory: async (id) => {
    touchWorkspace()
    set((s) => ({
      memories: s.memories.map((m) => (m.id === id ? { ...m, pinned: !m.pinned } : m)),
    }))
    const row = await memoryApi.pin(id).catch(() => null)
    if (row) set((s) => ({ memories: s.memories.map((m) => (m.id === id ? toMemory(row) : m)) }))
  },

  installAgent: async (a) => {
    touchWorkspace()
    // The server copies the agent and its shared skills; the author's knowledge files stay behind.
    const row = await agentsApi.install(a.id)
    const copy = toAgent(row)
    set((s) => ({
      agents: s.agents.some((x) => x.id === copy.id)
        ? s.agents.map((x) => (x.id === copy.id ? copy : x))
        : [copy, ...s.agents],
    }))
    // The original's install count and `installed` flag moved.
    await get().loadWorkspace()
  },
  upsertAgent: async (a) => {
    touchWorkspace()
    const payload = {
      name: a.name,
      slug: a.slug,
      description: a.description,
      model: a.model,
      systemPrompt: a.systemPrompt,
      tools: a.tools,
      skillIds: a.skillIds,
      kinds: a.kinds,
      guide: a.guide,
      starters: a.starters.map((x) => x.trim()).filter(Boolean),
      shareMode: a.shareMode,
      temperature: a.temperature,
      color: a.color,
      enabled: a.enabled,
      visibility: a.visibility,
    }
    const exists = get().agents.some((x) => x.id === a.id)
    const row = exists ? await agentsApi.update(a.id, payload) : await agentsApi.create(payload)
    set((s) => ({
      agents: exists
        ? s.agents.map((x) => (x.id === a.id ? toAgent(row) : x))
        : [toAgent(row), ...s.agents],
    }))
  },
  deleteAgent: async (id) => {
    touchWorkspace()
    const removed = get().agents.find((x) => x.id === id)
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }))
    if (!removed) return
    const restore = () =>
      set((s) => ({
        agents: s.agents.some((x) => x.id === id) ? s.agents : [removed, ...s.agents],
        pendingDelete: null,
      }))
    await holdDelete(set, get, {
      label: nameOf(removed),
      restore,
      commit: () => agentsApi.remove(id).catch(() => get().loadWorkspace()),
    })
  },

  approveUser: (id, monthlyCredits) => applyUserChange(set, adminApi.approve(id, monthlyCredits)),
  rejectUser: (id) => applyUserChange(set, adminApi.reject(id)),
  suspendUser: (id) => applyUserChange(set, adminApi.suspend(id)),
  reinstateUser: (id) => applyUserChange(set, adminApi.reinstate(id)),
  rotateLitellmKey: (id) => applyUserChange(set, adminApi.rotateLitellmKey(id)),
  setUserModels: (id, models) => applyUserChange(set, adminApi.setUserModels(id, models)),
  removeUser: async (id, purgeFiles = true) => {
    await adminApi.removeUser(id, purgeFiles)
    set((s) => ({ users: s.users.filter((u) => u.id !== id) }))
  },
  setUserCredits: (id, monthlyCredits) =>
    applyUserChange(set, adminApi.setCredits(id, monthlyCredits)),
  updateUser: (id, patch) => applyUserChange(set, adminApi.updateUser(id, patch)),
  resetUserPassword: (id, password) => applyUserChange(set, adminApi.resetPassword(id, password)),
  replaceLitellmKey: (id, key) => applyUserChange(set, adminApi.replaceLitellmKey(id, key)),
}))

/** Admin mutations return the updated row; a self-edit also updates `user`. */
async function applyUserChange(set: Set, pending: Promise<User>) {
  const updated = await pending
  set((s) => ({
    users: s.users.map((u) => (u.id === updated.id ? updated : u)),
    user: s.user?.id === updated.id ? updated : s.user,
  }))
}

/* ── helpers ─────────────────────────────────────────────────────────── */

type Set = (u: Partial<State> | ((s: State) => Partial<State>)) => void
type Get = () => State

/** The UI's step categories; anything else is a tool call. */
const STEP_TYPES = new Set<Step['type']>(['thinking', 'tool', 'artifact'])

/** Every turn ends with `usage` or `error`; a stream that ends with neither was cut off. */
const CUT_OFF = '연결이 끊겨 답변이 중간에 멈췄습니다. 다시 시도해 주세요.'

/** Why the turn failed, in a sentence somebody can act on. */
function turnFailure(err: unknown): string {
  if (err instanceof StreamStalledError) {
    return '모델이 응답하지 않아 요청을 중단했습니다. 다른 모델로 다시 생성해 보세요.'
  }
  // Already translated by lib/failures.ts.
  const named =
    err instanceof ApiError && err.status < 500 ? refusalSentence(errorCode(err), tr) : undefined
  if (named) return named
  if (err instanceof ApiError && err.status >= 500) {
    return '모델 서버가 응답하지 않습니다. 잠시 후 다시 시도하세요.'
  }
  return '응답을 받지 못했습니다. 잠시 후 다시 시도하세요.'
}

/** Undo window for single deletes; leaving the page flushes pending ones. */
const UNDO_MS = 6_000

/** Swaps the local answer id for the server's once `done` names it, so later ratings and choices resolve. */
function adoptServerId(set: Set, sessionId: string, localId: string, serverId: string) {
  if (localId === serverId) return
  set((s) => ({
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? { ...c, messages: c.messages.map((m) => (m.id === localId ? { ...m, id: serverId } : m)) }
        : c,
    ),
  }))
}

/** Deletes whose requests have not been sent yet, so the page can flush them. */
const pendingDeletes = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const flush of pendingDeletes) flush()
    pendingDeletes.clear()
  })
}

/** Whatever the row calls itself: artifacts have titles, the rest have names. */
function nameOf(row: { title?: string; name?: string }): string {
  return row.title ?? row.name ?? ''
}

type HeldDelete = { label: string; restore: () => void; commit: () => Promise<unknown> }

/** Removes the row from the screen now and sends the request after the undo window. */
async function holdDelete(
  set: Set,
  get: Get,
  { label, restore, commit }: HeldDelete,
) {
  let cancelled = false
  const send = () => {
    pendingDeletes.delete(send)
    if (cancelled) return
    void commit()
  }
  pendingDeletes.add(send)
  const timer = window.setTimeout(send, UNDO_MS)

  set({
    pendingDelete: {
      label,
      undo: () => {
        cancelled = true
        window.clearTimeout(timer)
        pendingDeletes.delete(send)
        restore()
      },
    },
  })

  window.setTimeout(() => {
    if (get().pendingDelete?.label === label) set({ pendingDelete: null })
  }, UNDO_MS)
}

function toStep(raw: Record<string, unknown>): Step {
  // `raw.type` is the event name ("step"); the UI category arrives as `category` when the server sets one.
  const category = (raw.category ?? raw.type) as Step['type']
  const step: Step = {
    id: String(raw.id ?? uid('step')),
    type: STEP_TYPES.has(category) ? category : 'tool',
    label: String(raw.label ?? ''),
    status: (raw.status as Step['status']) ?? 'done',
    detail: raw.detail as string | undefined,
    progress: raw.progress as Step['progress'],
    skills: raw.skills as Step['skills'],
    memories: raw.memories as Step['memories'],
    files: raw.files as Step['files'],
    memoriesWritten: raw.memoriesWritten as number | undefined,
    totalMemories: raw.totalMemories as number | undefined,
    personal: raw.personal as string[] | undefined,
    estimatedTokens: raw.estimatedTokens as number | undefined,
  }
  // Stored labels are Korean; rebuilt here in the current language from the structured fields.
  return { ...step, ...retold(step) }
}

/** Names printed before a line switches to counting. */
const NAMES_SHOWN = 6

function named(names: string[], more: '외 {n}건' | '외 {n}개'): string {
  const shown = names.slice(0, NAMES_SHOWN).join(' · ')
  return names.length > NAMES_SHOWN
    ? `${shown} ${tr(more).replace('{n}', String(names.length - NAMES_SHOWN))}`
    : shown
}

function retold(step: Step): Partial<Step> {
  if (step.personal) {
    return {
      label: tr('개인 맞춤 설정 적용'),
      detail: step.personal.map((part) => tr(part)).join(' · '),
    }
  }
  if (step.memoriesWritten !== undefined) {
    return {
      label: tr('메모리 {n}건 저장').replace('{n}', String(step.memoriesWritten)),
      detail: tr('자동 메모리에 추가됨'),
    }
  }
  if (step.memories) {
    const detail = named(step.memories, '외 {n}건')
    return {
      label: tr('메모리 {n}건 참고').replace('{n}', String(step.memories.length)),
      detail:
        step.totalMemories && step.totalMemories > step.memories.length
          ? `${detail} · ${tr('저장된 {total}건 중 최근 {n}건')
              .replace('{total}', String(step.totalMemories))
              .replace('{n}', String(step.memories.length))}`
          : detail,
    }
  }
  if (step.files) {
    const subject =
      step.id === 'context-knowledge'
        ? tr('프로젝트 지식')
        : step.id === 'context-earlier'
          ? tr('이전 턴 첨부')
          : tr('첨부 파일')
    const short = step.files.filter((file) => file.state !== 'included')
    const cut = short.filter((file) => file.state === 'truncated').length
    const dropped = short.length - cut
    const fates = [
      ...(cut ? [tr('{n}개 잘림').replace('{n}', String(cut))] : []),
      ...(dropped ? [tr('{n}개 빠짐').replace('{n}', String(dropped))] : []),
    ]
    const note = (file: NonNullable<Step['files']>[number]) =>
      file.state === 'truncated'
        ? tr('{name} {kept}자만 반영')
            .replace('{name}', file.name)
            .replace('{kept}', file.keptChars.toLocaleString())
        : tr(file.state === 'omitted' ? '{name} 분량을 넘겨 제외' : '{name} 읽지 못함').replace(
            '{name}',
            file.name,
          )
    return {
      label: fates.length
        ? `${tr('{subject} {n}개 중').replace('{subject}', subject).replace('{n}', String(step.files.length))} ${fates.join(', ')}`
        : tr('{subject} {n}개 반영')
            .replace('{subject}', subject)
            .replace('{n}', String(step.files.length)),
      detail: named(
        short.length ? short.map(note) : step.files.map((file) => file.name),
        '외 {n}개',
      ),
    }
  }
  return {}
}

function appliedSkillsStep(event: {
  skills: {
    id: string
    name: string
    catalogKey: string | null
    estimatedTokens: number
  }[]
  estimatedTokens?: number
}): Step {
  const total =
    event.estimatedTokens ??
    event.skills.reduce((sum, skill) => sum + (skill.estimatedTokens || 0), 0)
  return {
    id: 'skills-applied',
    type: 'thinking',
    label: tr('스킬 {n}개 적용').replace('{n}', String(event.skills.length)),
    status: 'done',
    detail: `${event.skills.map((skill) => tr(skill.name)).join(' · ')} · ${tr('약 {n} 토큰').replace(
      '{n}',
      total.toLocaleString(),
    )}`,
    skills: event.skills,
    estimatedTokens: total,
  }
}

function upsertStep(steps: Step[] | undefined, step: Step): Step[] {
  const current = steps ?? []
  return current.some((item) => item.id === step.id)
    ? current.map((item) => (item.id === step.id ? step : item))
    : [...current, step]
}

function toMessage(raw: MessageRow): Message {
  return {
    id: raw.id,
    role: raw.role,
    content: raw.content,
    createdAt: raw.createdAt,
    model: raw.model,
    routing: raw.routing ?? undefined,
    steps: raw.steps?.map((s) => toStep(s as Record<string, unknown>)),
    attachments: raw.attachments?.map((a) =>
      typeof a === 'string'
        ? { name: a, size: '', type: '' }
        : (a as { id?: string; name: string; size: number | string; type: string }),
    ),
    usage: raw.usage ?? undefined,
    startedFrom: raw.startedFrom ?? undefined,
    artifactIds: raw.artifactIds ?? undefined,
    failure: raw.failure ?? undefined,
    liked: raw.rating ?? null,
    variants: raw.variants?.map((v) => ({
      model: v.model,
      routedModel: v.routedModel,
      actualModel: v.actualModel,
      dataBoundary: v.dataBoundary,
      content: v.content,
      status: v.error ? ('error' as const) : ('done' as const),
      chosen: v.chosen ?? false,
      usage: v.usage
        ? { ...v.usage, credits: v.credits }
        : { inputTokens: 0, outputTokens: 0, credits: v.credits },
    })),
  }
}

function toSession(raw: SessionRow, keepMessages?: Message[]): Session {
  return {
    id: raw.id,
    kind: raw.kind,
    title: raw.title || tr('새 작업'),
    projectId: raw.projectId,
    agentId: raw.agentId,
    model: raw.model,
    routingMode: raw.routingMode ?? 'manual',
    artifactId: raw.artifactId,
    pending: raw.pending ?? null,
    renderTemplateId: raw.renderTemplateId ?? null,
    pinned: raw.pinned,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    messages: raw.messages ? raw.messages.map(toMessage) : (keepMessages ?? []),
    preview: raw.preview,
    messageCount: raw.messageCount,
    made: raw.made ?? null,
  }
}

/* ── wire row → component shape ──────────────────────────────────────── */

const bytes = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

function toProjectFile(f: FileRow): ProjectFile {
  return {
    id: f.id,
    name: f.name,
    size: bytes(f.size),
    type: f.mime || f.name.split('.').pop() || '',
    addedAt: f.createdAt,
    tokens: f.tokens,
    sourceUrl: f.sourceUrl,
    preview: f.preview,
    error: f.error,
  }
}

function toProject(p: ProjectRow): Project {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    emoji: p.emoji,
    instructions: p.instructions,
    files: p.files.map(toProjectFile),
    sessionIds: p.sessionIds,
    skillIds: p.skillIds,
    designSystemId: p.designSystemId ?? null,
    renderTemplates: p.renderTemplates ?? {},
    updatedAt: p.updatedAt,
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: (row.kind as Job['kind']) ?? 'av',
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    creditsUsed: row.creditsUsed,
    creditsEstimated: row.creditsEstimated,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    prompt: row.prompt ?? '',
    model: row.model ?? '',
    params: row.params ?? null,
  }
}

function toArtifact(a: ArtifactRow): Artifact {
  return {
    id: a.id,
    title: a.title,
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    sessionId: a.sessionId,
    projectId: a.projectId,
    kind: a.kind,
    // `data` holds the kind-specific body, which the union carries at the top level.
    ...(a.data ?? {}),
    // After the spread, so a body carrying the key cannot decide it.
    partial: a.partial === true,
  } as Artifact
}

/** Listing cards laid over held full copies: a full body wins while its version matches. */
function mergeArtifacts(incoming: Artifact[], held: Artifact[]): Artifact[] {
  const byId = new Map(held.map((a) => [a.id, a]))
  return incoming.map((row) => {
    const mine = byId.get(row.id)
    if (!row.partial || !mine || mine.partial) return row
    return {
      ...mine,
      title: row.title,
      version: row.version,
      updatedAt: row.updatedAt,
      sessionId: row.sessionId,
      projectId: row.projectId,
      partial: mine.version !== row.version,
    } as Artifact
  })
}

function toSkill(s: SkillRow): Skill {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    whenToUse: s.whenToUse,
    body: s.body ?? '',
    catalogKey: s.catalogKey ?? null,
    requiredTools: s.requiredTools ?? [],
    estimatedTokens: s.estimatedTokens ?? 0,
    source: (s.source as Skill['source']) ?? 'personal',
    kinds: (s.kinds ?? []) as SessionKind[],
    enabled: s.enabled,
    visibility: (s.visibility as Skill['visibility']) ?? 'private',
    installs: s.installs ?? 0,
    originId: s.originId ?? null,
    version: s.version,
    updatedAt: s.updatedAt,
  }
}

function toStoreSkill(s: StoreSkillRow): StoreSkill {
  return {
    ...toSkill(s),
    ownerId: s.ownerId,
    ownerName: s.ownerName,
    official: s.official ?? false,
    installed: s.installed ?? false,
  }
}

function toMemory(m: MemoryRow): MemoryEntry {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    type: m.type as MemoryEntry['type'],
    body: m.body,
    scope: m.scope,
    links: m.links,
    pinned: m.pinned,
    updatedAt: m.updatedAt,
  }
}

function toAgent(a: AgentRow): Agent {
  return {
    ownerId: a.ownerId,
    ownerName: a.ownerName,
    id: a.id,
    name: a.name,
    slug: a.slug,
    description: a.description,
    model: a.model,
    systemPrompt: a.systemPrompt,
    tools: a.tools,
    skillIds: a.skillIds,
    kinds: a.kinds as SessionKind[],
    guide: a.guide ?? '',
    starters: a.starters ?? [],
    shareMode: a.shareMode ?? 'open',
    sealed: a.sealed ?? false,
    temperature: a.temperature,
    color: a.color,
    enabled: a.enabled,
    visibility: a.visibility as Agent['visibility'],
    installs: a.installs,
    catalogKey: a.catalogKey ?? null,
    originId: a.originId ?? null,
    official: a.official ?? false,
    installed: a.installed ?? false,
    runs: a.runs,
    hasKnowledge: a.hasKnowledge,
    updatedAt: a.updatedAt,
  }
}

function toConnector(c: ConnectorRow): Connector {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    category: c.category,
    transport: c.transport as Connector['transport'],
    endpoint: c.endpoint,
    auth: c.auth as Connector['auth'],
    status: c.status as Connector['status'],
    installed: c.installed,
    enabled: c.enabled,
    kinds: c.kinds as SessionKind[],
    tools: c.tools.map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      enabled: t.enabled,
    })),
    envKeys: c.envKeys ?? [],
    official: c.official,
    icon: '🔌',
    color: '#6b7280',
    lastSyncAt: c.lastSyncAt,
    error: c.error ?? undefined,
  }
}

/** One chat turn: an empty assistant message is filled in place as events arrive. */
async function streamTurn(
  set: Set,
  get: Get,
  sessionId: string,
  text: string,
  model: string,
  opts: {
    /** Turn-only model override. */
    model?: string
    webSearch?: WebSearchSetting
    attachments?: string[]
    attachmentNames?: string[]
    activatedSkillIds?: string[]
    startingTemplateId?: string
    privacyAction?: PrivacyAction
    privacyDecisionToken?: string
    retryOf?: string
    onAccepted?: () => void
  } = {},
) {
  let assistantId = uid('m')
  const controller = new AbortController()

  set((s) => ({
    running: { ...s.running, [sessionId]: () => controller.abort() },
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? {
            ...c,
            messages: [
              ...c.messages,
              {
                id: assistantId,
                role: 'assistant',
                content: '',
                model,
                createdAt: new Date().toISOString(),
                steps: [],
              } as Message,
            ],
          }
        : c,
    ),
  }))

  const patch = (fn: (m: Message) => Message) =>
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === sessionId
          ? { ...c, messages: c.messages.map((m) => (m.id === assistantId ? fn(m) : m)) }
          : c,
      ),
    }))

  // With streaming off, text is buffered and shown in one piece; steps stay live.
  const live = get().user?.preferences.streamResponses !== false
  let buffered = ''

  // Whether the turn ended with `usage`/`error`. See CUT_OFF.
  let settled = false
  let artifactAnnounced = false
  let accepted = false

  try {
    for await (const event of streamSession(
      sessionId,
      {
        content: text,
        model: opts.model,
        webSearch: opts.webSearch,
        attachments: opts.attachments,
        activatedSkillIds: opts.activatedSkillIds,
        startingTemplateId: opts.startingTemplateId,
        privacyAction: opts.privacyAction,
        privacyDecisionToken: opts.privacyDecisionToken,
        retryOf: opts.retryOf,
      },
      controller.signal,
    )) {
      if (!accepted) {
        accepted = true
        opts.onAccepted?.()
      }
      switch (event.type) {
        case 'freshness_abstention':
        case 'tool_result_answer': {
          const { type: _type, ...origin } = event
          patch((m) => {
            // Keep privacy decisions, but a previously selected model did not author this answer.
            const previous = m.routing && 'action' in m.routing ? m.routing : undefined
            const { costRouting: _costRouting, ...privacy } = previous ?? {}
            return { ...m, model: null, routing: { ...privacy, ...origin } }
          })
          break
        }
        case 'privacy_route':
          if ('findingCounts' in event && event.findingCounts?.length) {
            const { type: _type, ...routing } = event
            markPrompt(set, sessionId, routing)
          }
          patch((m) => ({
            ...m,
            model:
              'actualModel' in event && event.actualModel
                ? event.actualModel
                : 'effectiveModels' in event
                  ? event.effectiveModels[0]
                  : m.model,
            routing:
              'effectiveModels' in event
                ? {
                    ...event,
                    costRouting:
                      m.routing && 'action' in m.routing
                        ? m.routing.costRouting ?? event.costRouting
                        : event.costRouting,
                  }
                : m.routing && 'action' in m.routing
                  ? {
                      ...m.routing,
                      initialAction: m.routing.initialAction ?? m.routing.action,
                      action: event.action,
                      toolOutputMasked: event.count,
                    }
                  : m.routing,
          }))
          break
        case 'model_route': {
          // Only the adaptive-routing event carries this complete shape.
          if (!event.decision || !event.requestedModel || !event.selectedModel) break
          const { type: _type, ...costRouting } = event
          patch((m) => ({
            ...m,
            model: event.executedModel ?? event.selectedModel,
            routing: m.routing && 'action' in m.routing
              ? { ...m.routing, costRouting }
              : {
                  requestedModels: [event.requestedModel],
                  routedModels: [event.selectedModel],
                  effectiveModels: [event.selectedModel],
                  actualModels: event.executedModel ? [event.executedModel] : [],
                  actualModel: event.executedModel,
                  action: 'none',
                  dataBoundary: 'unknown',
                  costRouting,
                },
          }))
          break
        }
        case 'delta':
          if (live) patch((m) => ({ ...m, content: m.content + event.text }))
          else buffered += event.text
          break
        case 'retract':
          if (live) patch((m) => ({ ...m, content: m.content.replace(event.text, '') }))
          else buffered = buffered.replace(event.text, '')
          break
        case 'skills_applied':
          patch((m) => ({ ...m, steps: upsertStep(m.steps, appliedSkillsStep(event)) }))
          break
        case 'artifact':
          artifactAnnounced = true
          // Fetch the full document (cards have empty bodies); open the panel only when the model set out to make it.
          void Promise.all([get().loadArtifacts(), get().refreshArtifact(event.artifactId)]).then(
            () => {
              if (event.deliberate !== false) set({ openArtifactId: event.artifactId })
            },
          )
          break
        case 'step':
          patch((m) => {
            const step = toStep(event as unknown as Record<string, unknown>)
            const steps = m.steps ?? []
            const at = steps.findIndex((s) => s.id === step.id)
            return {
              ...m,
              steps: at >= 0 ? steps.map((s, i) => (i === at ? step : s)) : [...steps, step],
            }
          })
          break
        case 'usage':
          settled = true
          patch((m) => ({
            ...m,
            usage: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              credits: event.credits,
            },
          }))
          if (event.credits) chargeCredits(set, event.credits)
          break
        case 'title':
          set((s) => ({
            sessions: s.sessions.map((c) =>
              c.id === sessionId ? { ...c, title: event.title } : c,
            ),
          }))
          break
        case 'error':
          settled = true
          patch((m) => ({ ...m, error: streamFailureSentence(event, tr) }))
          break
        case 'done':
          if (event.messageId) {
            adoptServerId(set, sessionId, assistantId, event.messageId)
            assistantId = event.messageId
          }
          break
      }
    }
  } catch (err) {
    if (err instanceof PrivacyDecisionError) {
      settled = true
      set((s) => ({
        sessions: s.sessions.map((c) =>
          c.id === sessionId
            ? { ...c, messages: c.messages.filter((m) => m.id !== assistantId) }
            : c,
        ),
      }))
      throw err
    } else if (err instanceof DOMException && err.name === 'AbortError') {
      settled = true
      patch((m) => ({ ...m, failure: 'stopped' }))
    } else if (isClientRefusal(err)) {
      settled = true
      patch((m) => ({
        ...m,
        error:
          refusalSentence(errorCode(err), tr) ??
          errorMessage(err, tr('요청을 처리하지 못했습니다.')),
      }))
      // Rethrown so the composer restores its draft.
      throw err
    } else {
      settled = true
      patch((m) => ({ ...m, error: tr(turnFailure(err)) }))
      // A stall is swallowed: the failed turn carries its own retry.
      if (err instanceof StreamStalledError) return
      throw err
    }
  } finally {
    if (!live && buffered) patch((m) => ({ ...m, content: buffered }))
    if (!settled) patch((m) => ({ ...m, error: CUT_OFF }))
    else if (!artifactAnnounced) {
      // Usage can settle an empty completion; the server marks its question unanswered.
      patch((m) => !m.content && !m.error && !m.failure ? { ...m, failure: 'no_answer' } : m)
    }
    endRun(set, sessionId)
    void get().loadSessions()
  }
}

/** One prompt to several models, stored as a single turn; columns arrive interleaved on one stream. */
async function runComparison(
  set: Set,
  get: Get,
  sessionId: string,
  text: string,
  opts: {
    activatedSkillIds?: string[]
    startingTemplateId?: string
    attachments?: string[]
    attachmentNames?: string[]
    privacyAction?: PrivacyAction
    privacyDecisionToken?: string
    onAccepted?: () => void
  } = {},
) {
  const models = get().compareModels
  let assistantId = uid('m')
  const variants: Variant[] = models.map((model) => ({ model, content: '', status: 'streaming' }))

  set((s) => ({
    running: { ...s.running, [sessionId]: noop },
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? {
            ...c,
            messages: [
              ...c.messages,
              {
                id: assistantId,
                role: 'assistant' as const,
                content: '',
                createdAt: new Date().toISOString(),
                variants,
              },
            ],
          }
        : c,
    ),
  }))

  const patch = (model: string, next: Partial<Variant>) =>
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === sessionId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, variants: m.variants?.map((v) => (v.model === model ? { ...v, ...next } : v)) }
                  : m,
              ),
            }
          : c,
      ),
    }))

  const controller = new AbortController()
  beginRun(set, sessionId, () => controller.abort())
  let accepted = false
  try {
    for await (const e of streamComparison(
      sessionId,
      {
        content: text,
        models,
        activatedSkillIds: opts.activatedSkillIds,
        startingTemplateId: opts.startingTemplateId,
        attachments: opts.attachments,
        privacyAction: opts.privacyAction,
        privacyDecisionToken: opts.privacyDecisionToken,
      },
      controller.signal,
    )) {
      if (!accepted) {
        accepted = true
        opts.onAccepted?.()
      }
      if (e.type === 'privacy_route') {
        if ('effectiveModels' in e) {
          if (e.findingCounts?.length) {
            const { type: _type, ...routing } = e
            markPrompt(set, sessionId, routing)
          }
          set((s) => ({
            sessions: s.sessions.map((c) =>
              c.id === sessionId
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === assistantId
                        ? {
                            ...m,
                            routing: e,
                            variants: e.effectiveModels.map((model) => {
                              const existing = m.variants?.find((v) => v.model === model)
                              const route = e.modelRoutes?.find(
                                (candidate) => candidate.routedModel === model,
                              )
                              return {
                                model,
                                content: existing?.content ?? '',
                                status: existing?.status ?? ('streaming' as const),
                                usage: existing?.usage,
                                routedModel: model,
                                actualModel: route?.actualModel ?? existing?.actualModel,
                                dataBoundary: route?.dataBoundary ?? existing?.dataBoundary,
                              }
                            }),
                          }
                        : m,
                    ),
                  }
                : c,
            ),
          }))
        }
      } else if (e.type === 'variant') {
        const current = get()
          .sessions.find((c) => c.id === sessionId)
          ?.messages.find((m) => m.id === assistantId)
          ?.variants?.find((v) => v.model === e.model)
        patch(e.model, { content: (current?.content ?? '') + e.text })
      } else if (e.type === 'variant_retract') {
        const current = get()
          .sessions.find((c) => c.id === sessionId)
          ?.messages.find((m) => m.id === assistantId)
          ?.variants?.find((v) => v.model === e.model)
        patch(e.model, { content: (current?.content ?? '').replace(e.text, '') })
      } else if (e.type === 'variant_done') {
        patch(e.model, {
          routedModel: e.routedModel ?? e.model,
          actualModel: e.actualModel,
          status: e.error ? 'error' : 'done',
          usage: {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            credits: e.credits,
          },
        })
      } else if (e.type === 'done') {
        chargeCredits(set, e.credits ?? 0)
        if (e.messageId) {
          adoptServerId(set, sessionId, assistantId, e.messageId)
          assistantId = e.messageId
        }
      } else if (e.type === 'skills_applied') {
        patchMessage(set, sessionId, assistantId, (message) => ({
          ...message,
          steps: upsertStep(message.steps, appliedSkillsStep(e)),
        }))
      } else if (e.type === 'step') {
        patchMessage(set, sessionId, assistantId, (message) => ({
          ...message,
          steps: upsertStep(message.steps, toStep(e as unknown as Record<string, unknown>)),
        }))
      }
    }
  } catch (err) {
    if (err instanceof PrivacyDecisionError) {
      set((s) => ({
        sessions: s.sessions.map((c) =>
          c.id === sessionId
            ? { ...c, messages: c.messages.filter((m) => m.id !== assistantId) }
            : c,
        ),
      }))
      throw err
    }
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      for (const m of models) patch(m, { status: 'error' })
      throw err
    }
    if (isClientRefusal(err)) throw err
  } finally {
    endRun(set, sessionId)
    void get().loadSessions()
  }
}

/** Puts the waiting generation on the session, or takes it off. */
function setPending(
  set: Set,
  sessionId: string,
  next: (current: PendingPlan | null) => PendingPlan | null,
) {
  set((s) => ({
    sessions: s.sessions.map((c) =>
      c.id === sessionId ? { ...c, pending: next(c.pending ?? null) } : c,
    ),
  }))
}

async function streamReport(
  set: Set,
  get: Get,
  sessionId: string,
  text: string,
  model: string,
  activatedSkillIds?: string[],
  startingTemplateId?: string,
  /** `approve` turns a proposal into a document and decides whether a draft artifact is shown at all. */
  gate: {
    approve?: boolean
    answers?: Record<string, string>
    webSearch?: WebSearchSetting
    includeFigures?: boolean
    plan?: Record<string, unknown>
    /** Resent with the approval: the server assembles context fresh per request. */
    attachments?: string[]
    renderTemplateId?: string
  } = {},
) {
  const draftId = uid('a')
  const assistantId = uid('m')
  const now = new Date().toISOString()

  const draft: Artifact = {
    id: draftId,
    kind: 'report',
    title: text.slice(0, 60),
    version: 1,
    createdAt: now,
    updatedAt: now,
    sessionId,
    projectId: get().sessions.find((s) => s.id === sessionId)?.projectId ?? null,
    sections: [],
    sources: [],
    research: undefined,
    citationStyle: 'APA',
    wordCount: 0,
  }

  // A planning pass produces no document, so it opens none.
  const willWrite = gate.approve === true
  set((s) => ({
    running: { ...s.running, [sessionId]: noop },
    ...(willWrite ? { artifacts: [draft, ...s.artifacts], openArtifactId: draftId } : {}),
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? {
            ...c,
            ...(willWrite ? { artifactId: draftId } : {}),
            messages: [
              ...c.messages,
              { id: assistantId, role: 'assistant' as const, content: '', createdAt: now },
            ],
          }
        : c,
    ),
  }))

  const patchReport = (fn: (a: ReportArtifact) => ReportArtifact) =>
    set((s) => ({
      artifacts: s.artifacts.map((a) =>
        a.id === draftId && a.kind === 'report' ? fn(a) : a,
      ),
    }))

  const controller = new AbortController()
  beginRun(set, sessionId, () => controller.abort())
  // Whether the turn ended with `usage`/`error`/`proposal`/`needs`. See CUT_OFF.
  let settled = false

  try {
    for await (const e of streamSession(
      sessionId,
      {
        content: text,
        model,
        activatedSkillIds,
        startingTemplateId,
        renderTemplateId: gate.renderTemplateId,
        approve: gate.approve,
        answers: gate.answers,
        webSearch: gate.webSearch,
        includeFigures: gate.includeFigures,
        attachments: gate.attachments,
        plan: gate.plan,
      },
      controller.signal,
    )) {
      switch (e.type) {
        // The turn planned or asked; nothing was written.
        case 'proposal':
          settled = true
          setPending(set, sessionId, (p) => ({
            stage: 'outline',
            request: text,
            attachments: gate.attachments ?? p?.attachments ?? [],
            answers: p?.answers ?? {},
            plan: e.plan,
          }))
          break
        case 'needs':
          settled = true
          setPending(set, sessionId, (p) => ({
            stage: 'clarify',
            request: text,
            attachments: gate.attachments ?? p?.attachments ?? [],
            answers: p?.answers ?? {},
            questions: e.questions,
          }))
          break
        case 'skills_applied':
          patchMessage(set, sessionId, assistantId, (message) => ({
            ...message,
            steps: upsertStep(message.steps, appliedSkillsStep(e)),
          }))
          break
        case 'title':
          patchReport((a) => ({ ...a, title: e.title }))
          break
        case 'sources':
          patchReport((a) => ({ ...a, sources: e.sources }))
          break
        case 'research':
          patchReport((a) => ({ ...a, research: e.research }))
          break
        case 'section':
          patchReport((a) => {
            const at = a.sections.findIndex((x) => x.id === e.sectionId)
            const next: ReportSection = {
              id: e.sectionId,
              heading: e.heading,
              level: 1,
              status: e.done ? 'done' : 'pending',
              content: e.content,
            }
            const sections =
              at >= 0
                ? a.sections.map((x, i) => (i === at ? next : x))
                : [...a.sections, next]
            return {
              ...a,
              sections,
              wordCount: sections.reduce((n, x) => n + x.content.split(/\s+/).filter(Boolean).length, 0),
            }
          })
          break
        case 'step':
          set((s) => ({
            sessions: s.sessions.map((c) =>
              c.id === sessionId
                ? {
                    ...c,
                    messages: c.messages.map((m) => {
                      if (m.id !== assistantId) return m
                      const step = toStep(e as unknown as Record<string, unknown>)
                      const steps = m.steps ?? []
                      const at = steps.findIndex((x) => x.id === step.id)
                      return {
                        ...m,
                        steps: at >= 0 ? steps.map((x, i) => (i === at ? step : x)) : [...steps, step],
                      }
                    }),
                  }
                : c,
            ),
          }))
          break
        case 'usage':
          settled = true
          chargeCredits(set, e.credits)
          break
        case 'error':
          settled = true
          patchMessage(set, sessionId, assistantId, (m) => ({ ...m, content: e.message }))
          break
        case 'artifact':
          // The server's copy replaces the draft; fetched in full since the panel needs the document.
          await Promise.all([get().loadArtifacts(), get().refreshArtifact(e.artifactId)])
          set((s) => ({
            artifacts: s.artifacts.filter((a) => a.id !== draftId),
            openArtifactId: e.artifactId,
            sessions: s.sessions.map((c) =>
              c.id === sessionId ? { ...c, artifactId: e.artifactId } : c,
            ),
          }))
          break
      }
    }
  } catch (err) {
    settled = true
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      patchMessage(set, sessionId, assistantId, (m) => ({
        ...m,
        error: errorMessage(err, '보고서를 만들지 못했습니다.'),
      }))
    }
    if (isClientRefusal(err)) throw err
  } finally {
    if (!settled) patchMessage(set, sessionId, assistantId, (m) => ({ ...m, error: CUT_OFF }))
    endRun(set, sessionId)
    void get().loadSessions()
  }
}

/** A slides turn: slides fill a local draft, replaced by the server's copy at the end. */
async function streamDeck(
  set: Set,
  get: Get,
  sessionId: string,
  text: string,
  model: string,
  activatedSkillIds?: string[],
  startingTemplateId?: string,
  /** `approve` turns a proposal into a document and decides whether a draft artifact is shown at all. */
  gate: {
    approve?: boolean
    answers?: Record<string, string>
    webSearch?: WebSearchSetting
    includeFigures?: boolean
    plan?: Record<string, unknown>
    /** Resent with the approval: the server assembles context fresh per request. */
    attachments?: string[]
    renderTemplateId?: string
  } = {},
) {
  const draftId = uid('a')
  const assistantId = uid('m')
  const now = new Date().toISOString()

  const draft: Artifact = {
    id: draftId,
    kind: 'deck',
    title: text.slice(0, 60),
    version: 1,
    createdAt: now,
    updatedAt: now,
    sessionId,
    projectId: get().sessions.find((s) => s.id === sessionId)?.projectId ?? null,
    theme: '기본',
    slides: [],
    draft: true,
  }

  // A planning pass produces no document, so it opens none.
  const willWrite = gate.approve === true
  set((s) => ({
    running: { ...s.running, [sessionId]: noop },
    ...(willWrite ? { artifacts: [draft, ...s.artifacts], openArtifactId: draftId } : {}),
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? {
            ...c,
            ...(willWrite ? { artifactId: draftId } : {}),
            messages: [
              ...c.messages,
              { id: assistantId, role: 'assistant' as const, content: '', createdAt: now },
            ],
          }
        : c,
    ),
  }))

  const patchDeck = (fn: (a: DeckArtifact) => DeckArtifact) =>
    set((s) => ({
      artifacts: s.artifacts.map((a) => (a.id === draftId && a.kind === 'deck' ? fn(a) : a)),
    }))

  const controller = new AbortController()
  beginRun(set, sessionId, () => controller.abort())
  // Whether the turn ended with `usage`/`error`/`proposal`/`needs`. See CUT_OFF.
  let settled = false

  try {
    for await (const e of streamSession(
      sessionId,
      {
        content: text,
        model,
        activatedSkillIds,
        startingTemplateId,
        renderTemplateId: gate.renderTemplateId,
        approve: gate.approve,
        answers: gate.answers,
        webSearch: gate.webSearch,
        includeFigures: gate.includeFigures,
        attachments: gate.attachments,
        plan: gate.plan,
      },
      controller.signal,
    )) {
      switch (e.type) {
        // The turn planned or asked; nothing was written.
        case 'proposal':
          settled = true
          setPending(set, sessionId, (p) => ({
            stage: 'outline',
            request: text,
            attachments: gate.attachments ?? p?.attachments ?? [],
            answers: p?.answers ?? {},
            plan: e.plan,
          }))
          break
        case 'needs':
          settled = true
          setPending(set, sessionId, (p) => ({
            stage: 'clarify',
            request: text,
            attachments: gate.attachments ?? p?.attachments ?? [],
            answers: p?.answers ?? {},
            questions: e.questions,
          }))
          break
        case 'skills_applied':
          patchMessage(set, sessionId, assistantId, (message) => ({
            ...message,
            steps: upsertStep(message.steps, appliedSkillsStep(e)),
          }))
          break
        case 'title':
          patchDeck((a) => ({ ...a, title: e.title }))
          break
        case 'slide':
          patchDeck((a) => {
            const at = a.slides.findIndex((x) => x.id === e.slide.id)
            return {
              ...a,
              slides:
                at >= 0
                  ? a.slides.map((x, i) => (i === at ? e.slide : x))
                  : [...a.slides, e.slide],
            }
          })
          break
        case 'step':
          set((s) => ({
            sessions: s.sessions.map((c) =>
              c.id === sessionId
                ? {
                    ...c,
                    messages: c.messages.map((m) => {
                      if (m.id !== assistantId) return m
                      const step = toStep(e as unknown as Record<string, unknown>)
                      const steps = m.steps ?? []
                      const at = steps.findIndex((x) => x.id === step.id)
                      return {
                        ...m,
                        steps:
                          at >= 0 ? steps.map((x, i) => (i === at ? step : x)) : [...steps, step],
                      }
                    }),
                  }
                : c,
            ),
          }))
          break
        case 'usage':
          settled = true
          chargeCredits(set, e.credits)
          break
        case 'error':
          settled = true
          patchMessage(set, sessionId, assistantId, (m) => ({ ...m, content: e.message }))
          break
        case 'artifact':
          await Promise.all([get().loadArtifacts(), get().refreshArtifact(e.artifactId)])
          set((s) => ({
            artifacts: s.artifacts.filter((a) => a.id !== draftId),
            openArtifactId: e.artifactId,
            sessions: s.sessions.map((c) =>
              c.id === sessionId ? { ...c, artifactId: e.artifactId } : c,
            ),
          }))
          break
      }
    }
  } catch (err) {
    settled = true
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      patchMessage(set, sessionId, assistantId, (m) => ({
        ...m,
        error: errorMessage(err, '슬라이드를 만들지 못했습니다.'),
      }))
    }
    if (isClientRefusal(err)) throw err
  } finally {
    if (!settled) patchMessage(set, sessionId, assistantId, (m) => ({ ...m, error: CUT_OFF }))
    endRun(set, sessionId)
    void get().loadSessions()
  }
}

/** Puts the turn's privacy routing on the last user message. */
function markPrompt(set: Set, sessionId: string, routing: PrivacyRouting) {
  set((s) => ({
    sessions: s.sessions.map((c) => {
      if (c.id !== sessionId) return c
      const at = c.messages.map((m) => m.role).lastIndexOf('user')
      if (at < 0) return c
      return { ...c, messages: c.messages.map((m, i) => (i === at ? { ...m, routing } : m)) }
    }),
  }))
}

function patchMessage(set: Set, sessionId: string, messageId: string, fn: (m: Message) => Message) {
  set((s) => ({
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? fn(m) : m)) }
        : c,
    ),
  }))
}

/** Optimistic prompt row plus, when `pending`, an empty answer row (a video job has a card instead). */
function beginMediaTurn(set: Set, sessionId: string, prompt: string, pending: boolean) {
  const promptId = uid('m')
  const answerId = pending ? uid('m') : ''
  const now = new Date().toISOString()
  set((s) => ({
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? {
            ...c,
            title: c.messages.length === 0 ? prompt.slice(0, 40) : c.title,
            updatedAt: now,
            messages: [
              ...c.messages,
              { id: promptId, role: 'user' as const, content: prompt, createdAt: now },
              ...(answerId
                ? [{ id: answerId, role: 'assistant' as const, content: '', createdAt: now }]
                : []),
            ],
          }
        : c,
    ),
  }))
  return { promptId, answerId }
}

/** Attaches what came back to the answer row; the charge arrives with the server's copy of the turn. */
function finishMediaTurn(
  set: Set,
  sessionId: string,
  answerId: string,
  artifactIds: string[],
  short: boolean,
) {
  patchMessage(set, sessionId, answerId, (m) => ({
    ...m,
    artifactIds,
    // `short`: fewer pictures than asked for.
    failure: short ? ('interrupted' as const) : undefined,
  }))
}

/** Drops the empty answer row and marks the prompt as unanswered. */
function failMediaTurn(
  set: Set,
  sessionId: string,
  promptId: string,
  answerId: string,
  said: string,
) {
  set((s) => ({
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? {
            ...c,
            messages: c.messages
              .filter((m) => m.id !== answerId)
              .map((m) =>
                m.id === promptId ? { ...m, failure: 'no_answer' as const, error: said } : m,
              ),
          }
        : c,
    ),
  }))
}

/** Takes an optimistic turn back off, for a request that was never accepted. */
function dropMediaTurn(set: Set, sessionId: string, ...ids: string[]) {
  set((s) => ({
    sessions: s.sessions.map((c) =>
      c.id === sessionId
        ? { ...c, messages: c.messages.filter((m) => !ids.includes(m.id)) }
        : c,
    ),
  }))
}

/**
 * Polls a transcript that ends on a user message until the server-side turn
 * answers it, the person leaves the session, or two minutes pass.
 */
async function watchForTheAnswer(set: Set, get: Get, sessionId: string) {
  const answered = () => {
    const messages = get().sessions.find((c) => c.id === sessionId)?.messages ?? []
    const last = messages[messages.length - 1]
    return !last || last.role !== 'user'
  }
  if (answered() || get().running[sessionId]) return

  for (let waited = 0; waited < 120_000; waited += 3_000) {
    await new Promise((done) => setTimeout(done, 3_000))
    if (get().activeSessionId !== sessionId) return
    if (get().running[sessionId]) return

    await reconcileSession(set, sessionId)
    const messages = get().sessions.find((c) => c.id === sessionId)?.messages ?? []
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') return
  }
}

/** Deducts on completion; nothing is held up front. */
function chargeCredits(set: Set, credits: number) {
  set((s) => ({
    user: s.user ? { ...s.user, creditsUsed: s.user.creditsUsed + credits } : s.user,
  }))
}

/** Description → mermaid → PNG (2× for print), drawn off-screen with the app's tokens; the source is stored with it. */
export async function drawFigure(
  sessionId: string,
  description: string,
  figure: string,
  model: string | undefined,
): Promise<ArtifactRow> {
  const { drawOrExplain, paperStyles, paperTheme, rasterise } = await import('@/lib/mermaid')
  // The card writes 「이름표 언어: 영어」 into the request.
  const language = /이름표 언어\s*[:：]\s*영어|Label language\s*[:：]\s*English/i.test(description)
    ? 'en'
    : 'ko'
  let written = await sessionsApi.diagram(sessionId, { description, figure, model, language })
  const host = document.createElement('div')
  host.style.position = 'absolute'
  host.style.left = '-10000px'
  host.style.width = '1200px'
  document.body.appendChild(host)
  try {
    const look = paperTheme(host)
    const { hot, ...config } = look
    let drawn = await drawOrExplain(written.source, config)
    if ('error' in drawn) {
      // One repair round: mermaid's error goes back to the writer with its source.
      written = await sessionsApi.diagram(sessionId, {
        description, figure, model, language,
        broken: written.source, error: drawn.error,
      })
      drawn = await drawOrExplain(written.source, config)
    }
    if ('error' in drawn) throw new Error(tr('도식을 그리지 못했습니다. 설명을 조금 바꿔 다시 해 보세요.'))
    let svg = drawn.svg
    // Mermaid theme variables do not reach `:::hot`; inject a stylesheet.
    svg = svg.replace(/<svg([^>]*)>/, (m) => `${m}<style>${paperStyles(hot)}</style>`)
    const png = await rasterise(svg)
    if (!png) throw new Error(tr('도식을 그림으로 저장하지 못했습니다.'))
    // `width`/`height` may be percentages or absent; the viewBox is the layout.
    const box = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(svg)
    const size = box ?? /width="([\d.]+)[^"]*"[^>]*height="([\d.]+)/.exec(svg)
    return await sessionsApi.storeDiagram(sessionId, {
      source: written.source,
      caption: written.caption,
      description,
      figure,
      title: written.caption || description.split('\n')[0].slice(0, 80),
      model: written.model,
      png: png.replace(/^data:image\/png;base64,/, ''),
      width: size ? Math.round(Number(size[1]) * 2) : 0,
      height: size ? Math.round(Number(size[2]) * 2) : 0,
    })
  } finally {
    host.remove()
  }
}
