# 인박스 수동 답장 서버

## 목표와 범위

[이슈 #18](https://github.com/AndrewDongminYoo/auto-chatter/issues/18)의 서버 기준선입니다.
현재 상담 전환 계약을 사용해 저장된 대화에 텍스트 답장을 예약하고 Cloudflare OAuth 워커로 발송합니다.
화면은 #19, 운영 마이그레이션·배포는 #13이며 실제 수신자·문구를 승인한 실발송 검증은 별도 단계입니다.
Node 환경 변수 토큰 워커, 첨부 파일, Human Agent 확장 창, 미확인 신원의 대화, 팀 배정과 브로드캐스트는 이번 범위에 포함하지 않습니다.

## 예약 계약

인증된 이메일 확인 세션과 same-origin 요청, 현재 작업 공간이 소유한 연결·대화가 필요합니다.
`POST /api/connections/:connection/inbox/:recipient/replies`는 `{request_key, expected_handoff_version, text}`를 받아 202와 발신 행을 반환합니다.
`request_key`는 UUID이며 대화 안에서 고유합니다.
텍스트는 공백만으로 구성할 수 없으며 JavaScript 문자열 길이 1,000 이하로 제한합니다.
동일 키·운영자·본문·상담 버전은 동일 행을 반환하고, 다른 내용의 재사용은 409입니다.
이미 예약된 요청의 조회 재시도는 이후 창 만료나 발송 중지와 관계없이 기존 결과만 반환합니다.

활성 상담 전환과 요청한 버전, 확인된 댓글 작성자 연결 근거, 해당 작성자의 파생 중지가 필요합니다.
수신·인박스·계정 발송과 전체 발송 스위치가 모두 켜져 있어야 새 작업을 예약합니다.
암호화된 OAuth 토큰의 만료·계정 cooldown도 검사합니다.
이 기준선은 저장된 최신 텍스트 DM 시각이 현재보다 늦지 않고 엄격하게 24시간 안인 경우만 허용합니다.
첫 비공개 답장, 발신 메시지, 확인 postback은 이 창을 열지 않습니다.
인박스 중지 중 수신한 비보관 메시지도 창을 확장하지 않습니다.
이 제한은 기존 답장 창보다 넓은 권한을 추정하지 않는 보수적 기준입니다.

## 워커와 결과

발신 행과 예약 감사 기록은 하나의 트랜잭션으로 작성합니다.
같은 대화의 가장 오래된 미해결 행만 claim합니다.
앞선 pending·sending·미해결 unknown은 뒤 행을 막으며 다른 대화는 계속 처리합니다.
`FOR UPDATE SKIP LOCKED`와 앞선 행 존재 조건을 함께 사용하며 대화당 sending 행 하나를 DB 고유 인덱스로 제한합니다.
정책을 먼저 검사해 만료된 작업이 실패한 조회를 계속 반복하지 않게 합니다.
발송 전에 토큰의 `/me?fields=user_id`가 저장된 Instagram 계정과 일치하는지 확인합니다.
실제 POST 직전 claim·현재 상담 버전·파생 중지·식별자 근거·수신 창·연결·동일 암호화 토큰·만료·cooldown을 다시 확인합니다.
수동 답장은 자동화 중지 중에만 허용하며 수동 연락처 중지는 자동화에만 적용합니다.
이미 최종 검사에서 허용된 외부 POST는 이후 변경으로 취소할 수 없습니다.

| 상태    | 의미와 다음 행동                                                               |
| ------- | ------------------------------------------------------------------------------ |
| pending | 예약 또는 실패한 발송 전 조회를 1분 뒤 다시 검사                               |
| sending | 새 attempt UUID로 claim하고 감사 기록을 남김                                   |
| sent    | 공급자 메시지 ID와 로컬 응답 기록 시각 보관; 실제 수신 확인과 구분             |
| failed  | 발송 전 정책 거부 또는 기존 Graph 분류기가 확인한 4xx 거부; 미전송 근거를 보관 |
| unknown | 네트워크·5xx·불명확한 응답·10분 지난 claim; 자동 재시도 금지                   |

공급자의 명시적인 속도 제한 거부도 failed로 기록합니다.
같은 연결의 cooldown은 최소 15분 또는 더 긴 유효 Retry-After로 연장하며 자동 POST 재시도는 하지 않습니다.
공급자 응답 본문이나 토큰을 이력·로그에 넣지 않습니다.
상태 갱신과 감사 기록은 하나의 트랜잭션이며 attempt가 바뀌면 갱신을 거부합니다.
Queue에는 연결 ID만 들어가며 DB 예약 직후 연결 ID 알림을 발행하고 cron이 알림 누락을 복구합니다.
예약 후 계정 발송이 꺼지거나 토큰이 만료·삭제돼도 cron과 Queue는 해당 수동 행을 깨워 Graph 호출 없이 정책 실패와 감사를 기록합니다.
전체 발송 스위치가 꺼져 있는 동안에는 대기 행을 보류합니다.
수동 답장을 조건부 자동 답장·첫 비공개 답장보다 먼저 처리하되 한 알림당 한 행만 처리합니다.

## 이력과 운영자 결정

`GET .../replies`는 50개 발신 행과 각 행의 최근 50개 감사 기록을 반환합니다.
`before`는 마이크로초를 보존한 생성 시각·UUID cursor이며 계정과 대화 소유권을 다시 확인합니다.
본문·상태·실패 코드·공급자 메시지 ID·재시도 연결·운영자 결정이 보이지만 인증 정보는 제외합니다.
감사 기록은 두 서버 역할에도 UPDATE·DELETE가 허용되지 않습니다.

`POST .../replies/:id/retry`는 `{request_key, expected_handoff_version, reason}`을 받습니다.
failed이면서 미전송이 확실한 행만 새로운 발신 행으로 연결하고 사유·운영자를 기록합니다.
원본 하나에 직접 재시도 행은 하나만 허용하며 이후 재시도는 새 실패 행을 대상으로 합니다.
동일 재시도 키는 기존 행만 반환하고 모든 현재 발송 정책을 새 예약에 적용합니다.
unknown은 재시도할 수 없습니다.

`POST .../replies/:id/resolution`은 `{request_key, decision:"no_retry", reason}`으로 미해결 unknown의 운영자 결정을 기록합니다.
상태는 unknown으로 유지하며 resolved_at만 기록해 대화의 뒤 행을 해제합니다.
이는 발송 성공·미전송 증명이나 기존 메시지 재전송 승인이 아닙니다.
이 기준선에는 공급자 미전송 증명 또는 공급자 idempotency 검증을 통한 unknown 재전송 경로가 없습니다.

## 출처와 검증 한계

[Meta Instagram Send API](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api)에서 수신자의 선대화 조건과 `instagram_business_manage_messages` 권한을 확인했습니다.
[텍스트 메시지 요청](https://www.postman.com/meta/instagram/request/scob1z4/text-message)은 검색 결과에서 확인했으나 원문 재조회는 timeout으로 완료하지 못했습니다.
Meta Instagram Login messaging 문서 원문은 2026-09-27 조회에서 HTTP 429로 접근하지 못했습니다.
24시간 제한은 기존 서비스 계약을 유지하며 확장 태그를 추정하지 않습니다.
모의 Graph·DB·workerd 테스트는 실제 권한과 DM 수신을 증명하지 않습니다.
#13 이후 승인된 테스트 계정으로 실발송과 수신을 별도로 확인해야 하므로 #18은 이 PR로 자동 종료하지 않습니다.

Oracle의 직접적인 프로젝트 선례는 `[no precedent found]`입니다.
`wiki/concepts/diagnostic-report-pattern.md`와 `wiki/sources/claude--commands--fix-with-test.md`의 불확실한 결과를 추정하지 않고 시도 근거를 남기는 일반 원칙을 unknown과 감사 재시도에 적용했습니다.
sourceCommit은 `c1681868ac634e4b2414874716bb75a7864113c4`이며 freshness는 미확인입니다.
