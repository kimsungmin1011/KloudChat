import {
  AudioLines,
  BarChart3,
  Calculator,
  Check,
  CircleStop,
  Copy,
  Download,
  FilePenLine,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Presentation,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Video,
} from 'lucide-react'
import { memo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button } from '@/components/ui'
import { MediaResult } from '@/components/media/MediaResult'
import { downloadFile, errorMessage, filesApi, templateText } from '@/lib/api'
import { currentLang } from '@/lib/i18n'
import { FINDING_LABEL } from '@/lib/privacy'
import { cn, fileSize, formatTokens, isMedia } from '@/lib/utils'
import { useStore } from '@/store/useStore'
import type { ArtifactKind, CostRouting, Message, ModelInfo } from '@/types'
import { CompareView } from './CompareView'
import { Markdown } from './Markdown'
import { RetryActions } from './RetryActions'
import { StepTimeline } from './StepTimeline'
import { TurnProgress } from './TurnProgress'
import { copyText } from '@/lib/clipboard'
import { useT } from '@/lib/useT'

const artifactIcon: Record<ArtifactKind, typeof FileText> = {
  report: FileText,
  deck: Presentation,
  chart: BarChart3,
  image: ImageIcon,
  audio: AudioLines,
  video: Video,
  code: FileText,
  html: FileText,
}

const artifactLabel: Record<ArtifactKind, string> = {
  report: '보고서',
  deck: '슬라이드',
  chart: '차트',
  image: '이미지',
  audio: '오디오',
  video: '동영상',
  code: '코드',
  html: 'HTML',
}

function costRouteDecisionLabel(
  route: CostRouting,
  t: (text: string) => string,
): string {
  if (route.mode === 'auto_quality') {
    if (route.decision === 'routed') {
      return t('Auto · 품질 우선 · 상위 모델 선택')
    }
    if (route.decision === 'classifier_unavailable') {
      return t('Auto · 품질 우선 · 분류기를 사용할 수 없어 현재 모델 유지')
    }
    switch (route.reasonCode) {
      case 'low_complexity':
        return t('Auto · 품질 우선 · 간단한 요청으로 현재 모델 유지')
      case 'no_quality_model':
      case 'no_quality_models':
        return t('Auto · 품질 우선 · 사용할 상위 모델이 없어 현재 모델 유지')
      case 'input_too_long':
        return t('Auto · 품질 우선 · 긴 대화이므로 현재 모델 유지')
      case 'privacy_detected':
        return t('Auto · 품질 우선 · 개인정보 감지로 난이도 판정 생략')
      case 'unsupported_turn':
        return t('Auto · 품질 우선 · 기능 사용으로 현재 모델 유지')
      case 'disabled':
        return t('Auto · 품질 우선 · 관리 정책이 꺼져 현재 모델 유지')
      default:
        return route.decision === 'bypassed'
          ? t('Auto · 품질 우선 · 난이도 판정을 생략하고 현재 모델 유지')
          : t('Auto · 품질 우선 · 확실하지 않아 현재 모델 유지')
    }
  }
  if (route.decision === 'routed') {
    return t('Auto 절약')
  }
  if (route.decision === 'classifier_unavailable') {
    return t('Auto · 분류기를 사용할 수 없어 품질 모델 유지')
  }
  if (route.decision === 'bypassed') {
    if (route.reasonCode === 'calculation_required') {
      return t('Auto · 계산 도구 사용을 위해 품질 모델 유지')
    }
    if (route.reasonCode === 'privacy_detected') {
      return t('Auto · 개인정보 감지로 난이도 판정 생략')
    }
    if (route.reasonCode === 'unsupported_turn') {
      return t('Auto · 기능 사용으로 품질 모델 유지')
    }
    if (route.reasonCode === 'disabled') {
      return t('Auto · 관리 정책이 꺼져 품질 모델 유지')
    }
    if (route.reasonCode === 'no_economy_model' || route.reasonCode === 'no_economy_models') {
      return t('Auto · 사용할 절약 모델이 없어 품질 모델 유지')
    }
    return t('Auto · 난이도 판정을 생략하고 품질 모델 유지')
  }
  if (route.reasonCode === 'high_complexity') {
    return t('Auto · 복잡한 요청으로 품질 모델 유지')
  }
  if (route.reasonCode === 'input_too_long') {
    return t('Auto · 긴 대화이므로 품질 모델 유지')
  }
  if (route.reasonCode === 'no_economy_model' || route.reasonCode === 'no_economy_models') {
    return t('Auto · 사용할 절약 모델이 없어 품질 모델 유지')
  }
  return t('Auto · 확실하지 않아 품질 모델 유지')
}

