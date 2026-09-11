import {
  Check,
  ChevronDown,
  Cpu,
  Eye,
  Gauge,
  Plug,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { useState } from 'react'
import { Badge, Dropdown, useMenuClose } from '@/components/ui'
import { cn, formatTokens } from '@/lib/utils'
import { effectiveModelId, useStore } from '@/store/useStore'
import type { ModelInfo, RoutingMode, SessionKind } from '@/types'
import { useT } from '@/lib/useT'

/** Price label in the modality's own unit; text models quote both directions. */
function rateLabel(m: ModelInfo, t: (s: string) => string): string {
  if (m.modality === 'image') return t('{n} 크레딧 / 장').replace('{n}', (m.creditPerImage ?? m.creditCost).toLocaleString())
  if (m.modality === 'video') {
    // Rate varies by resolution and sound, so the range is shown.
    const rates = Object.values(m.creditPerSecond ?? {})
    if (!rates.length) return t('가격 미상')
    const low = Math.min(...rates)
    const high = Math.max(...rates)
    return low === high
      ? t('{n} 크레딧 / 초').replace('{n}', low.toLocaleString())
      : t('{low}~{high} 크레딧 / 초')
          .replace('{low}', low.toLocaleString())
          .replace('{high}', high.toLocaleString())
  }
  if (m.modality === 'audio') {
    return m.creditPerCall
      ? t('{n} 크레딧 / 회').replace('{n}', m.creditPerCall.toLocaleString())
      : t('{n} 크레딧').replace('{n}', m.creditCost.toLocaleString())
  }
  if (m.creditCost === 0 && m.inputCreditCost === 0) {
    return t('무료')
  }
  return t('1k 토큰당 입력 {in} · 출력 {out} 크레딧')
    .replace('{in}', m.inputCreditCost.toLocaleString())
    .replace('{out}', m.creditCost.toLocaleString())
}

/** Row count from which the search box is shown. */
const SEARCHABLE_FROM = 8

/** Data-boundary label and tone for a model. */
function boundary(m: ModelInfo, t: (s: string) => string): { text: string; tone: string } | null {
  if (m.strictLocal) return { text: 'strict-local', tone: 'text-success' }
  if (m.dataBoundary === 'self_hosted') {
    return { text: t('self-hosted · strict 미확인'), tone: 'text-warn' }
  }
  // hybrid, external and unknown share a tone: the server ranks them together.
  if (m.dataBoundary === 'hybrid') return { text: t('외부 전환 가능'), tone: 'text-warn' }
  if (m.dataBoundary === 'external') return { text: t('외부 제공'), tone: 'text-warn' }
  if (m.dataBoundary === 'unknown') return { text: t('경계 미확인'), tone: 'text-warn' }
  return null
}

export function ModelPicker({
  kind,
  sessionId,
  compact = false,
  variant = 'toolbar',
  label,
  modality,
  onEnableAuto,
  onBusyChange,
}: {
  kind: SessionKind
  /** When set, the picker reads and writes this session's model. */
  sessionId?: string | null
  compact?: boolean
  /** `field` styles the trigger as a form control (settings). */
  variant?: 'toolbar' | 'field'
  /** Accessible name prefix for the field variant. */
  label?: string
  /** Narrows `av` models to audio or video. */
  modality?: ModelInfo['modality']
  /** Enables Auto routing; on `/new/chat` the composer creates the session first. */
  onEnableAuto?: (mode: RoutingMode) => void | Promise<void>
  /** Reports an in-flight selection so a turn does not race it. */
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useT()
  const field = variant === 'field'
  const [selectionPending, setSelectionPending] = useState(false)
  const {
    models,
    modelByKind,
    avModelByMode,
    agents,
    setModel,
    setSessionModel,
    setSessionRoutingMode,
    sessions,
    modelsLoading,
    litellmAvailable,
    autoRouting,
  } = useStore()
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined
  const usable = models.filter(
    (m) => m.kinds.includes(kind) && (!modality || m.modality === modality),
  )

  // Inside a session, what it will run on; outside one, an av picker with a
  // modality shows the model remembered for that mode.
  const currentId =
    !session && kind === 'av' && (modality === 'audio' || modality === 'video')
      ? avModelByMode[modality] || effectiveModelId(session, kind, agents, modelByKind)
      : effectiveModelId(session, kind, agents, modelByKind)
  const active = usable.find((m) => m.id === currentId) ?? usable[0]
  const autoLane = kind === 'chat' && session?.routingMode !== 'manual'
    ? session?.routingMode
    : undefined
  const autoActive = autoLane === 'auto' || autoLane === 'auto_quality'
  const unresolvedAgentModel = !autoActive &&
    (kind === 'chat' || kind === 'report' || kind === 'slides') &&
    Boolean(session?.agentId && !session.model && !agents.some((agent) => agent.id === session.agentId))
  // Auto belongs to a session, so it needs one or a caller that can create one.
  const canRouteAuto = kind === 'chat' && (Boolean(sessionId) || Boolean(onEnableAuto))
  const persistSelection = async (action: () => void | Promise<void>) => {
    if (selectionPending) return
    setSelectionPending(true)
    onBusyChange?.(true)
    try {
      await action()
    } finally {
      setSelectionPending(false)
      onBusyChange?.(false)
    }
  }

  if (!active) {
    return (
      <span
        className={cn(
          'flex items-center gap-1.5 text-base text-faint',
          field ? 'h-9 w-full rounded-control border border-line bg-panel px-3' : 'px-2 py-1.5',
        )}
      >
        <Cpu size={14} />
        {modelsLoading ? t('모델 불러오는 중…') : t('사용 가능한 모델 없음')}
      </span>
    )
  }
  const modelLabel = unresolvedAgentModel ? t('Agent 기본 모델') : active.label

  return (
    <Dropdown
      align={field ? 'left' : 'right'}
      className={
        field
          ? 'w-full min-w-0'
          : 'w-[calc(100vw-2rem)] max-w-[340px] min-w-0 sm:w-auto sm:min-w-[340px]'
      }
      trigger={({ open }) => (
        <button
          type="button"
          disabled={selectionPending}
          aria-busy={selectionPending}
          aria-label={label ? `${label}: ${modelLabel}` : undefined}
          className={cn(
            'flex h-9 items-center gap-1.5 rounded-control text-base font-medium transition-colors',
            field
              ? cn(
                  'w-full justify-between border bg-panel px-3',
                  open ? 'border-accent' : 'border-line hover:border-line-strong',
                )
              : cn(
                  'min-w-0 px-2.5',
                  open ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated hover:text-fg',
                ),
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {autoActive ? <Gauge size={14} /> : <Cpu size={14} />}
            <span className={cn('truncate', !field && 'max-w-[220px] phone:max-w-[38vw]')}>
              {autoActive
                ? `${autoLane === 'auto_quality' ? t('Auto · 품질 우선') : t('Auto · 비용 절약')} · ${modelLabel}`
                : modelLabel}
            </span>
          </span>
          {!compact && <ChevronDown size={14} className="shrink-0 text-faint" />}
        </button>
      )}
    >
      <ModelMenu
        usable={usable}
        active={active}
        unresolvedAgentModel={unresolvedAgentModel}
        autoLane={autoLane}
        autoRouting={autoRouting}
        showAuto={canRouteAuto}
        litellmAvailable={litellmAvailable}
        selectionPending={selectionPending}
        onAuto={(mode) => {
          return persistSelection(() => {
            if (onEnableAuto) return onEnableAuto(mode)
            if (sessionId) return setSessionRoutingMode(sessionId, mode)
          })
        }}
        onPick={(id) => {
          // Keyed off `sessionId`, not the session row: the list can lag behind the URL.
          return persistSelection(() => {
            if (sessionId) return setSessionModel(sessionId, id)
            setModel(kind, id)
          })
        }}
      />
    </Dropdown>
  )
}

/** Menu body; split out so it can call `useMenuClose` inside the Dropdown context. */
function ModelMenu({
  usable,
  active,
  unresolvedAgentModel,
  autoLane,
  autoRouting,
  showAuto,
  litellmAvailable,
  selectionPending,
  onAuto,
  onPick,
}: {
  usable: ModelInfo[]
  active: ModelInfo
  unresolvedAgentModel: boolean
  autoLane: RoutingMode | undefined
  autoRouting: ReturnType<typeof useStore.getState>['autoRouting']
  showAuto: boolean
  litellmAvailable: boolean
  selectionPending: boolean
  onAuto: (mode: RoutingMode) => void | Promise<void>
  onPick: (id: string) => void | Promise<void>
}) {
  const t = useT()
  const closeMenu = useMenuClose()
  // Search matches label and id.
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? usable.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(needle))
    : usable
  // Vendor groups in catalogue order.
  const groups = [...shown.reduce((map, m) => {
    const vendor = m.vendor || m.provider
    map.set(vendor, [...(map.get(vendor) ?? []), m])
    return map
  }, new Map<string, ModelInfo[]>())]
  const autoReason =
    autoRouting.reason === 'classifier_unavailable'
      ? t('strict-local 분류 모델을 사용할 수 없습니다.')
      : autoRouting.reason === 'no_economy_models'
        ? t('사용 가능한 절약 모델이 없습니다.')
        : t('관리자가 Auto 비용 절약을 켜지 않았습니다.')
  const qualityReason =
    autoRouting.qualityReason === 'classifier_unavailable'
      ? t('strict-local 분류 모델을 사용할 수 없습니다.')
      : autoRouting.qualityReason === 'no_quality_models'
        ? t('관리자가 상향할 모델을 지정하지 않았습니다.')
        : t('관리자가 Auto 품질 우선을 켜지 않았습니다.')
  const lanes: { mode: RoutingMode; title: string; available: boolean; blurb: string }[] = [
    {
      mode: 'auto',
      title: t('Auto · 비용 절약'),
      available: autoRouting.available,
      blurb: autoRouting.available
        ? t('간단한 질문은 관리자가 지정한 절약 모델로 보내고, 복잡하면 현재 모델을 유지합니다.')
        : autoReason,
    },
    {
      mode: 'auto_quality',
      title: t('Auto · 품질 우선'),
      available: autoRouting.qualityAvailable,
      blurb: autoRouting.qualityAvailable
        ? t('복잡한 요청만 관리자가 지정한 상위 모델로 보내고, 그 밖에는 현재 모델을 유지합니다. 데이터가 지금보다 멀리 나가지는 않습니다.')
        : qualityReason,
    },
  ]
  return (
    <>
      {showAuto && (
        <div className="border-b border-line p-1.5">
          {lanes.map((lane) => (
            <button
              key={lane.mode}
              type="button"
              disabled={!lane.available || selectionPending}
              onClick={() => {
                void onAuto(lane.mode)
                closeMenu()
              }}
              className="flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="mt-0.5 w-4 shrink-0 text-accent">
                {autoLane === lane.mode ? <Check size={14} /> : <Gauge size={14} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-base font-semibold">{lane.title}</span>
                  <Badge tone={lane.available ? 'success' : 'neutral'}>
                    {lane.available ? t('사용 가능') : t('사용 불가')}
                  </Badge>
                </span>
                <span className="mt-0.5 block text-sm text-muted">{lane.blurb}</span>
                <span className="mt-1 block truncate text-xs text-faint">
                  {lane.mode === 'auto_quality' ? t('현재 모델') : t('품질 모델')}: {unresolvedAgentModel ? t('Agent 기본 모델') : active.label}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="px-2.5 pt-2 pb-1 text-xs font-semibold tracking-wide text-faint uppercase">
        {showAuto ? t('모델 직접 선택') : t('모델')}
      </div>
      {usable.length > SEARCHABLE_FROM && (
        <div className="px-1.5 pb-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('모델 찾기')}
            aria-label={t('모델 찾기')}
            autoComplete="off"
            className="h-8 w-full rounded-control border border-line bg-panel px-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            // Typing must not walk the menu's focus; Escape still closes it.
            onKeyDown={(e) => {
              if (e.key !== 'Escape') e.stopPropagation()
            }}
          />
          {needle && shown.length === 0 && (
            <p className="px-1 pt-1.5 text-sm text-faint">{t('맞는 모델이 없습니다.')}</p>
          )}
        </div>
      )}
      {!litellmAvailable && (
        <div className="mx-1.5 mb-1 flex items-start gap-2 rounded-control border border-warn/30 bg-warn/5 px-2.5 py-2 text-sm text-warn">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            {t('모델 목록을 모두 불러오지 못했습니다. 지금은 일부 모델만 고를 수 있습니다.')}
          </span>
        </div>
      )}
      {groups.map(([vendor, rows]) => (
        <div key={vendor}>
          {groups.length > 1 && (
            <div className="px-2.5 pt-2 pb-0.5 text-2xs font-semibold tracking-wide text-faint uppercase">
              {vendor}
            </div>
          )}
          {rows.map((m) => {
            const boundaryOf = boundary(m, t)
            const free = m.creditCost === 0 && m.inputCreditCost === 0
            return (
        <button
          key={m.id}
          type="button"
          onClick={() => {
            void onPick(m.id)
            closeMenu()
          }}
          disabled={selectionPending}
          className="flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-55"
        >
          <span className="mt-0.5 w-4 shrink-0 text-accent">
            {!unresolvedAgentModel && m.id === active.id && <Check size={14} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {/* Under a vendor heading the row shows the bare name; `label` includes the vendor. */}
              <span className="truncate text-base font-medium">
                {groups.length > 1 ? m.name : m.label}
              </span>
              {m.adapter && (
                <Badge tone="warn">
                  <Plug size={10} />
                  {t('어댑터')}
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block truncate text-sm text-muted">{m.description}</span>
            <span className="mt-1 flex items-center gap-2 text-xs text-faint">
              <span className="flex items-center gap-1">
                {boundaryOf && (
                  <span className={cn('flex items-center gap-1', boundaryOf.tone)}>
                    {m.strictLocal && <ShieldCheck size={11} />}
                    {boundaryOf.text}
                  </span>
                )}
                {boundaryOf && <span aria-hidden>/</span>}
                <span className={cn(free && 'text-free')}>{rateLabel(m, t)}</span>
              </span>
              {m.contextWindow && <span>{formatTokens(m.contextWindow)} ctx</span>}
              {m.supportsVision && <Eye size={11} />}
              {m.supportsTools && <Wrench size={11} />}
            </span>
          </span>
        </button>
            )
          })}
        </div>
      ))}
    </>
  )
}
