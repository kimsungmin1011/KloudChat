/**
 * KloudChat domain types: a `Session` of some `SessionKind` produces an `Artifact`; slow kinds carry a `Job`.
 * No proxy credential appears here: virtual keys are issued and used server-side only.
 */

/* ── identity ───────────────────────────────────────────────────────── */

export type UserRole = 'admin' | 'user'
export type UserStatus = 'active' | 'pending' | 'suspended'

export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  status: UserStatus
  /** Credits are an internal unit, not provider prices. `creditsUsed` resets to 0 at `cycleResetsAt`; nothing rolls over. */
  monthlyCredits: number
  creditsUsed: number
  /** Null until an admin approves and opens the first cycle. */
  cycleResetsAt: string | null
  avatarColor: string
  /** Last four characters of the LiteLLM key, or null. The key itself never reaches the browser. */
  litellmKeyPreview: string | null
  litellmKeyIssuedAt: string | null
  /** Always present: the server fills in defaults. */
  preferences: Preferences
  /** Empty means the whole catalogue. */
  allowedModels: string[]
  createdAt: string
  /** Null for an account that has never signed in. */
  lastActiveAt: string | null
  /** Null while the mailed signup link is still out. */
  emailVerifiedAt?: string | null
}

/* ── models ─────────────────────────────────────────────────────────── */

type Modality = 'chat' | 'image' | 'audio' | 'video'

export interface ModelInfo {
  id: string
  /** "Vendor · Model". */
  label: string
  /** Model name without the vendor, for layouts that place the two separately. */
  name: string
  /** Company that built the model (Qwen, Anthropic, …) — not the routing slug. */
  vendor: string
  /** LiteLLM routing provider (`hosted_vllm`, `openrouter`, …). */
  provider: string
  /** From proxy metadata only; missing means `unknown`, never inferred from the id. */
  dataBoundary: 'self_hosted' | 'hybrid' | 'external' | 'unknown'
  strictLocal: boolean
  privacyOnly: boolean
  modality: Modality
  /** Video only: credits per second, keyed `<resolution>:<sound|silent>`. */
  creditPerSecond?: Record<string, number>
  /** Credits per generated picture; zero for non-image models. */
  creditPerImage?: number
  /** Image only: the ratios a picture from it can have. The composer offers no other. */
  aspects?: string[]
  /** Flat credits per call, for models billed per clip rather than per token. */
  creditPerCall?: number
  /** Which of the five surfaces may select this model. */
  kinds: SessionKind[]
  /** Credits per unit — per 1k output tokens for chat, per asset for image/audio/video. */
  creditCost: number
  /** Credits per 1k input tokens; 0 for non-conversational or self-hosted models. */
  inputCreditCost: number
  contextWindow?: number
  supportsVision?: boolean
  supportsTools?: boolean
  /** Set when the model is not reachable through LiteLLM and uses an adapter. */
  adapter?: string
  description: string
}

/* ── sessions ───────────────────────────────────────────────────────── */

/** `av` covers audio and video: one surface, producing an `audio` or `video` artifact by mode. */
export type SessionKind = 'chat' | 'report' | 'slides' | 'image' | 'av'
/** `auto` routes low-complexity turns cheaper; `auto_quality` routes high-complexity turns up. */
export type RoutingMode = 'manual' | 'auto' | 'auto_quality'

/** What a session produced, as measurements so the row can be phrased in the reader's language. */
export interface SessionMade {
  kind: 'image' | 'video' | 'narration' | 'music'
  count: number
  /** Zero where unknown or where the artifacts disagree; zero is not printed. */
  seconds: number
  aspect: string
}

/** One thing a stopped generation needs answered. */
export interface PendingQuestion {
  id: string
  question: string
  /** Suggested answers; free text is always accepted too. */
  options: string[]
  detail: string
}