function modelPresentation(
  id: string | undefined,
  models: ModelInfo[],
  t: (text: string) => string,
): { label: string; detail: string } {
  if (!id) {
    const pending = t('확인 중…')
    return { label: pending, detail: pending }
  }
  const label = models.find((model) => model.id === id)?.label ?? id
  return {
    label,
    detail: label === id ? id : `${label} (${id})`,
  }
}

function costRoutePresentation(
  route: CostRouting,
  models: ModelInfo[],
  t: (text: string) => string,
): { label: string; title: string } {
  const requested = modelPresentation(route.requestedModel, models, t)
  const selected = modelPresentation(route.selectedModel, models, t)
  const executed = modelPresentation(route.executedModel, models, t)
  const decision = costRouteDecisionLabel(route, t)
  const saved = route.estimatedCreditsSaved
    ? ` · ${t('예상 {n} 크레딧 절약').replace('{n}', route.estimatedCreditsSaved.toLocaleString())}`
    : ''
  const visibleModels = [
    `${t('요청 모델')}: ${requested.label}`,
    `${t('선택 모델')}: ${selected.label}`,
    `${t('실행 모델')}: ${executed.label}`,
  ].join(' · ')
  const detailedModels = [
    `${t('요청 모델')}: ${requested.detail}`,
    `${t('선택 모델')}: ${selected.detail}`,
    `${t('실행 모델')}: ${executed.detail}`,
  ].join(' · ')
  return {
    label: `${decision} · ${visibleModels}${saved}`,
    title: detailedModels,
  }
}

/** Failure notice for a turn; the live `error` wins over the stored `failure`. */
function turnFailureNotice(
  message: Message,
  media: boolean,
  t: (text: string) => string,
): string | undefined {
  if (message.error) return message.error
  if (message.failure === 'stopped') {
    return media ? t('요청한 만큼 만들어지지 않았습니다.') : t('여기서 멈췄습니다.')
  }
  if (message.failure === 'interrupted') {
    return media
      ? t('요청한 만큼 만들어지지 않았습니다.')
      : t('답변이 중간에 끊겨 여기까지만 남았습니다.')
  }
  if (message.failure === 'no_answer') {
    return media ? t('만들지 못했습니다.') : t('답변을 받지 못했습니다.')
  }
  return undefined
}

