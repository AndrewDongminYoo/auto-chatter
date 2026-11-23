# ManyChat 대체제 기능별 수용 매트릭스

## 기준과 상태

2026-10-16: #26의 태그·단일 필드 AND/OR·숫자/날짜 비교·저장 전 초안 미리보기와 #60의 연결별 비공개 답장 예산·삭제 호출 이월·Cron 깨우기 순서를 [코드·검증 기록 대조](2026-10-16-acceptance-evidence-reconciliation.md)에 반영했습니다.
이 대조는 `8717c51c3af34e265ddb8b0e5c3fcceea04af322` 기준이며, 이후 #26의 [정확한 전체 대상 수 검증](2026-10-16-segment-preview-count-verification.md)과 [필터 제외 사유 검증](2026-10-16-segment-preview-exclusions-verification.md), [마지막 댓글 저장 기간 검증](2026-10-16-segment-comment-activity-verification.md), [목적별 동의 기록 검증](2026-10-16-segment-consent-state-verification.md)을 추가했습니다.
이후 [최근 N×24시간 댓글 저장 활동 검증](2026-10-16-segment-relative-activity-verification.md)을 추가했습니다.
2026-10-17에 [작업 공간 시간대 달력 기간 검증](2026-10-17-segment-calendar-period-verification.md)을 추가했습니다.
#26의 DM 동의·DM 활동 조건과 중첩 조건 그룹은 코드로 구현했지만 운영 적용은 확인하지 않았고, 캠페인·비용 상한 통합 등 각 이슈의 남은 조건 및 전체 운영 수용은 완료하지 않았습니다.
2026-10-18에 #35의 대상 고정을 코드로 구현하고 [고정 대상 검증](2026-10-18-segment-target-snapshots-verification.md)을 추가했습니다. 운영 적용은 확인하지 않았습니다.
다른 행의 구현·운영 상태는 이번 대조로 갱신하지 않았습니다.
2026-11-08에 #16, #24, #27, #33, #35, #36, #37, #52, #60, #62 행을 병합된 PR과 운영 적용 기록(migration 069까지, Worker `c2df6e60`)에 맞춰 갱신했습니다. #24, #27, #37은 같은 날 완료 조건 대조 후 닫았습니다.
2026-11-09에 #62 행을 [4차 보안 회귀 점검](2026-11-09-security-regression-audit-4.md)의 1부와 2부에 맞춰 갱신했습니다.
2026-11-09에 #35, #36, #52 행을 요금제별 월 캠페인 발송 한도의 로컬 구현에 맞춰 갱신했습니다. 운영 배포는 확인하지 않았습니다.
2026-11-10에 #50에서 분리한 [#312](https://github.com/AndrewDongminYoo/auto-chatter/issues/312)의 첫 PR로 서비스가 보낸 메시지의 읽음 수집·저장을 로컬에서 구현했습니다([명세](../specs/2026-11-10-instagram-message-reads.md), migration 070). 운영 적용, Meta 앱의 `messaging_seen` 구독, 실제 이벤트의 `read.mid` 일치는 확인하지 않았고 리포트 표시는 남아 있습니다.
2026-11-10에 #312의 두 번째 PR로 수동 답장·플로 실행·캠페인 실행 리포트에 메시지 ID가 정확히 일치하는 읽음만 세는 ‘읽음 확인’(`read`) 건수, 읽음을 알려 줄 수 없는 연결의 ‘읽음 확인 불가’(`read_unavailable`) 건수와 CSV 행을 로컬에서 구현했습니다([명세](../specs/2026-11-10-instagram-message-reads.md#리포트의-읽음-확인-건수)). 운영 배포는 확인하지 않았습니다.
2026-11-19에 #33, #35, #36 행을 [DM 시작 트리거와 캠페인 실발송 실계정 검증](2026-11-19-live-dm-trigger-campaign-verification.md)에 맞춰 갱신했습니다.
2026-11-20에 #35의 완료 조건을 기존 실계정 기록과 [#376 배포 결과](https://github.com/AndrewDongminYoo/auto-chatter/actions/runs/44673108039)에 대조하고, #36의 로컬 검증 범위를 바로잡았습니다.

[목표 명세](../specs/2026-09-25-messaging-automation-platform.md)와 [백로그](2026-09-27-manychat-backlog.md)의 알려진 필수 작업을 코드·로컬 검사·실계정·운영 적용으로 구분합니다.
기준은 `591cc091e5e3cdb55bba20fe65d3c662df800fd4`이며 아래 이슈별 목록의 미완료는 구현된 첫 DM·팔로우·연락처 기능을 없다고 판정한 것이 아닙니다.
각 항목은 해당 이슈의 확장 또는 최종 검증 완료 여부입니다.
문맥 조회의 로컬 근거는 [조회 검증 기록](2026-09-27-inbox-handoff-verification.md), 상담 전환은 [전환 검증 기록](2026-09-27-inbox-human-handoff-verification.md)에 있으며 공급자·운영 검증과 구분합니다.
채널 지원 표시는 코드와 공식 승인·실계정 왕복·운영 적용을 모두 확인한 범위로 제한합니다.
검증 담당자는 기능별 구현자·독립 검토자이며, 외부 계정·가격·정책·배포·발송은 제가 직접 승인합니다.

