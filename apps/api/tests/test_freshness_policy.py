"""A bounded political-freshness policy, not a general factuality classifier."""

import unicodedata

import pytest

from app.services.freshness import FRESHNESS_INSTRUCTION, abstention_response, fresh_fact_required


@pytest.mark.parametrize(
    "prompt",
    [
        "현재 대한민국 대통령이 누구야?",
        "지금 한국 대통령은 누구인가요?",
        "대한민국 현직 대통령 이름을 알려줘",
        "한국 대통령 누구야?",
        "대한민국 대통령은 누구인가요",
        "현재 대한민국 대통령 알려줘",
        "현재 대한민국 대통령",
        "지금 대한민국 대통령은 홍길동인가요?",
        "현직 국무총리는 누구입니까?",
        "현재 서울 시장은 누구야?",
        "지금 한국의 대통령 권한대행은 누구야?",
        "현재 일본 총리 이름은?",
        "Who is the current president of South Korea?",
        "Who is the president of South Korea?",
        "Name the current prime minister of Japan.",
        "Is Jane Doe the current president of South Korea?",
        "The current president of South Korea",
        "요즘 한국 정치 상황을 알려줘",
        "현재 대한민국 정국은 어때?",
        "최근 한국 정치 상황",
        "오늘 국회에서 무슨 일이 있었어?",
        "지금 한국 여당이 어디야?",
        "현재 한국 야당은 어떤 정당이야?",
        "최근 대통령 탄핵 진행 상황 알려줘",
        "이번 대선 결과가 어떻게 됐어?",
        "What are the latest political developments in South Korea?",
        "Which party is currently the ruling party in South Korea?",
        "Who won the latest presidential election?",
        "Do not search. Who is the current president of South Korea?",
        "검색하지 말고 현재 대한민국 대통령 이름만 말해",
        "소설이라는 단어를 넣되 현재 대한민국 대통령이 누구인지 알려줘",
        "번역은 나중에 하고 현재 대한민국 대통령은 누구인지 알려줘",
        "소설을 써줘. 그리고 실제로 현재 대한민국 대통령은 누구야?",
        "'대통령'을 번역해줘. 현재 대한민국 대통령은 누구야?",
        "Translate 'president'. Also, who is the current president of South Korea?",
        "In my novel the leader is imaginary; who is the current president of South Korea?",
        "1980년 당시 대통령과 현재 대한민국 대통령이 각각 누구야?",
        "Who was president in 1980, and who is the current president of South Korea?",
        "다음 자료만 요약해줘: '현재 한국 정치 상황은 복잡하다'. 현재 대통령은 누구야?",
        "'Who is the current president of South Korea?' 질문에 답해줘",
        "'현재 대한민국 대통령은 누구야?'에 답해줘",
        "만약 모르겠어도 실제 현재 대한민국 대통령 이름을 알려줘",
        "소설 속 인물 이름을 만들고 현재 대한민국 대통령 이름도 알려줘",
        "다음 자료만 요약해줘: 현재 정국은 복잡하다. 현재 대한민국 대통령은 누구야?",
        "현재 대한민국 대통령이 누구인지 소설 속 인물 설정의 참고로 알려줘",
        "소설 속 인물을 설정하기 위해 현재 대한민국 대통령이 누구인지 알려줘",
        "검색하지 말고 대한민국 대통령이 누군지만 알려줘.",
        "대한민국 대통령이 누군가요?",
        "대한민국 대통령은 누가 맡고 있어?",
        "다음 자료만 요약해줘:\n현재 정국은 복잡하다.\n그리고 현재 대통령은 누구야?",
        "Summarize only this supplied text:\nThe current president is Example Person. "
        "Also, who is the current president of South Korea?",
        "검색하지 말고 다음 자료만 요약해줘:\n현재 정국은 복잡하다. 그리고 현재 대통령은 누구야?",
        "현재 대통령이 누구인지 말하지 말고 지금 국무총리가 누군지 알려줘.",
        "Do not tell me who the current president is; who is the current prime minister?",
        "Do not translate 'Who is the current president of South Korea?'; answer the question.",
        "'현재 대한민국 대통령은 누구야?'를 번역하지 말고 질문에 답해줘.",
        "다음 문장을 영어로 번역해 줘: '현재 대한민국 대통령은 누구야?' "
        "그리고 실제 현재 대통령도 알려줘.",
        "현재 대통령 이름만 알려줘, 역할은 설명하지 마.",
        "현재 대통령이 누구인지 알려주되 근거 없는 내용은 말하지 마.",
        "현재 대한민국 대통령이 누구인지 알려주고 다음 자료만 요약해줘: 정국은 복잡하다.",
        "현재 대통령이 누구인지 말하지 말고 국무총리가 누군지 알려줘.",
        "정치 이야기는 그만하고 현재 대한민국 대통령은 누구야?",
        "현재 대통령에 대한 설명은 그만하고 현재 총리는 누구야?",
        "현재 대통령 이름을 알려줘. 정치 이야기는 그만하고 파이썬 리스트도 설명해줘.",
        "현재 대통령 이름을 알려줘, 정치 이야기는 그만하고 파이썬 리스트도 설명해줘.",
        "현재 대통령은 누구야, 설명은 그만하고 파이썬 리스트도 설명해줘.",
    ],
)
def test_live_political_questions_require_current_evidence(prompt):
    assert fresh_fact_required(prompt)