/** One turn of the transcript. Memoised; reads the store through narrow selectors so streaming re-renders one row. */
function MessageItemInner({
  message,
  sessionId,
  streaming,
}: {
  message: Message
  sessionId: string
  streaming?: boolean
}) {
  const t = useT()
  const artifacts = useStore((s) => s.artifacts)
  const openArtifact = useStore((s) => s.openArtifact)
  const rateMessage = useStore((s) => s.rateMessage)
  const retryMediaTurn = useStore((s) => s.retryMediaTurn)
  const models = useStore((s) => s.models)
  const user = useStore((s) => s.user)
  const designTemplates = useStore((s) => s.designTemplates)
  const sessionKind = useStore((s) => s.sessions.find((c) => c.id === sessionId)?.kind)
  const renderTemplateId = useStore(
    (s) => s.sessions.find((c) => c.id === sessionId)?.renderTemplateId,
  )
  // The user row this answer was for; the retry needs its id.
  const askedAbove = useStore((s) => {
    const list = s.sessions.find((c) => c.id === sessionId)?.messages ?? []
    const at = list.findIndex((m) => m.id === message.id)
    if (at < 0) return undefined
    for (let i = at - 1; i >= 0; i--) if (list[i].role === 'user') return list[i]
    return undefined
  })
  // Surfaces whose answer is media rather than text.
  const madeHere = sessionKind === 'image' || sessionKind === 'av'
  const [copied, setCopied] = useState(false)
  const [badgesOpen, setBadgesOpen] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const navigate = useNavigate()

  /** Opens an attached `.hwpx` as an editable report; no model call. */
  const openAsDocument = async (id: string) => {
    setFileError(null)
    setOpening(id)
    try {
      const made = await filesApi.openAsDocument(id)
      navigate(`/s/${made.id}`)
    } catch (err) {
      setFileError(errorMessage(err, t('이 파일을 문서로 열지 못했습니다.')))
    } finally {
      setOpening(null)
    }
  }

  const take = async (id: string, name: string) => {
    setFileError(null)
    try {
      await downloadFile(id, name)
    } catch (err) {
      setFileError(errorMessage(err, t('파일을 내려받지 못했습니다.')))
    }
  }
  const model = models.find((m) => m.id === message.model)
  const toolAnswer = message.routing && 'answerOrigin' in message.routing &&
    message.routing.answerOrigin === 'tool_result' ? message.routing : null
  const freshness = message.routing && 'freshness' in message.routing ? message.routing : null
  const routing = message.routing && 'action' in message.routing ? message.routing : null
  const actualModelChanged = Boolean(
    routing?.actualModel && routing.actualModel !== routing.requestedModels[0],
  )
  const showRouting = Boolean(
    routing && (routing.action !== 'none' || actualModelChanged || routing.costRouting),
  )
  const messageBoundary =
    model?.dataBoundary ??
    (routing?.dataBoundary !== 'mixed' ? routing?.dataBoundary : undefined)

  const copyButton = (label: string) => (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={async () => {
        if (!(await copyText(message.content))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  )

  if (message.role === 'user') {
    // The template comes off the session (sticky); the starting point is stored on the turn.
    const shape = designTemplates.find((row) => row.id === renderTemplateId)
    const failed = turnFailureNotice(message, madeHere, t)
    const startedFrom = message.startedFrom
    // The stored copy is masked whenever there is a finding; the bubble holds
    // the typed original until the session is reopened.
    const redacted = (routing?.findingCounts ?? []).filter(
      (finding) => finding.source === 'current_input',
    )
    return (
      <div className="group animate-fade-up flex items-start justify-end gap-1">
        <span className="mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {copyButton('프롬프트 복사')}
        </span>
        <div className="max-w-[80%] space-y-2">
          {startedFrom && (
            <p className="text-right text-xs text-faint">
              {shape
                ? t('시작점 {name} · 서식 {title}')
                    .replace('{name}', startedFrom.title)
                    .replace('{title}', templateText(shape, currentLang() === 'en').name)
                : t('시작점 {name}').replace('{name}', startedFrom.title)}
            </p>
          )}
          {message.attachments?.map((a) => {
            const bytes = typeof a.size === 'number' ? fileSize(a.size) : a.size
            const chip = (
              <>
                <Paperclip size={13} className="text-faint" />
                <span className="truncate">{a.name}</span>
                {bytes && <span className="shrink-0 text-faint">{bytes}</span>}
              </>
            )
            const shell =
              'ml-auto flex w-fit max-w-full items-center gap-2 rounded-control border border-line bg-panel px-2.5 py-1.5 text-base'
            const hangul = Boolean(a.id) && /\.hwpx$/i.test(a.name)
            return a.id ? (
              <span key={a.id} className="ml-auto flex w-fit max-w-full items-center gap-1.5">
                {hangul && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={opening === a.id}
                    onClick={() => void openAsDocument(a.id!)}
                  >
                    {opening === a.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <FilePenLine size={13} />
                    )}
                    {t('문서로 열기')}
                  </Button>
                )}
                <button
                  type="button"
                  title={t('원본 파일을 내려받습니다')}
                  className={`${shell} transition-colors hover:border-strong hover:bg-elevated`}
                  onClick={() => void take(a.id!, a.name)}
                >
                  {chip}
                  <Download size={13} className="shrink-0 text-faint" />
                </button>
              </span>
            ) : (
              <div key={a.name} className={shell}>
                {chip}
              </div>
            )
          })}
          {fileError && <p className="text-right text-sm text-danger">{fileError}</p>}
          <div className="rounded-panel rounded-br-md bg-elevated px-4 py-2.5 text-md leading-[1.7] whitespace-pre-wrap phone:text-[1rem] phone:leading-[1.7]">
            {message.content}
          </div>
          {/* A turn with no reply reports its failure under the question. */}
          {failed && (
            <div
              role="status"
              className={cn(
                'flex items-center justify-end gap-2 text-base',
                // A stop the reader chose is not an error.
                message.failure === 'stopped' && !message.error ? 'text-muted' : 'text-danger',
              )}
            >
              {message.failure === 'stopped' && !message.error ? (
                <CircleStop size={14} className="shrink-0" />
              ) : (
                <TriangleAlert size={14} className="shrink-0" />
              )}
              <span>{failed}</span>
              {madeHere ? (
                <Button size="sm" onClick={() => void retryMediaTurn(sessionId, message.content)}>
                  <RotateCcw size={13} />
                  {t('다시 시도')}
                </Button>
              ) : (
                <RetryActions
                  sessionId={sessionId}
                  messageId={message.id}
                  prompt={message.content}
                  kind={sessionKind ?? 'chat'}
                />
              )}
            </div>
          )}
          {redacted.length > 0 && (
            <div className="space-y-1 text-right">
              <div className="flex flex-wrap justify-end gap-1.5">
                {redacted.map((finding) => (
                  <Badge key={finding.category} tone="warn">
                    <ShieldAlert size={10} />
                    {t(FINDING_LABEL[finding.category] ?? finding.category)} {finding.count}
                  </Badge>
                ))}
              </div>
              <p className="text-sm text-warn">
                {t('기록에는 가려진 채 저장됩니다. 이 대화를 다시 열면 여기에도 자리표시자만 남습니다.')}
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  const costRoute = routing?.costRouting
  const costRouteDisplay = costRoute ? costRoutePresentation(costRoute, models, t) : null
  const linked = (message.artifactIds ?? [])
    .map((id) => artifacts.find((a) => a.id === id))
    .filter((a) => a !== undefined)
  // Media is shown inline; documents are named as chips.
  const shown = linked.filter(isMedia)
  const named = linked.filter((a) => !isMedia(a))
  const failed = turnFailureNotice(message, madeHere, t)
  const stopped = !message.error && message.failure === 'stopped'
  // How many routing badges the row holds; a phone shows the count until tapped.
  const routingBadges = routing
    ? [
        costRoute && costRouteDisplay,
        routing.action !== 'none' &&
          routing.initialAction === 'send_raw_external' &&
          routing.action !== 'send_raw_external',
        routing.action !== 'none',
        messageBoundary,
        routing.toolOutputMasked,
        actualModelChanged && !routing.costRouting && routing.actualModel,
      ].filter(Boolean).length
    : 0

  return (
    <div className="animate-fade-up group flex gap-3">
      <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control bg-accent text-accent-fg">
        {toolAnswer ? <Calculator size={14} /> : <Sparkles size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        {toolAnswer && (
          <Badge
            tone="warn"
            className="mb-2 max-w-full whitespace-normal! [overflow-wrap:anywhere]"
            title={t('계산기가 직접 반환한 오류입니다. 답변 생성 비용만 0이며, 앞선 Auto 분류나 검색의 실행 여부와 비용은 별도입니다.')}
          >
            {t('계산 도구 결과 · 0으로 나눌 수 없음')}
          </Badge>
        )}
        {freshness && (
          <Badge
            tone="warn"
            className="mb-2 max-w-full whitespace-normal! [overflow-wrap:anywhere]"
            title={
              freshness.freshness.reason === 'lookup_failed_or_empty'
                ? t('검색이 실패했거나 확인 가능한 결과가 없어 서비스 정책으로 답변을 보류했습니다.')
                : t('검증 수단을 사용할 수 없어 서비스 정책으로 답변을 보류했습니다.')
            }
          >
            {t('서비스 정책 안내 · 최신 정보 검증 불가 · 모델 실행 없음')}
          </Badge>
        )}
        {routing && showRouting && routingBadges > 0 && (
          <button
            onClick={() => setBadgesOpen((o) => !o)}
            aria-expanded={badgesOpen}
            className="mb-2 hidden text-sm text-muted hover:text-fg phone:inline-block"
          >
            {badgesOpen
              ? t('처리 내역 접기')
              : t('처리 내역 {n}건').replace('{n}', String(routingBadges))}
          </button>
        )}
        {routing && showRouting && (
          <div className={cn('mb-2 flex flex-wrap gap-1.5', !badgesOpen && 'phone:hidden')}>
            {costRoute && costRouteDisplay && (
              <Badge
                tone={costRoute.decision === 'routed' ? 'success' : 'warn'}
                title={costRouteDisplay.title}
                className="max-w-full whitespace-normal! [overflow-wrap:anywhere]"
              >
                {costRouteDisplay.label}
              </Badge>
            )}
            {routing.action !== 'none' &&
              routing.initialAction === 'send_raw_external' &&
              routing.action !== 'send_raw_external' && (
                <Badge tone="warn">{t('확인 후 요청 원문은 외부 전송')}</Badge>
              )}
            {routing.action !== 'none' && (
              <Badge
                tone={routing.action === 'send_raw_external' ? 'warn' : 'success'}
              >
                {routing.action === 'route_strict_local' ||
                routing.action === 'strict_local'
                  ? t('strict-local로 보호됨')
                  : routing.action === 'mask_external'
                    ? t('개인정보를 가려 전송함')
                    : t('확인 후 외부 원문 전송')}
              </Badge>
            )}
            {messageBoundary && (
              <Badge tone={messageBoundary === 'self_hosted' ? 'success' : 'warn'}>
                {messageBoundary === 'self_hosted'
                  ? 'self-hosted'
                  : messageBoundary === 'hybrid'
                    ? t('외부 전환 가능')
                    : messageBoundary === 'external'
                      ? t('외부 제공')
                      : t('경계 미확인')}
              </Badge>
            )}
            {routing.toolOutputMasked ? (
              <Badge tone="warn">
                {t('도구 결과 {n}건 추가 마스킹').replace(
                  '{n}',
                  routing.toolOutputMasked.toLocaleString(),
                )}
              </Badge>
            ) : null}
            {actualModelChanged &&
              !routing.costRouting &&
              routing.actualModel && (
              <Badge title={routing.actualModel}>
                {t('실제 실행 모델')}: {routing.actualModel}
              </Badge>
              )}
          </div>
        )}
        {message.steps && message.steps.length > 0 && (
          <StepTimeline
            steps={message.steps}
            live={!!streaming}
            failed={!!failed}
            startedAt={new Date(message.createdAt).getTime()}
          />
        )}

        {message.variants ? (
          <CompareView
            variants={message.variants}
            sessionId={sessionId}
            messageId={message.id}
          />
        ) : message.content ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          // Only while the turn is running and nothing is there to read yet.
          !failed &&
          !toolAnswer &&
          !freshness &&
          streaming &&
          shown.length === 0 &&
          named.length === 0 && (
            <TurnProgress
              sessionId={sessionId}
              startedAt={new Date(message.createdAt).getTime()}
              label={madeHere ? t('만드는 중…') : t('생각하는 중…')}
              model={message.model ?? undefined}
            />
          )
        )}
        {streaming && message.content && (
          <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-blink bg-accent" />
        )}

        {shown.length > 0 && (
          <div className="mt-1">
            <MediaResult
              artifacts={shown}
              credits={message.usage?.credits ?? 0}
              sessionId={sessionId}
            />
          </div>
        )}

        {/* Below the partial answer, not instead of it. */}
        {failed && (
          <div
            role="status"
            className={cn(
              'mt-3 flex items-start gap-2 rounded-card border px-3 py-2.5 text-base',
              // A stop the reader chose is not an error.
              stopped
                ? 'border-line bg-elevated text-muted'
                : 'border-danger/30 bg-danger/5 text-danger',
            )}
          >
            {stopped ? (
              <CircleStop size={14} className="mt-0.5 shrink-0" />
            ) : (
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1">{failed}</span>
            {!madeHere && askedAbove && (
              <RetryActions
                sessionId={sessionId}
                messageId={askedAbove.id}
                prompt={askedAbove.content}
                kind={sessionKind ?? 'chat'}
              />
            )}
          </div>
        )}

        {named.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {named.map((a) => {
              const Icon = artifactIcon[a.kind]
              return (
                <button
                  key={a.id}
                  onClick={() => openArtifact(a.id)}
                  className="flex items-center gap-2 rounded-card border border-line bg-panel px-3 py-2 text-left transition-colors hover:border-accent hover:bg-elevated"
                >
                  <span className="grid size-7 place-items-center rounded-control bg-accent-soft text-accent">
                    <Icon size={14} />
                  </span>
                  <span>
                    <span className="block text-base font-medium">{a.title}</span>
                    <span className="block text-xs text-faint">
                      {artifactLabel[a.kind]} · v{a.version}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {!streaming && message.content && !message.variants && (
          <div className={cn('mt-2 flex items-center gap-1 text-faint', toolAnswer && 'max-sm:flex-wrap')}>
            <span className="flex items-center gap-1">
            {copyButton(t('복사'))}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('좋아요')}
              aria-pressed={message.liked === 'up'}
              title={t('이 답변이 도움이 되었습니다')}
              className={cn(message.liked === 'up' && 'text-success')}
              onClick={() => void rateMessage(sessionId, message.id, 'up')}
            >
              <ThumbsUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('싫어요')}
              aria-pressed={message.liked === 'down'}
              title={t('이 답변이 잘못되었습니다')}
              className={cn(message.liked === 'down' && 'text-danger')}
              onClick={() => void rateMessage(sessionId, message.id, 'down')}
            >
              <ThumbsDown size={14} />
            </Button>
            </span>
            {message.usage && user?.preferences.showUsage !== false && (
              <span className={cn('ml-1 text-xs', toolAnswer && 'max-sm:ml-0 max-sm:basis-full')}>
                {toolAnswer ? t('답변 모델 생성 없음')
                  : freshness ? t('모델 실행 없음') : model?.label ?? message.model} ·{' '}
                {message.usage.estimated ? '≈ ' : ''}
                {formatTokens(message.usage.inputTokens)} in ·{' '}
                {formatTokens(message.usage.outputTokens)} out ·{' '}
                {toolAnswer ? (
                  <span className="whitespace-nowrap">
                    {t('답변 {n} 크레딧').replace('{n}', message.usage.credits.toLocaleString())}
                  </span>
                ) : freshness || message.usage.credits > 0 ? (
                  t('{n} 크레딧').replace('{n}', message.usage.credits.toLocaleString())
                ) : (
                  <span
                    title={
                      messageBoundary === 'self_hosted'
                        ? t('직접 운영하는 모델이라 크레딧이 차감되지 않습니다')
                        : messageBoundary === 'external'
                          ? t('외부 제공자가 무료로 제공하는 모델입니다')
                          : messageBoundary === 'hybrid'
                            ? t('자체 운영 경로지만 외부 모델로 전환될 수 있습니다')
                            : t('모델의 데이터 경계 또는 가격 정보를 확인할 수 없습니다')
                    }
                  >
                    {t('무료')}
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const MessageItem = memo(MessageItemInner)
