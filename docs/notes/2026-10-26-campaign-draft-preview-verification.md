# 캠페인 초안 발송 조건·비용 미리보기 검증

## 범위와 기준

[승인된 계약](../specs/2026-10-21-campaign-drafts.md#발송-조건비용-미리보기)의 관리자 전용 읽기 API `GET /api/campaign-drafts/:id/preview`를 구현했습니다.
기준 HEAD는 `6934fe0`이며 아래 로컬 검사는 커밋 전 작업 변경을 대상으로 수행했습니다.
화면·발송·outbox 생성·예약·승인·템플릿 치환·요금제 한도는 포함하지 않습니다.
새 테이블·migration·의존성은 없습니다.
운영 DB·실계정·공급자 호출은 사용하지 않았습니다.
이 검증은 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35) 전체의 완료나 운영 적용을 뜻하지 않습니다.

## 검사와 읽는 대상

DB 검사는 `src/app/campaign-draft-preview.db.test.ts`이며 실제 API(`appApi`)와 일회용 PostgreSQL 17 클러스터를 사용합니다.

- 사유마다 대상 하나 이상: 발송 스위치가 꺼진 연결, 수동 일시 중지와 상담 전환 일시 중지, 연결 없음과 두 작성자가 나눠 쓰는 모호한 수신자, 수신자 마케팅 철회·댓글 작성자 서비스 철회·`all` 철회, 동의 없음·`import` 동의·댓글 작성자 동의, 25시간 전 텍스트 DM(최근 버튼 응답 포함), 후보.
- 순서: 일시 중지이면서 연결이 꺼진 대상은 `connection_unavailable`, 일시 중지이면서 DM 식별자가 없는 대상은 `contact_paused`입니다.
- 연결 조건 네 가지(`active` 거짓, 토큰 없음, 만료, 만료 시각 없음)는 각각 단독으로 `connection_unavailable`입니다.
- 24시간 경계: 평가 시각을 고정한 뒤 정확히 24시간 전과 그보다 1마이크로초 이전은 닫힘, 1마이크로초 안쪽은 열림, 1마이크로초 미래는 닫힘입니다. 고정 시각이 응답 `as_of`와 같고 문장에 `statement_timestamp()`가 한 번만 있는지도 확인합니다.
- 수신자 여럿: 하나만 통과하면 후보, 철회와 창 닫힘이면 `reply_window_closed`, 철회와 동의 없음이면 `marketing_consent_required`, 모두 철회면 `opted_out`, 모호한 수신자 옆의 통과 수신자는 후보입니다.
- 권한·경로: `agent`는 403(UUID 형식이 아닌 ID도 403), 다른 작업 공간·없는 ID·UUID 형식이 아닌 ID는 404, 쿼리 문자열은 400, `POST`는 404, 모든 응답은 `no-store`입니다. 보관된 초안과 대문자 ID도 미리볼 수 있습니다.
- 쓰기 없음과 삭제 후 합계: 계약 8번의 여섯 테이블의 작업 공간 행 수와 내용 해시(`md5(string_agg(t::text ORDER BY t::text))`)가 미리보기 전후 같고, 각 테이블에 fixture 행이 있는지 먼저 확인합니다. 개인 삭제 후 원래 수 3, 남은 수 2이며 사유별 합이 남은 수와 같습니다.

검사가 실제로 실패할 수 있는지 확인하려고 창 비교를 `<=`로, 연결 조건의 `coalesce` 기본값을 `true`로 잠시 바꿨을 때 경계 검사와 연결 조건 검사가 실패했고, 원래대로 되돌린 뒤 통과했습니다.

## 실행 결과

```log
corepack pnpm check-types                                   exit 0
corepack pnpm test                                          exit 0  tests 401 pass 401 fail 0
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5436/automations_test corepack pnpm test:db          exit 0  tests 754 pass 754 fail 0
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5436/automations_test corepack pnpm test:cloudflare  exit 0  tests 80 pass 80 fail 0
```

## 검증하지 않은 것

로컬 DB와 workerd 검사는 운영 migration 상태, 배포된 Worker 동작, 실계정 권한, 실제 발송을 증명하지 않습니다.
`candidate` 수는 기록된 조건의 통과 수이며 발송 가능 인원이 아닙니다.
Instagram 공급자 메시지 요금은 인용할 Meta 출처를 확인하지 않아 알 수 없음으로 둡니다.