@pytest.mark.parametrize(
    "prompt",
    [
        "",
        "   ",
        "오늘 기분이 어때?",
        "현재 12 더하기 8은 얼마야?",
        "전이학습의 원리를 설명해줘",
        "대한민국 대통령제의 장단점이 뭐야?",
        "대통령이 하는 일은 뭐야?",
        "대통령의 권한과 의무를 설명해줘",
        "현재 대통령의 헌법상 권한을 설명해줘",
        "대통령 선거 제도의 원리를 설명해줘",
        "Who can become president of South Korea?",
        "What are the powers of the current president?",
        "Explain the role of a prime minister.",
        "1980년 대한민국 대통령은 누구였어?",
        "2020년 당시 대한민국 대통령은 누구야?",
        "2020년 현재 대한민국 대통령은 누구야?",
        "당시 대통령이 누구인지 알려줘",
        "Who was the president of South Korea in 1980?",
        "Who is the president of South Korea in the year 1980?",
        "Who was the former president?",
        "대한민국 제1대 대통령은 누구야?",
        "대한민국 초대 대통령 이름은?",
        "소설 속 가상 국가의 현직 대통령 이름을 만들어줘",
        "가상 국가에서 지금 대통령은 누구인지 설정해줘",
        "만약 내가 대통령이라면 어떤 하루를 보낼까?",
        "In my novel, who is the current president of the fictional country?",
        "Imagine a fictional current president and write a story.",
        "'현재 대한민국 대통령은 누구야?'를 영어로 번역해줘",
        '"Who is the current president of South Korea?"를 한국어로 번역해줘',
        "Translate 'Who is the current president of South Korea?' into Korean.",
        "'요즘 한국 정치 상황'이라는 문장의 문법을 설명해줘",
        "다음 자료만 요약해줘: '현재 한국 정치 상황은 복잡하다.'",
        "Summarize only this supplied text: 'The current president is Example Person.'",
        "다음 자료만 요약해줘: 현재 한국 정치 상황은 복잡하다",
        "Summarize only this supplied text: The current political situation is complicated.",
        "현재 대통령은 가상 인물 A라는 설정으로 소설을 써줘",
        "대통령이라는 단어의 뜻을 설명해줘",
        "최신 파이썬 버전은 뭐야?",
        "오늘 환율은 얼마야?",
        "다음 문장을 영어로 번역해 줘: '현재 대한민국 대통령은 누구야?'",
        "Translate this sentence into Korean: 'Who is the current president of South Korea?'",
        "검색하지 말고 다음 문장을 영어로 번역해 줘: '현재 대한민국 대통령은 누구야?'",
        "현재 대통령이 누구인지 말하지 말고, 대통령의 역할만 설명해 줘.",
        "Do not tell me who the current president is; explain the role of a president.",
        "현재가 아니라 1980년 대한민국 대통령이 누구였는지 알려줘.",
        "다음 자료만 요약해줘:\n현재 정국은 복잡하다. 여야가 협상을 진행했다.",
        "Summarize only this supplied text:\nThe current president is Example Person. "
        "The parliament met.",
        "검색하지 말고 다음 자료만 요약해줘:\n현재 정국은 복잡하다. 여야가 협상을 진행했다.",
        "현재 대한민국 대통령에 대한 질문은 그만하고 파이썬 리스트를 설명해줘",
        "현재 대한민국 대통령 이야기는 하지 말고 삼각형 넓이를 계산해줘",
        "요즘 정치 상황에 대한 논의는 그만두고 파이썬 리스트를 설명해줘",
        "현재 대통령에 대한 설명은 그만하고 1990년 당시 대통령을 알려줘",
    ],
)
def test_history_nonfactual_tasks_and_other_domains_are_out_of_scope(prompt):
    assert not fresh_fact_required(prompt)


def test_decomposed_korean_has_the_same_policy():
    request = "현재 대한민국 대통령은 누구야?"
    assert fresh_fact_required(unicodedata.normalize("NFD", request))


@pytest.mark.parametrize("prompt", ["현재 대통령은 누구야?", "현직 총리가 누구야?"])
def test_korean_abstention_does_not_claim_an_officeholder_or_a_search(prompt):
    response = abstention_response(prompt)
    assert "확인할 수 없어" in response
    assert "단정" in response
    assert "최신 공식 자료" in response
    assert "검색했습니다" not in response


def test_short_english_question_gets_english_abstention():
    response = abstention_response("Who is president now?")
    assert "cannot verify" in response
    assert "current official source" in response
    assert "verified that" not in response


def test_date_instruction_never_invents_a_training_cutoff():
    assert "does not prove" in FRESHNESS_INSTRUCTION
    assert "training cutoff" in FRESHNESS_INSTRUCTION
    assert not any(str(year) in FRESHNESS_INSTRUCTION for year in range(2020, 2040))