/** A generation waiting on the person who asked for it. */
export interface PendingPlan {
  /** `clarify` holds a question, `outline` the plan, `figures` the offer to draw the planned pictures. */
  stage: 'clarify' | 'outline' | 'figures'
  /** Proposed pictures, by section index. */
  figures?: { section: number; caption: string; prompt: string }[]
  /** Approximate cost of drawing them. */
  figureCredits?: number
  figureModel?: string
  /** The request with any answers already folded in. */
  request: string
  attachments: string[]
  answers: Record<string, string>
  questions?: PendingQuestion[]
  plan?: {
    title?: string
    visualStyle?: 'editorial' | 'poster' | 'minimal' | 'dark' | 'split' | 'warm' | 'mono' | 'pastel' | 'forest' | 'slate' | 'paper'
    /** Whether the deck is meant to support a speaker or stand alone when shared. */
    density?: 'speaker' | 'reading'
    /** Slides and template blocks carry a layout; report sections are titles. */
    slides?: { title: string; layout: string }[]
    blocks?: { title: string; layout: string }[]
    sections?: string[]
  }
}

export interface Session {
  id: string
  kind: SessionKind
  title: string
  projectId: string | null
  agentId: string | null
  model: string
  /** Under `auto`, `model` is the quality ceiling. */
  routingMode: RoutingMode
  createdAt: string
  updatedAt: string
  pinned: boolean
  messages: Message[]
  /** Latest message, one line; list views carry this instead of `messages`. */
  preview: string | null
  messageCount: number
  /** Null wherever there is a transcript. */
  made: SessionMade | null
  /** Artifact this session is currently producing, if any. */
  artifactId: string | null
  /** A generation stopped and waiting on the person; while set, typing answers it rather than starting a new turn. */
  pending: PendingPlan | null
  /** Sticky rendering template; null is the surface's built-in track. */
  renderTemplateId: string | null
}

export interface Preferences {
  /** Off means the answer appears in one piece when the turn ends. */
  streamResponses: boolean
  /** Extract durable facts from finished turns into memory. */
  autoMemory: boolean
  /** The model · token · credit line under each answer. */
  showUsage: boolean
  privacyDefaultAction: PrivacyAction | 'ask'
  /** 개인 맞춤 설정; empty strings when unset. */
  aboutMe?: string
  responseStyle?: string
  /** The model picked on each surface, kept with the account across browsers. */
  modelByKind?: Partial<Record<SessionKind, string>>
  avModelByMode?: Partial<Record<'audio' | 'video', string>>
}

export type PrivacyAction = 'route_strict_local' | 'mask_external' | 'send_raw_external'

export interface CostRouting {
  mode: 'auto' | 'auto_quality'
  decision: 'routed' | 'kept_quality' | 'bypassed' | 'classifier_unavailable'
  reasonCode: string
  requestedModel: string
  selectedModel: string
  executedModel?: string
  classifierVersion: string
  complexity?: 'low' | 'high' | 'uncertain'
  confidence?: number
  classifierModel?: string
  classifierInputTokens?: number
  classifierOutputTokens?: number
  estimatedCreditsSaved?: number
}

export interface PrivacyRouting {
  requestedModels: string[]
  routedModels: string[]
  effectiveModels: string[]
  actualModels: string[]
  actualModel?: string
  action: PrivacyAction | 'strict_local' | 'none'
  dataBoundary: ModelInfo['dataBoundary'] | 'mixed'
  modelRoutes?: {
    routedModel: string
    actualModel: string | null
    dataBoundary: ModelInfo['dataBoundary']
  }[]
  detectorVersion?: string
  policyVersion?: string
  findingCounts?: { category: string; source: string; count: number }[]
  compareCollapsed?: boolean
  toolOutputMasked?: number
  toolOutputFindings?: { category: string; source: string; count: number }[]
  initialAction?: PrivacyAction | 'strict_local' | 'none'
  costRouting?: CostRouting
}

/** A tool-authored answer; earlier routing/classification work is not ruled out. */
export interface ToolResultAnswer {
  answerOrigin: 'tool_result'
  toolName: 'calculate'
  reasonCode: 'division_by_zero'
  actualModel: null
}

/** A server policy response, not an answer generated by the selected model. */
export interface FreshnessAbstention {
  answerOrigin: 'server_policy'
  actualModel: null
  freshness: {
    status: 'unverified'
    reason: 'verification_unavailable' | 'lookup_failed_or_empty'
  }
}

