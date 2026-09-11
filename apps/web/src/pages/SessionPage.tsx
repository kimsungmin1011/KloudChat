import { Bot, Boxes, Info, Palette, PanelRight, RotateCw } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ArtifactPanel } from '@/components/artifacts/ArtifactPanel'
import { Composer, hasUnsentDraft } from '@/components/chat/Composer'
import { ProposalCard } from '@/components/chat/ProposalCard'
import { MessageItem } from '@/components/chat/MessageItem'
import { ShareButton } from '@/components/share/ShareButton'
import { DesignGallery } from '@/components/chat/DesignGallery'
import { TopBar } from '@/components/layout/TopBar'
import { JobCard } from '@/components/media/JobCard'
import { Badge, Button, LoadingState } from '@/components/ui'
import { kindMeta } from '@/lib/kinds'
import { useStore } from '@/store/useStore'
import type { Agent, SessionKind } from '@/types'
import { useT } from '@/lib/useT'

/** What a design system changes on each surface; audio and video are unaffected. */
const DESIGN_REACHES: Partial<Record<SessionKind, string>> = {
  chat: '이 대화의 말투를 이 디자인에 맞춥니다',
  report: '보고서의 말투와 색, 서체를 이 디자인에 맞춥니다',
  slides: '슬라이드의 말투와 색, 서체를 이 디자인에 맞춥니다',
  image: '그림의 색과 스타일을 이 디자인에 맞춥니다',
}