- [#12](https://github.com/AndrewDongminYoo/auto-chatter/issues/12) ManyChat 대체 범위와 기능별 검증 매트릭스 확정
  - 현재 코드: 범위 계약 문서
  - 로컬 증거: 53건 이슈와 아래 출시 제한·결정 담당자 대응 확인
  - 공급자·실계정: 해당 없음
  - 운영 완료: 해당 없음
- [#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13) 병합된 연락처·필터·필드·자동화 중지·수신 인박스 운영 적용
  - 현재 코드: 부분 기반
  - 로컬 증거: 기존 증거 있음, 추가 검증 필요
  - 공급자·실계정: 확인 버튼 실발송(2026-10-07)
  - 운영 완료: 권한·DM 보관·확인 버튼만 확인, 연락처·필터·필드·중지 실계정 미검증
- [#14](https://github.com/AndrewDongminYoo/auto-chatter/issues/14) Instagram App Review·Advanced Access 및 추가 사용자 연결 검증
  - 현재 코드: 부분 기반
  - 로컬 증거: 기존 증거 있음, 추가 검증 필요
  - 공급자·실계정: 제 Instagram 계정에서 일부만 확인
  - 운영 완료: 완료하지 않음
- [#15](https://github.com/AndrewDongminYoo/auto-chatter/issues/15) 회원가입·이메일 확인·비밀번호 복구·세션 만료 경로 완성
  - 현재 코드: 가입·인증 링크·복구·이전 세션 폐기와 인증 요청 제한(#148) 구현
  - 로컬 증거: [인증 완료](../specs/2026-09-28-auth-completion.md)·[비밀번호 복구](../specs/2026-09-28-password-recovery.md) 단위·Worker 테스트
  - 공급자·실계정: 실계정 확인(2026-10-06)
  - 운영 완료: 배포·운영 확인, 인증 메일 SMTP 적용(#151)
- [#16](https://github.com/AndrewDongminYoo/auto-chatter/issues/16) Instagram 토큰 갱신·연결 상태·재인증 안내
  - 현재 코드: 토큰 갱신(`57d58d6`), 토큰 거부 기록과 표시(#177, migration 039), 앱 권한 해제 시 연결 해제(#180, migration 040), webhook 구독 주기 확인과 유실 표시(#183, migration 041), 발송 전 계정 확인 뒤 거부 표시 유지(#187) 구현; 토큰 암호화 키 교체 중 발송이 POST 전에 `token_rotated`로 다시 시도하고 같은 토큰을 새 키로 열어 보내는지 보는 테스트(#406, `src/cloudflare/worker.db.test.ts`)
  - 로컬 증거: [토큰 갱신 계약](../specs/2026-09-28-instagram-token-refresh.md) 단위·DB·workerd 로컬 테스트, 갱신 경합·단일 claim은 `src/app/instagram-oauth.db.test.ts`
  - 공급자·실계정: 미검증
  - 운영 완료: 039~041 운영 적용·배포, 실동작 미검증, 완료하지 않음
- [#17](https://github.com/AndrewDongminYoo/auto-chatter/issues/17) DM 대화와 댓글 연락처 연결 및 상담 전환 정책 확정
  - 현재 코드: 조회·상담 전환 API 구현; [기존 정책과 세 완료 조건의 로컬 근거 대조](2026-10-19-issue17-policy-evidence.md)
  - 로컬 증거: DB·workerd 조회·전환 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#18](https://github.com/AndrewDongminYoo/auto-chatter/issues/18) 인박스 수동 답장 outbox·정책 검사·발신 이력 구현
  - 현재 코드: PR #67 병합
  - 로컬 증거: DB·workerd·단위 검사 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#19](https://github.com/AndrewDongminYoo/auto-chatter/issues/19) 인박스 답장 작성·전송 상태·실패 안내 화면
  - 현재 코드: 서버 판정·작성기·이력 구현
  - 로컬 증거: [로컬 화면 검증](2026-09-28-inbox-manual-reply-ui-verification.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#20](https://github.com/AndrewDongminYoo/auto-chatter/issues/20) Instagram 첨부·발신 echo·수정·삭제·전달 이벤트 처리
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#21](https://github.com/AndrewDongminYoo/auto-chatter/issues/21) 작업 공간 초대·역할·멤버 제거와 서버 권한 검사
  - 현재 코드: 역할·서버 권한 검사(PR #96)와 초대·멤버 관리(PR #102) 구현
  - 로컬 증거: [역할·초대 계약](../specs/2026-09-30-workspace-roles.md) 단위·DB·Cloudflare 로컬 테스트, [초대 화면](2026-09-30-workspace-invites-ui-verification.md) 로컬 브라우저 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 022·024 적용, 초대 실동작 미검증
- [#22](https://github.com/AndrewDongminYoo/auto-chatter/issues/22) 대화 담당자·열림/완료 상태·자동화 인계 구현
  - 현재 코드: 담당자·상태·감사 기록 API와 화면 구현(migration 029)
  - 로컬 증거: [대화 담당자 계약](../specs/2026-10-01-inbox-conversation-assignment.md) DB·Cloudflare 로컬 테스트, [담당자 화면](2026-10-01-inbox-conversation-assignment-ui-verification.md) 로컬 브라우저 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 029 적용·배포, 실사용 미검증
- [#23](https://github.com/AndrewDongminYoo/auto-chatter/issues/23) 인박스 검색·읽음·라벨·내부 메모·리마인더
  - 현재 코드: 검색·필터·멤버별 읽음 상태 API와 화면 구현(#23-A, migration 032), 라벨·내부 메모 API와 화면 구현(#23-B, migration 033), 리마인더 API와 화면 구현(#23-C, migration 034, 앱 안에서만 표시), 키워드 자동 라벨 규칙 API와 화면 구현([#132](https://github.com/AndrewDongminYoo/auto-chatter/issues/132), migration 035)
  - 로컬 증거: [검색·읽음 계약](../specs/2026-09-27-instagram-inbox.md#검색-필터와-읽음-상태)과 [라벨·메모 계약](../specs/2026-10-03-inbox-labels-notes.md), [리마인더 계약](../specs/2026-10-04-inbox-reminders.md), [자동 라벨 규칙 계약](../specs/2026-10-04-inbox-label-rules.md) DB·Cloudflare 로컬 테스트, [검색·읽음 화면](2026-10-03-inbox-search-read-ui-verification.md), [라벨·메모 화면](2026-10-03-inbox-labels-notes-ui-verification.md), [리마인더 화면](2026-10-04-inbox-reminders-ui-verification.md)과 [자동 라벨 규칙 화면](2026-10-04-inbox-label-rules-ui-verification.md) 로컬 브라우저 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 032·033·034·035 적용·배포(#23-A·B·C, #132), 실사용 미검증
- [#24](https://github.com/AndrewDongminYoo/auto-chatter/issues/24) 상담 답장 템플릿과 예약 답장
  - 현재 코드: 텍스트 템플릿(migration 048)과 일회성 예약·수정·취소·발송 전 생성자 권한 검사(migration 049) 구현
  - 로컬 증거: [템플릿 검증](2026-10-16-inbox-reply-templates-verification.md), [예약 계약](../specs/2026-10-16-inbox-scheduled-replies.md)과 [예약 검증](2026-10-16-inbox-scheduled-replies-verification.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 048·049와 새 화면 2026-10-17 운영 적용(`335968b`), 실사용 미검증; 2026-11-08 완료 조건을 코드·테스트와 대조해 이슈를 닫음
- [#25](https://github.com/AndrewDongminYoo/auto-chatter/issues/25) 연락처 상세·동의 있는 식별자 연결·CSV 가져오기/내보내기
  - 현재 코드: 관리자 CSV 내보내기, 기존 연락처 태그 변경 사전 검사와 적용 구현. 연락처 상세 [PR #139](https://github.com/AndrewDongminYoo/auto-chatter/pull/139) 병합; 같은 연결의 공급자 근거에 대한 [운영자 확인·분리](../specs/2026-10-21-contact-identity-links.md) 로컬 구현·검증 및 화면 승인 완료, 2026-10-26 migration 062와 함께 운영 배포(`fb0e8b2`, 운영 화면·API 실행은 미확인). 임의 ID·여러 계정의 동일인 병합은 미구현([검증](2026-10-21-contact-identity-links-verification.md))
  - 로컬 증거: [CSV 내보내기 검증](2026-10-04-contact-csv-export-verification.md)·[태그 사전 검사 검증](2026-10-17-contact-csv-preview-verification.md)·[태그 변경 적용 검증](2026-10-17-contact-csv-import-verification.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 연락처 상세·CSV 운영 배포(`4f79511`), 실사용 미검증. #17·#27 외부 검증과 #25 전체 완료 조건 유지
- [#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26) 저장된 세그먼트 복합 조건·대상 미리보기·변경 감지
  - 현재 코드: 태그·단일 필드 AND/OR, 숫자·날짜 비교, 저장 전 초안 미리보기 구현(조회 시점의 전체 수·계정 범위 평가 수·태그/단일 필드별 제외 사유·최대 5명 예시; 고정 UTC 마지막 댓글 저장 기간·기간 우선 제외 구현, 최근 N×24시간 조건·조회별 UTC 경계 구현, 작업 공간 시간대의 달력 기간(오늘·어제·이번 달·지난달) 구현; 발송 대상 고정은 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)에서 구현); 정확한 댓글 식별자의 목적별 동의 기록·제외 사유 구현; 저장 필터의 이름·조건 수정(전체 정의, `expected_version` 확인, 변경 이력 없음) 구현; 태그 1~5개의 모두 포함·하나 이상 포함 조건 구현; 서로 다른 필드의 조건 1~3개의 모두 만족·하나 이상 만족 조건 구현; 저장된 세그먼트의 v1 연락처 CSV 내보내기(목록과 같은 조건, 내보내기마다 한 기준 시각) 구현; 연락처 상세와 같은 확인된 DM 대화의 목적별 동의 기록 조건·DM 대화 없음/DM 동의 불일치 제외 사유 구현; 확인된 DM 대화의 최근 N일(1~366) 받은 DM 조건(텍스트·버튼 응답, 한 평가 시각)·최근 받은 DM 없음 제외 사유 구현; 고정 2단계 중첩 조건 그룹(그룹 1~5개·그룹별 조건 1~5개·최대 10개, 태그 있음·없음·필드 조건, 순서 유지)·그룹 조건 불일치 제외 사유·트리 세그먼트 선택·새 필터 저장 구현; 그룹 편집 화면(그룹·조건 추가·삭제·순서 변경·모드 선택, 한도 거절)과 트리 세그먼트 수정 구현; 실행 시 재평가와 고정 대상의 차이를 세그먼트 계약에 명시
  - 로컬 증거: [세그먼트 계약](../specs/2026-09-27-contact-segments.md)·[순서 비교 검증](2026-10-06-ordered-field-conditions-verification.md)·[초안 미리보기 검증](2026-10-16-segment-draft-preview-verification.md)·[전체 수 검증](2026-10-16-segment-preview-count-verification.md)·[제외 사유 검증](2026-10-16-segment-preview-exclusions-verification.md)·[활동 기간 검증](2026-10-16-segment-comment-activity-verification.md), [병합 코드·CI 대조](2026-10-16-acceptance-evidence-reconciliation.md); [동의 기록 검증](2026-10-16-segment-consent-state-verification.md)·[최근 활동 검증](2026-10-16-segment-relative-activity-verification.md)·[수정 검증](2026-10-17-segment-edit-verification.md)·[달력 기간 검증](2026-10-17-segment-calendar-period-verification.md)·[다중 태그 검증](2026-10-17-segment-multi-tag-verification.md)·[다중 필드 검증](2026-10-18-segment-multi-field-verification.md)·[세그먼트 CSV 내보내기 검증](2026-10-18-segment-csv-export-verification.md)·[DM 동의 기록 검증](2026-10-18-segment-dm-consent-verification.md)·[DM 활동 검증](2026-10-18-segment-dm-activity-verification.md)·[중첩 조건 그룹 검증](2026-10-18-segment-condition-tree-verification.md)·[그룹 편집 화면 검증](2026-10-18-segment-group-editor-verification.md)·[고정 대상 검증](2026-10-18-segment-target-snapshots-verification.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#27](https://github.com/AndrewDongminYoo/auto-chatter/issues/27) 채널별 동의·수신 거부·차단 원장과 발송 guard
  - 현재 코드: PR #76 병합, Instagram만
  - 로컬 증거: [동의 계약](../specs/2026-09-29-channel-consent.md) 단위·DB·Cloudflare 로컬 테스트 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 2026-09-30 적용, 실동작 미검증; 2026-11-08 완료 조건을 코드·테스트와 대조해 이슈를 닫음
- [#28](https://github.com/AndrewDongminYoo/auto-chatter/issues/28) 플로 초안·버전·발행 검증 데이터 계약
  - 현재 코드: 발행 계약 구현
  - 로컬 증거: [계약](../specs/2026-09-29-flow-version-contract.md) 단위·DB·Cloudflare 로컬 테스트 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 2026-09-30 적용
- [#29](https://github.com/AndrewDongminYoo/auto-chatter/issues/29) 버전 고정 플로 실행·분기·중복 방지·실행 이력
  - 현재 코드: 첫 구현 병합(PR #92), 대기·후속 노드 남음
  - 로컬 증거: [실행 계약](../specs/2026-09-30-flow-runs.md) 단위·DB·Cloudflare 로컬 테스트 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 021 2026-09-30 적용, 실동작 미검증
- [#30](https://github.com/AndrewDongminYoo/auto-chatter/issues/30) 시각적 플로 편집기·미리보기·테스트 실행
  - 현재 코드: 테스트 실행 API(part A)·편집기 화면(part B) 구현
  - 로컬 증거: [테스트 실행](../specs/2026-09-30-flow-runs.md#테스트-실행) DB 로컬 테스트(실제 실행 경로와 단계 비교), [화면](2026-10-02-flow-editor-ui-verification.md) 단위·로컬 브라우저 확인, 2026-10-02 화면 승인
  - 공급자·실계정: 해당 없음(합성 입력)
  - 운영 완료: 2026-10-02 배포, 운영 데이터로 미사용
- [#31](https://github.com/AndrewDongminYoo/auto-chatter/issues/31) 플로 태그·필드 동작·응답 수집·메시지 변수
  - 현재 코드: 태그·필드 동작(PR #100)·응답 수집(응답 대기 저장) 구현
  - 로컬 증거: [실행 계약](../specs/2026-09-30-flow-runs.md#태그필드-동작과-메시지-변수)·[응답 대기](../specs/2026-09-30-flow-runs.md#응답-대기) 단위·DB 로컬 테스트 확인
  - 공급자·실계정: 미검증
  - 운영 완료: #100·026 적용, 실동작 미검증
- [#32](https://github.com/AndrewDongminYoo/auto-chatter/issues/32) 플로 지연·시퀀스·응답 대기·취소와 재개
  - 현재 코드: 지연(PR #105)·응답 대기(PR #107)·작업 공간 시간대 시각 대기 구현
  - 로컬 증거: [지연과 재개](../specs/2026-09-30-flow-runs.md#지연과-재개)·[응답 대기](../specs/2026-09-30-flow-runs.md#응답-대기)·[시각 대기](../specs/2026-09-30-flow-runs.md#시각-대기) 단위·DB·Cloudflare 로컬 테스트, 시간대 설정 화면 로컬 브라우저 확인([기록](2026-10-01-workspace-time-zone-ui-verification.md))
  - 공급자·실계정: 미검증
  - 운영 완료: 025~027 적용, #108의 028 적용·배포, 실동작 미검증
- [#33](https://github.com/AndrewDongminYoo/auto-chatter/issues/33) Instagram 일반 DM·스토리 응답·멘션 시작 트리거
  - 현재 코드: 일반 텍스트 DM의 키워드·기본 응답 시작 트리거 서버 구현(PR ①: migration 068, 시작 기록·실행·첫 메시지 행, outbox 없음, 응답 대기·팔로우 확인 우선, 당시 편집기는 읽기 전용)과 첫 메시지의 Cloudflare 큐 발송(PR ②, #291: migration 069, 24시간 창·메시징 ID 일시 중지·수신 거부·상담 전환을 POST 직전에 다시 확인, [계약](../specs/2026-11-08-instagram-dm-start-triggers.md)); 대시보드 편집기에서 DM 트리거 플로 만들기·편집(#292: 시작 버튼 셋, 메시지 단계만, 변수 없음); 스토리 응답·멘션(#294) 미구현
  - 로컬 증거: [계약](../specs/2026-11-08-instagram-dm-start-triggers.md#검증-범위) 단위·DB·workerd 로컬 테스트 확인, 편집기 [화면](2026-11-08-dm-trigger-editor-ui-verification.md) 단위·로컬 브라우저 확인
  - 공급자·실계정: 2026-11-19 키워드·기본 응답 트리거의 시작과 첫 메시지 실수신, 팔로우 확인 대기 중의 트리거 미시작을 확인([실계정 검증](2026-11-19-live-dm-trigger-campaign-verification.md), #293); 스토리 미검증
  - 운영 완료: 068·069 2026-11-08 운영 적용, 편집기를 포함한 Worker 배포(`c2df6e60`), 2026-11-19 발송 창에서 실계정 확인 후 발송 스위치 다시 꺼짐, 스토리(#294) 미구현, 완료하지 않음
- [#34](https://github.com/AndrewDongminYoo/auto-chatter/issues/34) Instagram 성장 트리거·공개 댓글 답장·링크 버튼 지원 조사
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35) 세그먼트 캠페인 초안·대상 확정·비용 미리보기
  - 현재 코드: 저장된 필터의 명단과 제외 사유별 집계를 한 기준 시각에 고정합니다.
    소유자와 관리자는 캠페인 초안에서 필터를 골라 새 대상을 고정하고 바로 선택할 수 있습니다.
    초안 본문은 일반 텍스트로 검증하며, 해석되지 않은 템플릿 표기는 거절합니다.
    템플릿 불러오기와 수신자별 치환은 #265에서 다룹니다.
    [고정 대상 계약](../specs/2026-10-18-segment-target-snapshots.md)과 [캠페인 초안 계약](../specs/2026-10-21-campaign-drafts.md)을 따릅니다.
  - 발송 조건·비용: 읽기 전용 미리보기는 확인된 DM 수신자, 수신 거부, 명시적 마케팅 동의, 24시간 응답 창 등을 평가해 대상마다 사유 하나를 표시합니다.
    조건은 미리보기 시각의 기록을 기준으로 평가하며, 실제 발송 시 다시 검사합니다.
    조건 통과 인원으로 예상 공급자 호출 수를 표시하고, 작업 공간 시간대의 이번 달 사용량·예약량·남은 발송 한도를 보여 줍니다.
    Instagram 공급자 요금은 확인되지 않아 금액은 알 수 없습니다.
    [발송 조건·비용 계약](../specs/2026-10-21-campaign-drafts.md#발송-조건비용-미리보기)을 따릅니다.
  - 실행 승인: 승인한 초안 버전, 고정 대상, 이름·본문 사본과 승인 시점의 미리보기를 기록합니다.
    즉시 실행이나 작업 공간 현지 시각의 예약을 선택할 수 있습니다.
    승인이 유효한 동안 초안 수정과 보관을 막습니다.
    승인과 기한이 속한 달을 바꾸는 예약 변경에 월 캠페인 발송 한도를 적용합니다.
    [실행 승인 계약](../specs/2026-10-21-campaign-drafts.md#실행-승인)을 따릅니다.
  - 로컬 증거: [고정 대상과 제외 집계](2026-10-18-segment-target-snapshots-verification.md), [미리보기 사유·발송 창](2026-10-26-campaign-draft-preview-verification.md), [월 한도](2026-11-09-campaign-monthly-limit-ui-verification.md), [승인과 예약 시각](2026-10-27-campaign-approvals-verification.md)을 검증했습니다.
    브라우저 검증은 [초안 편집](2026-10-22-campaign-draft-ui-verification.md), [발송 조건 미리보기](2026-10-26-campaign-draft-preview-ui-verification.md), [승인과 예약 변경](2026-10-27-campaign-approval-ui-verification.md)을 다뤘습니다.
    #376의 mock 화면과 회귀 테스트에서 초안 안의 대상 고정과 자동 선택을 확인했습니다.
    [PR #376](https://github.com/AndrewDongminYoo/auto-chatter/pull/376)
  - 공급자·실계정: 2026-11-19에 운영 화면에서 DM 동의 필터, 대상 고정, 초안, 발송 조건 미리보기(조건 통과 1명), 즉시 승인을 확인했습니다.
    이 기록은 기존 연락처 메뉴에서 고정한 대상과 즉시 실행을 다룹니다.
    [실계정 검증](2026-11-19-live-dm-trigger-campaign-verification.md)
  - 운영 상태: migration 061·063·064를 적용했고, 월 캠페인 발송 한도(#52)는 `6bb5e31` 이후 배포에 포함됐습니다.
    #372를 해결한 `f62d550`은 자동 배포와 공개 스모크 검사를 통과했습니다.
    초안 안의 대상 고정과 예약 경로는 로컬 검증 증거를 사용합니다.
    [#376 배포](https://github.com/AndrewDongminYoo/auto-chatter/actions/runs/44673108039)
- [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36) 캠페인 분할 발송·취소·진행률·부분 실패 복구
  - 현재 코드: 실행과 수신자별 발송 행 구현(PR ①: migration 065, 기한이 된 승인을 `campaign_start` cron 단계가 실행하고 후보마다 대기 행만 씀, 발송·outbox 없음, 실행 조회·취소 API, Cloudflare OAuth 표면의 마케팅 capability 지원, [계약](../specs/2026-10-27-campaign-runs.md)); 발송 worker 구현(PR ②: migration 066, Queue 경로에서 자동화 뒤에 행 하나, 저장된 수신자와 본문 사본, 미리보기 조건을 다시 쓰는 최종 guard와 승인자 검사, 결과 분류, 연결당 시간당 1,000회 예산, 실행 완료와 오래된 `sending` 복구, 실행된 초안 버전 재승인 409, [발송 계약](../specs/2026-10-27-campaign-runs.md#발송-worker)); 실행 현황 화면 구현(PR ③: 실행된 승인 아래 상태·시작 수·발송 행 일곱 상태, 새로고침만으로 다시 읽기, 확인 단계와 고정한 `expected_version`의 취소, 409 재표시, 결과 불명·429는 같은 요청만 재시도, [화면 계약](../specs/2026-10-27-campaign-runs.md#실행-현황-화면)); 세 PR 모두 구현; 실행 시작의 월 캠페인 발송 한도 검사(#52, 넘으면 발송 행 없는 `completed` 실행과 `start.broadcast_limit_exceeded` 표시, migration 없음) 로컬 구현·검증([한도 화면 검증](2026-11-09-campaign-monthly-limit-ui-verification.md))
  - 로컬 증거: Graph를 모의 응답으로 대체해 DB와 workerd의 실행·발송·화면 동작을 확인했습니다.
    실행 시작이 겹쳐도 대상별 발송 행은 하나만 생성됩니다.
    취소 API는 대기 행을 취소하며, 이미 공급자에게 보낸 요청은 되돌릴 수 없습니다.
    [실행 검증](2026-10-27-campaign-runs-verification.md) · [화면 검증](2026-10-29-campaign-run-screen-verification.md)
    발송 worker는 공급자 속도 제한과 연결별 시간당 호출 예산에 따라 대기 작업을 미룹니다.
    DB 테스트는 대상 일시 중지, 수신 거부, 승인 권한 철회를 발송 전에 반영하는 것도 확인했습니다.
    [발송 검증](2026-10-29-campaign-delivery-verification.md)
    수신자 5명을 사용한 회귀 테스트에서는 오래된 `sending` 행이 재발송 없이 `unknown`으로 바뀌고, 큐 알림을 잃어도 다음 cron 실행이 대기 작업을 다시 깨우는 것을 확인했습니다.
    명확한 공급자 거부 1건, 정상 발송 2건, 수신 거부로 인한 차단 1건, 결과 불명 1건을 집계한 뒤 실행이 `completed`가 됐으며, 같은 큐 알림을 다시 처리해도 추가 발송 요청은 없었습니다.
    [PR #378](https://github.com/AndrewDongminYoo/auto-chatter/pull/378)
  - 공급자·실계정: 2026-11-19 수신자 1명 실발송(`campaign_start` 실행 시작, 발송 행 `sent`, 실수신, 실행 `completed`) 확인([실계정 검증](2026-11-19-live-dm-trigger-campaign-verification.md)); 여러 수신자의 분할 발송·한도·취소·부분 실패 복구는 미검증
  - 운영 상태: migration 065·066을 운영에 적용했고, 월 캠페인 발송 한도(#52)는 `6bb5e31` 이후 배포에 포함됐습니다.
    2026-11-19 실발송 1건을 확인한 뒤 발송 스위치를 다시 껐습니다.
    선행 이슈 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)와 [#60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60)은 열린 상태입니다.
- [#37](https://github.com/AndrewDongminYoo/auto-chatter/issues/37) 채널 이벤트·대화·발송 capability 계약과 정책 경계
  - 현재 코드: 공통 계약·Instagram 어댑터 경계·미지원 API/화면·테스트용 두 번째 어댑터 구현
  - 로컬 증거: [채널 계약 검증](2026-10-04-channel-contract-verification.md): 타입·단위·DB·workerd·Chromium 로컬 확인
  - 공급자·실계정: 미검증 (#17 열린 상태)
  - 운영 완료: 운영 배포(`4f79511`); 전체 운영 수용 미완료; 2026-11-08 완료 조건을 코드·테스트와 대조해 이슈를 닫음
- [#38](https://github.com/AndrewDongminYoo/auto-chatter/issues/38) Facebook Messenger Page 연결·수신·정책 적용 발송
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#39](https://github.com/AndrewDongminYoo/auto-chatter/issues/39) Telegram Bot 연결·수신·버튼·플로·수신 거부
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#44](https://github.com/AndrewDongminYoo/auto-chatter/issues/44) 이메일 채널·발신 인증·반송·수신 거부·비용 상한
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#45](https://github.com/AndrewDongminYoo/auto-chatter/issues/45) SMS 출시 국가·발신번호·동의·요금 공급자 결정
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#46](https://github.com/AndrewDongminYoo/auto-chatter/issues/46) SMS 발송·수신·STOP 처리·전달 결과 어댑터
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#47](https://github.com/AndrewDongminYoo/auto-chatter/issues/47) 플로 외부 요청·서명된 outbound webhook·재시도
  - 현재 코드: 노드·전달·서명·관리자 API와 설정 화면 구현(migration 031)
  - 로컬 증거: [외부 전송 계약](../specs/2026-10-01-flow-webhook-delivery.md) 단위·DB·Cloudflare 로컬 테스트(실제 DNS 조회와 외부 요청은 대체), [화면](2026-10-02-webhook-settings-ui-verification.md) 합성 브라우저 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 031 적용·배포, 실제 전송 미검증
- [#48](https://github.com/AndrewDongminYoo/auto-chatter/issues/48) 작업 공간 API 키·연락처/플로 외부 API·제한과 감사
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#49](https://github.com/AndrewDongminYoo/auto-chatter/issues/49) Google Sheets 리드 동기화·중복 방지·CSV 대안
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#50](https://github.com/AndrewDongminYoo/auto-chatter/issues/50) 자동화·캠페인·상담 전환·비용 리포트
  - 현재 코드: 수동 답장·플로 실행·첫 답장 상태와 상담 전환 이벤트, 캠페인 실행의 기간별 관리자 조회·동일 결과 CSV 구현; 플로 실행의 날짜·계정·플로별 나누어 보기와 응답 대기 도달·받는이 답장 건수로 리포트 범위 완료
  - 로컬 증거: [수동 답장 검증](2026-10-16-manual-reply-reports-verification.md)·[플로 리포트 검증](2026-10-16-flow-run-reports-verification.md)·[상담 전환 검증](2026-10-16-handoff-reports-verification.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 리포트 범위 완료; 제공자 읽음 이벤트 #312·비용 리포트 #313으로 분리, 플로별 상담 귀속은 신원 증거라 제공하지 않음, 운영 검증 남음
- [#51](https://github.com/AndrewDongminYoo/auto-chatter/issues/51) 청구월 활성 연락처 원장·중복 제거·재계산
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52) 플랜 권한·좌석·채널·활성 연락처·예산 상한
  - 현재 코드: 플랜·좌석·연결 한도(#195, migration 045)와 사용자·작업 공간별 API 쓰기 제한(#193) 구현; 요금제별 월 캠페인 발송 한도(무료 0·에센셜 1,000·프로 5,000·비즈니스 20,000·어드밴스드 50,000건, 작업 공간 시간대의 달력 달, 승인·예약 변경·실행 시작 검사, 미리보기·설정·승인·실행 화면 표시, migration 없음) 로컬 구현·검증; 활성 연락처·예산 상한 미구현
  - 로컬 증거: [플랜 권한 계약](../specs/2026-10-12-plan-entitlements.md) 단위·DB 로컬 테스트, [한도 화면 검증](2026-11-09-campaign-monthly-limit-ui-verification.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 045 2026-10-12 운영 적용(#198), 월 캠페인 발송 한도 운영 미배포, 완료하지 않음
- [#53](https://github.com/AndrewDongminYoo/auto-chatter/issues/53) 판매 플랜·사업자·결제 공급자·환불/실패 정책 확정
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54) 구독 결제·체험·갱신·업/다운그레이드·해지 원장
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#55](https://github.com/AndrewDongminYoo/auto-chatter/issues/55) 작업 공간 FAQ 지식·버전·검색·출처 관리
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#56](https://github.com/AndrewDongminYoo/auto-chatter/issues/56) 응답 에이전트 모델 비교·구조화 출력·예산 제한
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#57](https://github.com/AndrewDongminYoo/auto-chatter/issues/57) AI 답변 승인 guard·상담원 인계·운영 평가
  - 현재 코드: 미구현
  - 로컬 증거: 미검증
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#58](https://github.com/AndrewDongminYoo/auto-chatter/issues/58) 개인정보 내보내기·삭제·보관 정책과 Meta 연결 해제
  - 현재 코드: 연결·이용자·작업 공간 단위 삭제·증적과 설정 화면, 작업 공간 내보내기 구현
  - 로컬 증거: [연결 삭제](../specs/2026-09-29-connection-data-deletion.md)·[이용자 삭제](../specs/2026-09-30-person-data-deletion.md) DB·Cloudflare 로컬 테스트, [삭제 화면](2026-09-30-connection-deletion-ui-verification.md) 합성 브라우저, [내보내기](../specs/2026-09-30-workspace-export.md)·[전체 삭제](../specs/2026-09-30-workspace-data-deletion.md) DB·Cloudflare 로컬 테스트 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 020·삭제 화면·내보내기 2026-09-30 적용, 실동작 미검증
- [#59](https://github.com/AndrewDongminYoo/auto-chatter/issues/59) 비밀 없는 운영 지표·경보·지원 진단
  - 현재 코드: 허용 필드 로그, 단계 기록, 관리자 지표·경보 API와 화면 구현
  - 로컬 증거: [운영 상태](../specs/2026-10-01-operations-health.md) 단위·DB·Cloudflare 로컬 테스트(Queue 소실·DB 실패·발송 제한·Cron 복구 재현은 로컬만), [화면](2026-10-01-operations-health-ui-verification.md) 합성 브라우저 확인
  - 공급자·실계정: 미검증
  - 운영 완료: 030 적용·배포, 운영 경보 미검증
- [#60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60) 앱 전체·계정·작업 공간 발송 한도와 공정한 스케줄링
  - 현재 코드: 연결별 비공개 답장 700회/최근 1시간 예산, 삭제 호출 이월, Cron 최대 100개 연결 순환 구현; 수동·팔로우 DM은 별도이며 캠페인은 연결당 시간당 1,000회 예산(#272)을 따로 쓰며, 발송 경로 전체를 묶는 공용 예산과 비용 상한은 남음
  - 로컬 증거: [발송 한도 계약](../specs/2026-10-12-send-quotas.md#검증)의 단위·DB·Worker 검사, [병합 코드·CI 대조](2026-10-16-acceptance-evidence-reconciliation.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#61](https://github.com/AndrewDongminYoo/auto-chatter/issues/61) 운영 백업·복구 훈련·암호화 키 회전·배포 복구
  - 현재 코드: 토큰 암호화 키 교체(v2 봉투, 키링, cron 단계 `token_key_rewrap`, #406, [spec](../specs/2026-11-24-token-key-rotation.md)); 백업 범위·RPO/RTO·키 보관 담당자·분리 환경 복구 훈련은 없음
  - 로컬 증거: 키 교체의 단위·DB·workerd 로컬 테스트, 그 밖의 범위는 추가 검증 필요
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#62](https://github.com/AndrewDongminYoo/auto-chatter/issues/62) 공개 다중 사용자 서비스 보안 회귀와 남용 방지
  - 현재 코드: 보안 회귀 감사 3회(#162·#169·#197)와 4차 감사(1부 발송 경로: 캠페인, DM 시작 트리거, 신원 연결 확인, 예약 답장, 세션 강화; 2부 읽기·데이터 경로: 세그먼트, 대상 고정, 연락처 CSV 내보내기·가져오기, 답장 템플릿, 보고서)와 그 회귀 테스트
  - 로컬 증거: [1·2차 감사](2026-10-07-security-regression-audit.md), [3차 감사](2026-10-12-security-regression-audit-3.md), [4차 감사](2026-11-09-security-regression-audit-4.md)
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#63](https://github.com/AndrewDongminYoo/auto-chatter/issues/63) 가입부터 플로·인박스·결제까지 사용성·접근성 검증
  - 현재 코드: 부분 기반
  - 로컬 증거: 기존 증거 있음, 추가 검증 필요
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음
- [#64](https://github.com/AndrewDongminYoo/auto-chatter/issues/64) ManyChat 대체제 전체 수용 테스트·운영 증거·출시 판정
  - 현재 코드: 부분 기반
  - 로컬 증거: 기존 증거 있음, 추가 검증 필요
  - 공급자·실계정: 미검증
  - 운영 완료: 완료하지 않음

#26의 후속 구현은 남은 고정 명단과 현재 활성 세그먼트의 추가·제외·유지 인원 수와 두 버전을 비교합니다([계약](../specs/2026-10-19-segment-snapshot-comparison.md), [로컬 검증](2026-10-19-segment-snapshot-comparison-verification.md)).
#25의 식별자 병합·분리와 #26 전체 선행 조건의 미완료 상태를 유지하며, 비교 기능의 운영 배포·실사용은 검증하지 않았습니다.

2026-10-20에는 전체 대시보드와 실제 로컬 Worker API·제한된 PostgreSQL 역할을 연결해 로그인·필터 저장·고정·변경 비교·CSV·권한·보관·삭제·페이지 처리를 확인했습니다([통합 수용 검증](2026-10-20-segment-integrated-acceptance-verification.md)).
외부 인증은 합성 응답이며 화면 승인, 실제 Supabase 인증, 공급자·실계정·운영 검증과 #25·#27의 선행 조건은 완료하지 않았습니다.
이 결과는 #26 전체 종료나 #35의 발송 가능 여부·비용·승인·예약 구현을 뜻하지 않습니다.

## 공개 제공과 최종 완료 조건

현재 구현 채널은 Instagram이며 제 계정에서 제한된 첫 DM·팔로우 분기를 확인했습니다.
추가 사용자의 Advanced Access와 수신 인박스의 남은 운영 검증은 별도 완료 조건입니다.
확인 버튼은 모바일 Instagram 앱에서 표시되고, 2026-10-07 발송을 켠 테스트에서 버튼 postback 뒤의 팔로우 조회와 미팔로우·팔로워 후속 DM까지 확인했습니다([기록](2026-09-29-issue13-production-verification.md#2026-10-07-후속-검증)). Chrome 웹에는 버튼이 표시되지 않으며, 이는 Meta 문서에 적힌 웹 버전 제한입니다.
WhatsApp·TikTok 이슈 #40–#43은 `unplanned`로 보관하며 현재 수용 범위에서 제외합니다.
Email·SMS·결제는 출시 국가·사업자·통화·비용·동의 정책을 제가 확정한 뒤 실제 제공 범위를 기록합니다.
FAQ AI는 오프라인 평가·초안 모드와 예산·인계가 확인되기 전 자동 발송을 허용하지 않습니다.

| 제공 범위                         | 현재 제한 사유                                                                                     | 공개 여부의 결정 담당자와 조건                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 다른 사용자의 Instagram 연결      | 저장소의 공개 연결 기본 설정은 꺼져 있고, 추가 사용자 권한 심사와 실계정 검증이 끝나지 않았습니다. | 제가 [#14](https://github.com/AndrewDongminYoo/auto-chatter/issues/14)의 승인·실계정 결과를 확인한 뒤 공개 연결을 결정합니다.                                                                                        |
| Instagram 팔로우 조건과 확인 버튼 | 제한된 실계정 결과만 있으며, 확인 불가·중복 이벤트가 남았고 웹에는 버튼이 표시되지 않습니다.       | 제가 [#14](https://github.com/AndrewDongminYoo/auto-chatter/issues/14)의 남은 결과와 [#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13)의 운영 증거를 확인합니다.                                     |
| Messenger·Telegram                | 채널 어댑터와 채널별 정책 검사가 구현되지 않았습니다.                                              | 구현자는 [#37](https://github.com/AndrewDongminYoo/auto-chatter/issues/37)–[#39](https://github.com/AndrewDongminYoo/auto-chatter/issues/39)를 검증하고, 제가 필요한 공급자 권한을 확인한 뒤 제공 여부를 결정합니다. |
| Email·SMS                         | 발신 인증, 출시 국가, 동의와 비용 정책 및 발송 어댑터가 확정되지 않았습니다.                       | 제가 [#44](https://github.com/AndrewDongminYoo/auto-chatter/issues/44)–[#46](https://github.com/AndrewDongminYoo/auto-chatter/issues/46)의 공급자·지역 결정을 확인한 뒤 제공합니다.                                  |
| 구독 결제                         | 판매 플랜·사업자·결제 공급자와 실패·환불 정책이 확정되지 않았습니다.                               | 제가 [#53](https://github.com/AndrewDongminYoo/auto-chatter/issues/53)을 결정하고 [#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54)의 원장을 검증합니다.                                             |
| AI 자동 답변                      | 근거 평가, 비용 상한과 상담원 인계가 구현·검증되지 않았습니다.                                     | 구현자와 제가 [#55](https://github.com/AndrewDongminYoo/auto-chatter/issues/55)–[#57](https://github.com/AndrewDongminYoo/auto-chatter/issues/57)의 오프라인 평가와 발송 정책을 확인합니다.                          |

제한 사유가 해소되기 전에는 해당 기능을 공개 지원으로 표시하거나 관련 발송을 활성화하지 않습니다.
이 표는 출시 범위의 결정 기준이며 공급자 승인 또는 운영 배포가 완료됐다는 증거는 아닙니다.

모바일 사용 사례는 반응형 웹에서 우선 검증합니다.
네이티브 앱·고급 A/B 실험·특정 CRM SDK는 최초 제품 명세의 후순위 또는 수요 검증 대상으로 유지하며 필요성이 확정되면 #12와 로드맵에 별도 필수 이슈를 추가합니다.
이들 항목을 이미 제공한다고 표시하거나 지원하지 않는 기능까지 포함한 동등성을 선언하지 않습니다.

전체 완료 문구를 사용할 조건과 완료 판정에서 제외하는 비목표는 [제품 명세의 전체 완료 선언 조건](../specs/2026-09-25-messaging-automation-platform.md#전체-완료-선언-조건)이 소유합니다.
이 매트릭스를 만들었다는 사실만으로 제품 검증이나 #64 완료를 의미하지 않습니다.

## 업데이트 규칙

병합 후 각 이슈 항목의 코드·로컬 증거를 해당 검증 기록에 연결합니다.
이슈별 상태는 표가 아닌 중첩 목록으로 적습니다.
긴 셀이 있는 표는 prettier가 모든 행을 가장 긴 셀의 너비까지 공백으로 채우므로, 2026-11-15에 표로 적혀 있던 이 파일은 174,553자였고 목록으로 바꾼 뒤에는 약 26,000자입니다.
운영 관찰은 배포 버전·시각·대상과 함께 기록하며 이전 상태를 현재 상태로 추정하지 않습니다.
모의 응답으로 확인한 권한·수신·가격을 실제 공급자 결과로 표시하지 않습니다.
