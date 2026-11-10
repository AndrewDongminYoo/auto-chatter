# 캠페인 실행 현황 리포트

## 범위

[#50](https://github.com/AndrewDongminYoo/auto-chatter/issues/50)의 네 번째 리포트로, 소유자와 관리자가 선택 기간에 시작한 캠페인 실행이 무엇을 했는지 확인합니다.
실행 상태, 시작 시점 대상 평가, 그 실행들의 발송 행 상태를 세 영역으로 나누어 집계합니다.
캠페인 데이터 계약은 [캠페인 실행](2026-10-27-campaign-runs.md)과 [한도로 시작하지 않은 실행](2026-10-12-plan-entitlements.md#한도로-시작하지-않은-실행)을 따릅니다.
비용 분석, 성공 전환율, 전달·읽음 추정은 포함하지 않으며 #50을 완료 처리하지 않습니다.

## 조회 계약

`GET /api/reports/campaign-runs`는 활성 `owner` 또는 `admin`만 사용할 수 있습니다.
필수 `from`·`before`는 작업 공간 시간대의 `YYYY-MM-DD`이며 시작일을 포함하고 종료일을 제외합니다.
기간은 1~366일이고 `expected_time_zone`은 현재 작업 공간 시간대와 정확히 같아야 합니다.
선택 항목 `draft_id`는 같은 작업 공간의 `campaign_drafts` UUID이며 `campaign_runs.draft_id`에 적용합니다.
보관한 초안도 조회할 수 있습니다.

계정(`connection_id`) 필터는 두지 않습니다.
한 실행의 고정 대상은 여러 계정에 걸칠 수 있어 계정 필터는 발송 행만 좁힐 수 있고, 그러면 세 영역이 서로 다른 집합을 설명하게 됩니다.

다른 작업 공간의 초안이나 없는 초안은 404 `campaign_draft_not_found`로 거부합니다.
알 수 없는 키, 중복 키, 잘못된 UUID·날짜와 범위는 400 `invalid_report_query`, 바뀐 시간대는 409 `report_time_zone_changed`입니다.
현재 멤버십, 시간대, 초안 소유권과 모든 집계는 한 SQL 문장에서 확인하고, 조회 시각 `statement_timestamp()`는 그 문장에서 한 번만 읽습니다.
이미 시작한 조회는 그 이후의 권한 변경으로 회수되지 않습니다.
각 날짜의 자정은 PostgreSQL이 `$date::date::timestamp AT TIME ZONE w.time_zone`으로 변환하고, 실제 UTC 경계 `period_from`·`period_before`와 조회 시각 `checked_at`을 ISO 문자열로 반환합니다.
DST의 23·25시간 날짜 및 겹치거나 존재하지 않는 자정은 PostgreSQL 규칙을 따릅니다.
응답에는 `from`·`before`·`time_zone`·`draft_id`도 함께 담습니다.

## 집계 의미

대상은 `campaign_runs.started_at`이 지정 기간 안인 보존된 실행입니다.
모든 건수는 SQL에서 정수로 계산한 십진수 문자열입니다.

`run_counts`는 `total`과 네 구간 `running`·`cancelled`·`completed`·`limit_not_started`이며, 네 구간의 합은 `total`과 같습니다.
월 캠페인 발송 한도로 시작하지 않은 실행(`start_counts`에 `plan_limit_exceeded` 키가 있음)은 `completed`로 저장되지만 `limit_not_started`에만 셉니다.

`start_counts`는 대상 실행에 저장된 시작 시점 수의 합입니다.
`original_member_count`, `remaining_member_count`, 일곱 사유(`connection_unavailable`, `contact_paused`, `no_dm_identity`, `opted_out`, `marketing_consent_required`, `reply_window_closed`, `candidate`)와 여덟 번째 사유 `plan_limit_exceeded`를 담고, 키가 없는 실행은 0으로 셉니다.
시작 시 남은 인원은 각자 첫 번째로 해당하는 사유 하나만 가지며, 한도로 시작하지 않은 실행은 `candidate`를 `"0"`으로 바꾸고 같은 수를 `plan_limit_exceeded`에 기록합니다.
따라서 여덟 사유의 합은 `remaining_member_count`와 같습니다.
`plan_limit`·`plan_limit_used`·`plan_limit_reserved`는 실행마다 다른 시점의 값이라 합산하지 않습니다.

`delivery_counts`는 대상 실행들의 `campaign_deliveries` 행 수 `total`과 일곱 상태 `pending`·`sending`·`sent`·`failed`·`blocked`·`unknown`·`cancelled`이며, 일곱 상태의 합은 `total`과 같습니다.
발송 행은 기간에 시작한 실행의 행이며, 그 기간에 보낸 건수가 아닙니다.
상태는 조회 시점의 현재 상태입니다.
시작은 `candidate` 한 명당 발송 행 하나를 쓰지만, 계정·이용자 데이터 삭제는 실행과 `start_counts`를 남기고 발송 행만 지웁니다.
따라서 `candidate` 합과 발송 행 `total`은 같다고 보장하지 않으며, 발송 행 `total`이 더 작을 수 있습니다.
한도로 시작하지 않은 실행은 발송 행이 없고 `candidate`도 0이므로 이 차이를 만들지 않습니다.
`sent`는 Meta가 요청을 접수했다는 뜻일 뿐이며, 전달·전환 데이터는 없고 전달·읽음·전환을 추정하지 않습니다.
2026-11-10부터 `delivery_counts.read`는 `sent` 행 중 그 메시지 ID의 읽음이 저장된 행만 세며, 발송 행 분할의 합에는 들어가지 않습니다([읽음 확인 건수](2026-11-10-instagram-message-reads.md#리포트의-읽음-확인-건수)).
본문, 수신자·발신자·연결 식별자, 승인자, 실패 원문, 초안 이름은 반환하지 않습니다.

## 화면과 CSV

홈의 ‘캠페인 실행 현황’ 카드는 소유자와 관리자에게만 보입니다.
초기 날짜는 작업 공간 기준 최근 7일이고, 브라우저가 그 시간대를 지원하지 않으면 날짜를 직접 입력하도록 안내합니다.
캠페인 선택 목록은 기존 `/api/campaign-drafts`의 보관하지 않은 초안이며, ‘모든 캠페인(보관 포함)’ 조회에는 보관한 초안의 실행도 포함한다고 표시합니다.
이 API는 최신순 100개까지 돌려주고 보관한 초안도 그 수에 들어가지만, 초안 생성이 보관 포함 작업 공간당 100개에서 멈추므로(`campaign_draft_limit_reached`) 목록에서 빠지는 초안은 없습니다.
목록은 카드를 설정할 때(로그인, 작업 공간·역할 변경, 시간대 변경) 한 번 불러오므로, 그 뒤 같은 화면에서 만들거나 보관한 초안은 새로고침해야 반영된다고 화면에 표시합니다.
세 영역은 각각 구분해 표시하고 이름은 캠페인 실행 화면과 같은 한국어 표현을 씁니다.
`limit_not_started`는 ‘시작하지 않음(월 발송 한도 초과)’, `candidate`는 ‘조건 통과’이며 ‘발송 가능’으로 표시하지 않습니다.
건수 아래에는 발송 행이 기간에 시작한 실행의 행이라는 점, ‘보냄’은 Meta 접수일 뿐 읽음이 아니라는 점, 삭제로 ‘조건 통과’와 발송 행 합계가 달라질 수 있다는 점을 한 번 설명합니다.
건수는 `BigInt`로 읽습니다.
CSV는 표시한 응답 하나에서 만들며 다시 조회하지 않습니다.
고정 그룹·지표명, 건수, 검증된 날짜·시간대·UTC 경계·조회 시각과 필터 UUID만 내보내고 캠페인 이름과 고객 데이터는 제외합니다.
입력 변경, 새 조회, 작업 공간·역할 초기화와 로그아웃은 결과와 CSV를 무효화합니다.
늦은 조회나 캠페인 목록 응답은 이후 입력·세션을 덮어쓰지 못합니다.

## 검증과 운영 경계

실제 DB로 모든 실행 상태, 한도로 시작하지 않은 실행의 구간과 사유 합, 상태가 섞인 취소 실행, 삭제된 발송 행으로 생긴 차이, 초안 필터, 다른 작업 공간·없는 초안의 404, 상담원 403, 제거된 멤버, 다른 작업 공간의 실행 제외, 현지 자정 경계, DST, 시간대 변경 409, 빈 결과와 세 영역의 합을 검사합니다.
한도로 시작하지 않은 실행과 시작한 실행 하나씩은 실제 `startDueCampaignRuns`로 만들어 저장 형식의 불변식을 확인합니다.
기간 밖 이력을 넣은 실제 집계 SQL의 실행 계획에서 발송 행을 `run_id`로 시작하는 고유 인덱스 `campaign_deliveries_member`로 대상 실행마다 한 번씩 읽는지 확인합니다.

migration은 추가하지 않습니다.
`campaign_runs` 행은 사람의 승인으로만 생기고 작업 공간마다 기본 키 `(workspace_id, id)`로 묶여 있어, 작업 공간의 실행을 읽는 비용은 승인 수에 묶입니다.
발송 행은 대상 실행마다 `run_id`로 시작하는 기존 고유 인덱스로 읽으므로 다른 실행의 행을 읽지 않습니다.
따라서 다른 리포트와 달리 배포 전에 적용할 migration이 없습니다.
스키마 변경, 캠페인 시작·발송·취소 동작 변경, 실제 발송, 새 의존성과 운영 접근은 없습니다.

## 선례

저장소 안의 세 리포트 명세 [수동 답장 현황](2026-10-16-manual-reply-reports.md), [플로 실행 현황](2026-10-16-flow-run-reports.md), [상담 전환 이력](2026-10-16-handoff-reports.md)의 조회 계약·화면·CSV 규칙을 따랐습니다.
Oracle은 조회하지 않았습니다.