export type MessageRouting = PrivacyRouting | ToolResultAnswer | FreshnessAbstention

export type Role = 'user' | 'assistant' | 'system'

/** A unit of visible work inside an assistant turn. */
export interface Step {
  id: string
  type: 'thinking' | 'tool' | 'artifact'
  label: string
  status: 'running' | 'done' | 'error'
  detail?: string
  progress?: { current: number; total: number }
  skills?: {
    id: string
    name: string
    catalogKey: string | null
    estimatedTokens: number
  }[]
  /** Names of the memories this turn was given. Never their bodies. */
  memories?: string[]
  files?: {
    name: string
    state: 'included' | 'truncated' | 'omitted' | 'unreadable'
    keptChars: number
    totalChars: number
  }[]
  memoriesWritten?: number
  /** Total memories, when only the most recent were loaded. */
  totalMemories?: number
  /** Which halves of 개인 맞춤 설정 shaped the turn. */
  personal?: string[]
  estimatedTokens?: number
}

/** One model's answer inside a comparison turn. */
export interface Variant {
  model: string
  routedModel?: string
  actualModel?: string
  dataBoundary?: ModelInfo['dataBoundary']
  content: string
  status: 'streaming' | 'done' | 'error'
  usage?: { inputTokens: number; outputTokens: number; credits: number }
  /** Set on the variant the user kept; the conversation continues from it. */
  chosen?: boolean
}

/** A 시작점 selected for the next turn; the prompt framing is the server's. */
export interface StartingPoint {
  id: string
  title: string
  fills: string[]
  /** The request as the card's form assembled it, placed in the composer. */
  text?: string
  /** One example per blank, in `fills` order. */
  examples?: string[]
  /** 'web' | 'file'. */
  needs?: string[]
  /** Workspace skills to switch on, by name. */
  skills?: string[]
  /** Per blank, in `fills` order: options → picker, long → textarea, else a line. */
  blanks?: { name: string; options?: string[]; long?: boolean }[]
  /** Media 서식 only: the sentence the blanks fill, `{name}` per blank; an empty blank keeps its example. */
  examplePrompt?: string
}

export interface Message {
  id: string
  role: Role
  content: string
  /** Present instead of `content` when the turn was run as a model comparison. */
  variants?: Variant[]
  createdAt: string
  model?: string | null
  routing?: MessageRouting
  steps?: Step[]
  artifactIds?: string[]
  /** `id` names the stored blob; absent only on the optimistic row while the upload is in flight. */
  attachments?: { id?: string; name: string; size: number | string; type: string }[]
  /** `estimated` on a stopped turn: the server counts tokens itself since the proxy's final chunk never arrives. */
  usage?: { inputTokens: number; outputTokens: number; credits: number; estimated?: boolean }
  liked?: 'up' | 'down' | null
  /** The 시작점 this turn began from. */
  startedFrom?: { templateId: string; title: string }
  /** Separate from `content`: a turn can fail after writing something. */
  error?: string
  /** Server-recorded end state; `error` wins while this tab is live. `no_answer` sits on the question, `interrupted` on the partial reply. */
  failure?: 'no_answer' | 'interrupted' | 'stopped'
}

/* ── jobs ───────────────────────────────────────────────────────────── */

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface Job {
  id: string
  sessionId: string
  kind: SessionKind
  status: JobStatus
  /** 0–100. Providers that report no progress get a coarse stage-based estimate. */
  progress: number
  stage: string
  /** Charged on success only; a failed job never deducted anything. */
  creditsUsed: number
  creditsEstimated: number
  error?: string
  createdAt: string
  finishedAt: string | null
  prompt: string
  model: string
  params: Record<string, unknown> | null
}

/* ── artifacts ──────────────────────────────────────────────────────── */

export type ArtifactKind =
  | 'report'
  | 'deck'
  | 'chart'
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'html'

