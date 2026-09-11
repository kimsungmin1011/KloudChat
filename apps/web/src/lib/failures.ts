import { errorCode, errorMessage, type StreamEvent } from '@/lib/api'

/**
 * Actionable sentences for API refusal codes (`agent_disabled`,
 * `blocked_category:x`, …) and stream `error` events. Unknown codes are still
 * shown in brackets. Korean source strings, passed through the caller's `t`.
 */
type T = (text: string) => string

const SKILLS = '선택한 스킬을 이 요청에 적용할 수 없습니다. 스킬 선택을 바꿔 다시 시도하세요.'

const REFUSALS: Record<string, string> = {
  agent_disabled:
    '이 대화의 에이전트가 꺼져 있어 보낼 수 없습니다. 에이전트 화면에서 다시 켜거나 다른 대화를 시작하세요.',
  agent_not_found: '이 대화의 에이전트를 더는 찾을 수 없습니다. 새 대화를 시작하세요.',
  agent_kind_mismatch: '이 에이전트는 이 화면에서 쓸 수 없습니다.',
  agent_origin_gone:
    '이 에이전트는 지침을 원본에서 읽는데, 원본이 지워졌거나 공개가 풀렸습니다. 작성자에게 문의하거나 다른 에이전트를 쓰세요.',
  project_not_found: '이 대화의 프로젝트를 더는 찾을 수 없습니다.',
  session_not_found: '이 대화를 더는 찾을 수 없습니다.',
  attachment_not_found: '첨부 파일을 찾을 수 없습니다. 다시 첨부하세요.',
  skill_not_found: SKILLS,
  skill_not_installed: SKILLS,
  skill_kind_mismatch: SKILLS,
  too_many_skills: SKILLS,
  duplicate_skill_ids: SKILLS,
  model_unavailable: '이 모델은 지금 이 화면에서 쓸 수 없습니다. 모델을 바꿔 다시 시도하세요.',
  model_not_allowed: '이 계정에 허용되지 않은 모델입니다. 모델을 바꿔 다시 시도하세요.',
  no_models_available: '지금 사용할 수 있는 모델이 없습니다. 관리자에게 문의하세요.',
  calculation_tool_unavailable:
    '현재 모델이나 에이전트에서 허용된 계산 도구를 사용할 수 없습니다. 도구를 지원하는 모델로 바꾸거나 계산기를 허용한 에이전트로 다시 시도하세요.',
  freshness_verification_unavailable:
    '최신 정보를 검증할 수 없어 요청을 진행하지 않았습니다. 검증 가능한 자료를 제공하거나 검색이 허용된 환경에서 다시 시도하세요.',
  insufficient_credits: '이번 달 크레딧이 부족합니다.',
  no_credits: '이번 달 크레딧을 모두 썼습니다.',
  surface_not_implemented: '이 화면은 아직 지원되지 않습니다.',
  governance_unavailable:
    '개인정보 검사기를 사용할 수 없어 요청을 보내지 못했습니다. 잠시 후 다시 시도하세요.',
}

/** A refused request, by its code. `undefined` when there is no code at all. */
export function refusalSentence(code: string, t: T): string | undefined {
  if (!code) return undefined
  const known = REFUSALS[code]
  if (known) return t(known)
  if (code.startsWith('blocked_category:')) {
    return t('관리자 정책이 이 요청을 막았습니다 ({code}).').replace(
      '{code}',
      code.slice('blocked_category:'.length),
    )
  }
  return t('요청이 거부되었습니다 ({code}).').replace('{code}', code)
}

/** Sentence for a stream that ended in an `error` event; the upstream `reason` is quoted after it. */
export function streamFailureSentence(
  event: Extract<StreamEvent, { type: 'error' }>,
  t: T,
): string {
  const code = event.code ?? ''
  const status = /^upstream_(\d{3})$/.exec(code)?.[1]
  let sentence: string | undefined
  if (code === 'upstream_unreachable') {
    sentence = t(
      '모델 서버에 연결할 수 없습니다. 관리자가 설정 → 시스템 → 연동의 게이트웨이 주소와 상태를 확인해야 합니다.',
    )
  } else if (status === '401' || status === '403') {
    sentence = t('모델 서버가 인증을 거부했습니다. 관리자가 LiteLLM 키를 확인해야 합니다.')
  } else if (status === '404') {
    sentence = t('모델 서버에 이 모델이 없습니다. 모델을 바꿔 다시 시도하세요.')
  } else if (status === '429') {
    sentence = t('모델 서버의 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.')
  } else if (status?.startsWith('4')) {
    sentence = t('모델 서버가 요청을 거부했습니다.')
  } else if (status?.startsWith('5')) {
    sentence = t('모델 서버 오류로 답변을 받지 못했습니다. 잠시 후 다시 시도하세요.')
  }
  const text = sentence ?? t(event.message)
  return event.reason ? `${text} — ${event.reason}` : text
}

/** A conversation that could not be started from a card or a menu. */
export function startFailure(err: unknown, t: T): string {
  return refusalSentence(errorCode(err), t) ?? errorMessage(err, t('대화를 시작하지 못했습니다.'))
}