/** Agent, project and design this empty session carries; the 서식 chip lives in the composer instead. */
function StartingFrom({
  sessionId,
  kind,
  withoutAgent,
}: {
  sessionId?: string | null
  kind: SessionKind
  /** Omit the agent row when the agent is already the headline. */
  withoutAgent?: boolean
}) {
  const t = useT()
  const session = useStore((s) => s.sessions.find((c) => c.id === sessionId))
  const found = useStore((s) => s.agents.find((a) => a.id === session?.agentId))
  const agent = withoutAgent ? undefined : found
  const project = useStore((s) => s.projects.find((p) => p.id === session?.projectId))
  // The design comes with the project.
  const design = useStore((s) => s.designs.find((d) => d.id === project?.designSystemId))
  const designReach = DESIGN_REACHES[kind]

  if (!agent && !project) return null

  const rows = [
    agent && {
      key: 'agent',
      icon: <Bot size={13} />,
      label: t('이 에이전트가 답합니다'),
      name: agent.name,
      says: agent.description,
      colour: agent.color,
    },
    project && {
      key: 'project',
      icon: <Boxes size={13} />,
      label: t('이 프로젝트의 지침과 자료를 함께 씁니다'),
      name: `${project.emoji} ${project.name}`.trim(),
      says: project.description,
      colour: undefined,
    },
    design &&
      designReach && {
        key: 'design',
        icon: <Palette size={13} />,
        label: t(designReach),
        name: design.name,
        says: design.description,
        colour: design.tokens.accent,
      },
  ].filter(Boolean) as {
    key: string
    icon: React.ReactNode
    label: string
    name: string
    says: string
    colour?: string
  }[]

  return (
    <div className="animate-fade-up mb-5 rounded-card border border-line bg-panel">
      <p className="border-b border-line px-3.5 py-2 text-xs font-medium tracking-wide text-faint uppercase">
        {t('이 대화가 가지고 시작하는 것')}
      </p>
      <div className="divide-y divide-line">
        {rows.map((row) => (
          <div key={row.key} className="flex items-start gap-2.5 px-3.5 py-2.5">
            <span
              className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-control text-white"
              style={{ background: row.colour ?? 'var(--color-faint)' }}
            >
              {row.icon}
            </span>
            <div className="min-w-0">
              <p className="text-base">
                <span className="font-medium">{row.name}</span>
                <span className="ml-1.5 text-sm text-faint">{row.label}</span>
              </p>
              {row.says && <p className="mt-0.5 text-sm text-muted">{row.says}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The agent's guide text and starter sentences; a starter is sent as-is. */
function AgentGuide({
  agent,
  sessionId,
  kind,
}: {
  agent: Agent
  sessionId: string | null
  kind: SessionKind
}) {
  const t = useT()
  const navigate = useNavigate()
  const send = useStore((s) => s.send)
  const streaming = useStore((s) => !!sessionId && !!s.running[sessionId])
  if (!agent.guide && agent.starters.length === 0) return null
  return (
    <div className="animate-fade-up mx-auto mb-6 w-full max-w-2xl">
      {agent.guide && (
        <div className="flex items-start gap-3 rounded-card border border-line bg-panel px-4 py-3 text-base leading-relaxed text-muted">
          <Info size={15} className="mt-1 shrink-0 text-faint" />
          <p className="whitespace-pre-wrap">{agent.guide}</p>
        </div>
      )}
      {agent.starters.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-center text-xs font-semibold tracking-wide text-faint uppercase">
            {t('이렇게 시작해 보세요')}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {agent.starters.map((line) => (
              <button
                key={line}
                disabled={streaming}
                onClick={() =>
                  void send(sessionId, kind, line, {
                    onSession: (id) => navigate(`/s/${id}`, { replace: true }),
                  })
                }
                className="max-w-full rounded-full border border-line bg-panel px-3.5 py-1.5 text-left text-sm text-fg transition-colors hover:border-accent/40 hover:bg-accent-soft disabled:opacity-50"
              >
                {line}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Empty state shown before the first prompt of a fresh session. */
function Intro({
  kind,
  sessionId,
}: {
  kind: SessionKind
  sessionId?: string | null
}) {
  const t = useT()
  const user = useStore((s) => s.user)
  const meta = kindMeta[kind]
  const Icon = meta.icon
  const agent = useStore((s) =>
    s.agents.find((a) => a.id === s.sessions.find((c) => c.id === sessionId)?.agentId),
  )
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 pb-8">
      <div className="animate-fade-up mb-7 text-center">
        <div
          className="mx-auto mb-4 grid size-11 place-items-center rounded-panel text-white"
          style={{ background: agent ? agent.color : meta.color }}
        >
          {agent ? <Bot size={20} /> : <Icon size={20} />}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {agent
            ? agent.name
            : kind === 'chat'
              ? t('안녕하세요, {name}님').replace('{name}', user?.name ?? '')
              : t(meta.label)}
        </h1>
        <p className="mt-1.5 text-base text-muted">
          {agent
            ? agent.description || t('이 에이전트로 대화를 시작합니다.')
            : kind === 'chat'
              ? t('무엇을 도와드릴까요?')
              : t(meta.tagline)}
        </p>
        {agent && !agent.guide && (
          <p className="mt-2 text-sm text-faint">
            {t('{kind}에서 이 에이전트의 지시대로 답합니다.').replace('{kind}', t(meta.label))}
          </p>
        )}
      </div>
      {agent && <AgentGuide agent={agent} sessionId={sessionId ?? null} kind={kind} />}
      <StartingFrom sessionId={sessionId} kind={kind} withoutAgent={Boolean(agent)} />
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <DesignGallery kind={kind} sessionId={sessionId ?? null} />
      </div>
    </div>
  )
}

export function SessionPage() {
  const t = useT()
  const { sessionId } = useParams()
  // Selectors, not the whole store: `MessageItem`'s memo keys on these rows.
  const jobs = useStore((s) => s.jobs)
  const projects = useStore((s) => s.projects)
  const agents = useStore((s) => s.agents)
  const artifacts = useStore((s) => s.artifacts)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const openSession = useStore((s) => s.openSession)
  const streaming = useStore((s) => !!sessionId && !!s.running[sessionId])
  const openArtifactId = useStore((s) => s.openArtifactId)
  const openArtifact = useStore((s) => s.openArtifact)

  const [searchParams, setSearchParams] = useSearchParams()
  // `?artifact=` opens a specific document instead of the session's latest.
  const requestedArtifactId = searchParams.get('artifact')
  const session = useStore((s) => s.sessions.find((c) => c.id === sessionId) ?? null)
  const kind: SessionKind = session?.kind ?? 'chat'
  const meta = kindMeta[kind]

  useEffect(() => {
    setActiveSession(session?.id ?? null)
  }, [session?.id, setActiveSession])

  // Deletes an empty session on leave, unless it holds an unsent draft.
  // Deferred a tick so StrictMode's mount/cleanup/mount and a return to the same id cancel it.
  const pendingCleanup = useRef<{ id: string; timer: number } | null>(null)
  useEffect(() => {
    const id = sessionId
    if (!id) return
    if (pendingCleanup.current?.id === id) {
      window.clearTimeout(pendingCleanup.current.timer)
      pendingCleanup.current = null
    }
    return () => {
      const timer = window.setTimeout(() => {
        pendingCleanup.current = null
        const row = useStore.getState().sessions.find((c) => c.id === id)
        if (!row) return
        const hasWork =
          row.messages.length > 0 ||
          row.messageCount > 0 ||
          row.artifactId !== null ||
          row.made !== null ||
          hasUnsentDraft(id) ||
          useStore.getState().jobs.some((j) => j.sessionId === id)
        if (!hasWork) void useStore.getState().deleteSession(id)
      }, 0)
      pendingCleanup.current = { id, timer }
    }
  }, [sessionId])

  // The session list carries no transcript; a session opened by URL fetches its own.
  const loaded = session !== null && session.messages.length > 0
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [failedLoad, setFailedLoad] = useState<{ id: string; attempt: number } | null>(null)
  useEffect(() => {
    let current = true
    if (sessionId && !loaded) {
      const completed = () => {
        // openSession retains its shared, non-throwing contract; absence is not a new chat.
        if (current && !useStore.getState().sessions.some((row) => row.id === sessionId)) {
          setFailedLoad({ id: sessionId, attempt: loadAttempt })
        }
      }
      void openSession(sessionId).then(completed, completed)
    }
    return () => { current = false }
  }, [sessionId, loaded, openSession, loadAttempt])

  // Messages and jobs share one timeline, ordered by creation.
  const timeline = useMemo(() => {
    if (!session) return []
    const sessionJobs = jobs.filter((j) => j.sessionId === session.id)
    const items = [
      ...session.messages.map((m) => ({ t: m.createdAt, node: { type: 'message' as const, m } })),
      ...sessionJobs.map((j) => ({ t: j.createdAt, node: { type: 'job' as const, j } })),
    ]
    return items.sort((a, b) => +new Date(a.t) - +new Date(b.t)).map((i) => i.node)
  }, [session, jobs])

  // Outline card index: end of the transcript while pending, above the running turn once accepted.
  const proposalAt = useMemo(() => {
    if (!session?.pending) return -1
    if (!streaming) return timeline.length
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]
      if (item.type === 'message' && item.m.role === 'user') return i
    }
    return timeline.length
  }, [session?.pending, streaming, timeline])
  const proposal = session?.pending ? (
    <ProposalCard sessionId={session.id} pending={session.pending} kind={kind} />
  ) : null

  const scrollRef = useRef<HTMLDivElement>(null)
  const lastLength = session?.messages.at(-1)?.content.length ?? 0
  const runningProgress = jobs.find(
    (j) => j.sessionId === session?.id && j.status === 'running',
  )?.progress
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' })
  }, [timeline.length, lastLength, runningProgress, streaming])

  // Applied once the session is loaded, then cleared so a closed panel stays closed.
  useEffect(() => {
    if (!requestedArtifactId || !session) return
    openArtifact(requestedArtifactId)
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('artifact')
        return next
      },
      { replace: true },
    )
    // Session by id: its identity changes on every streamed token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedArtifactId, session?.id, openArtifact, setSearchParams])

  const project = projects.find((p) => p.id === session?.projectId)
  const agent = agents.find((a) => a.id === session?.agentId)
  const sessionArtifact = artifacts.find(
    (a) => a.id === (requestedArtifactId ?? session?.artifactId),
  )
  const Icon = meta.icon

  if (!session) {
    const failed = failedLoad?.id === sessionId && failedLoad?.attempt === loadAttempt
    return (
      <>
        <TopBar left={<span className="text-base font-medium">{t('작업')}</span>} />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          {failed ? (
            <div role="alert" className="flex max-w-sm flex-col items-center gap-3 text-center">
              <p className="text-base text-muted">{t('최신 내용을 불러오지 못했습니다.')}</p>
              <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                <RotateCw size={14} />
                {t('다시 시도')}
              </Button>
            </div>
          ) : <LoadingState />}
        </div>
      </>
    )
  }

  return (
    <>
      <TopBar
        left={
          <div className="flex min-w-0 items-center gap-2">
            <Icon size={14} className="shrink-0" style={{ color: meta.color }} />
            <span className="truncate text-base font-medium">
              {session?.title ?? t('새 {kind}').replace('{kind}', t(meta.label))}
            </span>
            {project && (
              <Badge tone="accent" className="max-sm:hidden">
                <Boxes size={11} />
                {project.name}
              </Badge>
            )}
            {agent && (
              <Badge className="max-sm:hidden">
                <Bot size={11} />
                {agent.name}
              </Badge>
            )}
          </div>
        }
        right={
          <>
            {session && <ShareButton session={session} />}
            {sessionArtifact && !openArtifactId && (
              <Button size="sm" onClick={() => openArtifact(sessionArtifact.id)}>
                <PanelRight size={14} />
                {t(meta.panelLabel)}
              </Button>
            )}
          </>
        }
      />

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {session && timeline.length > 0 ? (
            <>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
                  {/* Per-message boundary: one malformed turn loses only its own bubble. */}
                  {timeline.map((item, i) =>
                    item.type === 'message' ? (
                      <Fragment key={item.m.id}>
                        {i === proposalAt && proposal}
                        <ErrorBoundary>
                          <MessageItem
                            message={item.m}
                            sessionId={session.id}
                            streaming={streaming && i === timeline.length - 1}
                          />
                        </ErrorBoundary>
                      </Fragment>
                    ) : (
                      <JobCard key={item.j.id} job={item.j} />
                    ),
                  )}
                  {proposalAt === timeline.length && proposal}
                </div>
              </div>
              <Composer
                sessionId={session.id}
                kind={kind}
                projectId={session.projectId}
                autoFocus
              />
            </>
          ) : (
            <>
              <Intro kind={kind} sessionId={session?.id ?? sessionId ?? null} />
              {/* URL id first: the row may not have arrived yet, and `null` would start a new session. */}
              <Composer
                sessionId={session?.id ?? sessionId ?? null}
                kind={kind}
                projectId={session?.projectId ?? null}
                autoFocus
              />
            </>
          )}
        </div>
        {openArtifactId && <ArtifactPanel />}
      </div>
    </>
  )
}