interface ArtifactBase {
  id: string
  title: string
  version: number
  createdAt: string
  updatedAt: string
  sessionId: string | null
  projectId: string | null
  /** Listing copy with a trimmed body; `refreshArtifact` fetches the whole document and clears this. */
  partial?: boolean
  /** Local draft a run is still streaming into; the server does not hold it yet. */
  draft?: boolean
  /** Linter findings as of when this was written. */
  lint?: LintFinding[]
  /** Absent until requested; costs a model call. */
  critique?: Critique
}

/** A model review; nothing is gated on the score. */
export interface Critique {
  score: number
  findings: LintFinding[]
  model: string
  at: string
}

/** `P0`: the document is wrong. `P1`: it reads badly. Nothing is corrected automatically. */
export interface LintFinding {
  severity: 'P0' | 'P1'
  /** `placeholder` · `invented-metric` · `filler` · `empty` · … */
  rule: string
  message: string
  /** The heading it was found under, or empty for the whole document. */
  where: string
}

/** A citation the model attached to a claim, surfaced beside the prose. */
export interface Source {
  id: string
  /** Number shown inline as [1], [2] … */
  ordinal: number
  title: string
  author?: string
  publisher?: string
  year?: string
  url?: string
  origin: 'web' | 'connector' | 'file'
  originLabel: string
  quote?: string
}

/** Sections stream in one at a time; the panel renders each as it completes. */
export interface ReportSection {
  id: string
  heading: string
  level: 1 | 2
  status: 'pending' | 'streaming' | 'done'
  content: string
  /** Absent means `markdown`. `html` is a hand-formatted section; the server sanitises it (`services/richtext.py`). */
  format?: 'markdown' | 'html'
  /** Rendered mermaid diagrams keyed by source hash; the browser renders and posts them, the exporters read them. */
  diagrams?: Record<string, string>
  factCheck?: FactCheck
}

/** Design values every renderer and exporter reads. Always complete on the wire. */
export interface DesignTokens {
  accent: string
  ink: string
  muted: string
  font: 'gothic' | 'serif'
  visualStyle?: 'editorial' | 'poster' | 'minimal' | 'dark' | 'split' | 'warm' | 'mono' | 'pastel' | 'forest' | 'slate' | 'paper'
  /** Footer line on every slide and page. */
  footer?: string
  /** `data:` URI, so exported files carry the mark with them. */
  logo?: string
}

export interface ReportArtifact extends ArtifactBase {
  kind: 'report'
  sections: ReportSection[]
  sources: Source[]
  /** Search trail behind the source shelf. */
  research?: {
    enabled: boolean
    searched: boolean
    queries: string[]
    selected: number
    excluded: number
    webSelected?: number
    projectSelected?: number
    projectExcluded?: number
  }
  /** Citation style the export renders. */
  citationStyle: 'APA' | 'MLA' | 'Chicago' | 'IEEE'
  wordCount: number
  pageSettings?: {
    header?: string
    footer?: string
    pageNumbers?: 'none' | 'page' | 'page-total'
    firstPageHeader?: boolean
    margins?: { top: number; right: number; bottom: number; left: number }
  }
  reviewComments?: {
    id: string
    sectionId: string
    quote: string
    body: string
    status: 'open' | 'resolved'
    createdAt: string
  }[]
  /** 서식 the page view is drawn in; absent is the plain report seed. */
  templateId?: string
  design?: DesignTokens | null
}

export interface ChartArtifact extends ArtifactBase {
  kind: 'chart'
  chartType: 'bar' | 'line' | 'stacked'
  caption: string
  xLabel: string
  yLabel: string
  series: { name: string; color: string; points: { x: string; y: number }[] }[]
  /** The rows the chart was computed from. */
  table: { columns: string[]; rows: (string | number)[][] }
  sourceFile: string
}

/** Per-claim verification result. */
export interface FactCheck {
  status: 'unchecked' | 'checking' | 'done'
  claims: {
    id: string
    text: string
    verdict: 'supported' | 'unsupported' | 'uncertain'
    note: string
    /** Required for `supported`/`unsupported`; without it the server downgrades to `uncertain`. */
    sourceUrl?: string
  }[]
}

export interface Slide {
  id: string
  /** Layout supported by `deck._LAYOUTS`. */
  layout:
    | 'title'
    | 'section'
    | 'agenda'
    | 'bullets'
    | 'two-column'
    | 'quote'
    | 'statement'
    | 'chart'
    | 'table'
    | 'metrics'
    | 'big-number'
    | 'bands'
    | 'tiles'
    | 'timeline'
    | 'steps'
    | 'cards'
    | 'closing'
  title: string
  /** `section` only: `01.`, `02.` over the title. */
  number?: string
  bullets?: string[]
  /** A table, first row the head. */
  rows?: string[][]
  /** `[값, 이름]`. */
  metrics?: [string, string][]
  /** `[이름, 문장]` label-beside-text shapes. */
  bands?: [string, string][]
  /** `[글자/숫자, 캡션]`. */
  tiles?: [string, string][]
  /** `[날짜, 사건]`. */
  timeline?: [string, string][]
  /** `[단계, 한 줄]`, numbered by position. */
  steps?: [string, string][]
  /** `[이름, 한두 줄]`, titled boxes side by side. */
  cards?: [string, string][]
  /** Every series carries exactly as many values as there are categories. */
  chart?: {
    kind: 'bar' | 'line'
    unit?: string
    categories: string[]
    series: { name: string; values: number[] }[]
  }
  body?: string
  notes?: string
  accent?: string
  factCheck?: FactCheck
  /** Text size as a multiple of the 서식's own; `deck_export` applies the same factor. */
  textScale?: number
  /** Sanitised inline HTML keyed by text slot (`title`, `bullets.0`, `rows.1.2`, …); the plain fields stay canonical. */
  richText?: Record<string, string>
  /** `src` is a `data:` URI so the deck stays one self-contained file. */
  image?: {
    src: string
    caption?: string
    fit?: 'contain' | 'cover'
    position?: 'left' | 'right'
    /** `full`: the picture alone under the title. */
    size?: 'small' | 'medium' | 'large' | 'full'
    /** The browser's raster of `diagram`, stored for the exporters; a placed picture clears it. */
    diagram?: boolean
  }
  /** A structure, flow, comparison or concept figure the deck drew for itself as mermaid.
   *  The panel renders it live; its raster travels in `image` for the exporters. */
  diagram?: {
    figure: 'method' | 'flow' | 'compare' | 'concept'
    description: string
    source: string
    caption: string
    /** `report_export.diagram_key` of `source`; the raster is stored under it. */
    key: string
  }
}

export interface DeckArtifact extends ArtifactBase {
  kind: 'deck'
  theme: string
  slides: Slide[]
  /** Deck 서식 this was written under; the export builds on its PowerPoint half. */
  templateId?: string
  /** Copied on when the deck was made. */
  design?: DesignTokens | null
  reviewComments?: {
    id: string
    slideId: string
    body: string
    status: 'open' | 'resolved'
    createdAt: string
  }[]
}

export interface ImageArtifact extends ArtifactBase {
  kind: 'image'
  jobId: string | null
  prompt: string
  /** Ratio asked for. */
  aspect: string
  /** Ratio measured off the bytes; absent on older rows. */
  actualAspect?: string
  width?: number
  height?: number
  style: string
  labels?: string
  /** What the model was actually sent; re-sent as-is with `raw`. */
  composedPrompt?: string
  /** `matplotlib`: drawn from sandbox code, which `composedPrompt` then holds. */
  engine?: 'matplotlib'
  seed: number
  model: string
  src: string
  /** 도식일 때: the mermaid source the picture was rendered from. */
  figure?: string
  source?: string
  caption?: string
}

/** `waveform` is a coarse amplitude envelope (0–1, ~64 buckets). */
export interface AudioArtifact extends ArtifactBase {
  kind: 'audio'
  jobId: string | null
  prompt: string
  durationSec: number
  audioKind: 'narration' | 'music'
  /** Empty for music. */
  transcript?: string
  model: string
  waveform: number[]
  src: string | null
}

export interface VideoArtifact extends ArtifactBase {
  kind: 'video'
  jobId: string | null
  prompt: string
  durationSec: number
  aspect: string
  model: string
  posterSrc: string
  src: string | null
}

export interface CodeArtifact extends ArtifactBase {
  kind: 'code' | 'html'
  language?: string
  content: string
  templateId?: string
  /** Outline of the file, without parsing the markup. */
  blocks?: { title: string; layout: string }[]
}

export type Artifact =
  | ReportArtifact
  | DeckArtifact
  | ChartArtifact
  | ImageArtifact
  | AudioArtifact
  | VideoArtifact
  | CodeArtifact

/* ── workspace ──────────────────────────────────────────────────────── */

export interface Project {
  id: string
  name: string
  description: string
  emoji: string
  instructions: string
  files: ProjectFile[]
  sessionIds: string[]
  skillIds: string[]
  /** The design system this project's output wears. Null is the default look. */
  designSystemId: string | null
  /** Surface → rendering template id; a surface with no entry uses the built-in track. */
  renderTemplates: Record<string, string>
  updatedAt: string
}

export interface ProjectFile {
  id: string
  name: string
  size: string
  type: string
  addedAt: string
  tokens: number
  sourceUrl?: string | null
  preview: string
  error?: string | null
}

export interface Skill {
  id: string
  name: string
  slug: string
  description: string
  whenToUse: string
  body: string
  /** Stable key for shipped skills; null for user-authored ones. */
  catalogKey: string | null
  requiredTools: string[]
  /** Approximate prompt cost. */
  estimatedTokens: number
  source: 'built-in' | 'workspace' | 'personal'
  kinds: SessionKind[]
  enabled: boolean
  /** `org` lists it in the store for the workspace to copy. */
  visibility: 'private' | 'org'
  installs: number
  originId: string | null
  version: string
  updatedAt: string
}

/* ── MCP connectors ─────────────────────────────────────────────────── */

export type ConnectorStatus = 'connected' | 'disconnected' | 'needs_auth' | 'error'

interface McpTool {
  name: string
  description: string
  /** Read-only tools can run unattended; write tools ask for confirmation. */
  readOnly: boolean
  enabled: boolean
}

export interface Connector {
  id: string
  name: string
  slug: string
  description: string
  category: string
  /** stdio servers run beside the API; http/sse ones are remote. */
  transport: 'stdio' | 'http' | 'sse'
  endpoint: string
  auth: 'none' | 'oauth' | 'api_key'
  status: ConnectorStatus
  installed: boolean
  enabled: boolean
  kinds: SessionKind[]
  tools: McpTool[]
  /** Credential names only, never values. */
  envKeys?: string[]
  official: boolean
  icon: string
  color: string
  lastSyncAt: string | null
  error?: string
}

/* ── memory & agents ─────────────────────────────────────────────────── */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryEntry {
  id: string
  name: string
  description: string
  type: MemoryType
  body: string
  scope: 'global' | string
  links: string[]
  updatedAt: string
  pinned: boolean
}

export interface Agent {
  /** Shared agents are read-only to everyone but the owner. */
  ownerId: string
  ownerName: string
  id: string
  visibility: 'private' | 'org'
  installs: number
  /** Stable key for shipped agents; null for user-authored ones. */
  catalogKey: string | null
  originId: string | null
  /** Published by an administrator; meaningful on store rows. */
  official: boolean
  /** The caller already holds a copy; store rows only. */
  installed: boolean
  name: string
  slug: string
  description: string
  model: string
  systemPrompt: string
  guide: string
  starters: string[]
  /** `sealed`: copies run the author's prompt without being able to read it. */
  shareMode: 'open' | 'sealed'
  /** Prompt is absent here and read from the original at run time. */
  sealed: boolean
  /** null inherits; [] denies all; values form a hard allowlist. */
  tools: string[] | null
  /** null inherits turn selection; [] denies all selected skills. */
  skillIds: string[] | null
  kinds: SessionKind[]
  temperature: number
  color: string
  enabled: boolean
  runs: number
  hasKnowledge: boolean
  updatedAt: string
}

/** A store row: somebody else's skill, kept out of the composer's own list. */
export interface StoreSkill extends Skill {
  ownerId: string
  ownerName: string
  official: boolean
  installed: boolean
}

export interface ToolCatalogEntry {
  name: string
  label: string
  available: boolean
}
