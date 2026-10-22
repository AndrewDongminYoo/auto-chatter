# 고정 대상에 메시지를 붙이는 캠페인 초안 API

## 상태와 근거

2026-10-21 운영자가 방향을 승인했고 저장·API를 구현했습니다.
API 검증 결과는 [구현 검증](../notes/2026-10-21-campaign-drafts-verification.md)에 기록합니다.
2026-10-22에는 연락처 메뉴에 관리자용 초안 관리 화면을 추가했습니다.
화면 검증은 [관리 화면 검증](../notes/2026-10-22-campaign-draft-ui-verification.md)에 기록합니다.
초기 API 설계의 기준 코드는 PR #241 병합 커밋 `325abd3d8748cd14b5e935fdc5f7059029040aa8`입니다.
주요 근거는 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35), [고정 대상 계약](2026-10-18-segment-target-snapshots.md), [요금제 권한 계약](2026-10-12-plan-entitlements.md)입니다.
초기 API 설계 시점에는 고정 명단만 저장되었으며, 그 명단에 메시지를 붙여 초안으로 보관하는 기능은 없었습니다.
요금제 계약은 현재 멤버 자리·연결 한도만 다루므로 캠페인 실행 권한이나 가격을 추정하지 않습니다.

## 구현 범위

관리자가 기존 고정 대상 하나를 참조하는 캠페인 초안을 만들고 조회·수정·보관하는 서버 API를 추가합니다.
초안은 계획 자료이며 발송 요청이 아닙니다.
저장했다고 Instagram에서 대량 발송할 수 있거나 대상자에게 동의·응답 창이 있다는 뜻이 아닙니다.
기존 대상 명단·식별자 연결·동의·발송 guard를 바꾸지 않습니다.

이번 단계의 메시지는 변수 치환 없는 일반 텍스트만 지원합니다.
이름은 NFC 정규화 후 1–60자, 본문은 기존 상담 답장 템플릿과 같은 1–1,000 UTF-16 코드 단위 제한을 적용하며 빈 내용과 NUL을 거절합니다.
`{{` 또는 `}}`가 있는 본문은 미해결 템플릿으로 거절합니다.
이 길이는 로컬 초안 저장 제약이며 공급자별 발송 가능성 검증을 대신하지 않습니다.
템플릿 선택·치환, 수신자별 개인화, 요금·동의·응답 창 미리보기, 예약·실행 승인, outbox 생성, 일괄 발송은 후속 범위입니다.
초기 API 변경에는 화면을 포함하지 않았습니다.
이후 추가한 관리 화면은 아래 계약을 따릅니다.

## 저장과 권한

새 `campaign_drafts` 테이블은 작업 공간, 고정 대상 ID, 이름, 본문, 양의 정수 버전, 생성·변경 시각, 생성·변경 운영자와 보관 여부를 저장합니다.
고정 대상과 작업 공간의 복합 외래 키로 다른 작업 공간의 명단을 참조하지 못하게 합니다.
대상 식별자를 복사하지 않고 기존 명단만 참조합니다.
원래 대상 수와 현재 남아 있는 명단 수는 조회 시 구분하며, 개인·연결 삭제 후 줄어든 명단을 복원하지 않습니다.
초안 생성 이후 원본 세그먼트가 보관돼도 고정 대상은 기존 계약대로 유지됩니다.

모든 API는 활성 `admin` 이상만 허용합니다.
기존 세션·동일 출처 검사·쓰기 한도와 `no-store` 응답을 사용합니다.
서버 역할은 SELECT·INSERT·UPDATE만, 외부 API 역할은 직접 접근 불가로 설정합니다.
초안은 내부 재시도 해시를 제외하고 작업 공간 내보내기에 포함하고 작업 공간 삭제 시 고정 대상보다 먼저 제거합니다.
작업 공간 이동의 비어 있음 판정도 새 테이블을 반영합니다.

저장 폭증을 막기 위해 보관된 초안을 포함해 작업 공간당 100개로 제한합니다.
이는 요금제 상품 권한이 아닌 초기 저장 한도이며, 보관으로 한도를 되돌리지 않습니다.
생성 시 작업 공간 잠금 안에서 한도를 검사합니다.

## API

- `POST /api/campaign-drafts`: 클라이언트가 만든 UUID `id`, `snapshot_id`, `name`, `body`를 받습니다. 같은 ID·같은 최초 요청의 재시도는 중복 생성하지 않아야 합니다. UUID는 소문자, 이름은 NFC·앞뒤 공백 제거, 본문은 입력 그대로인 네 필드를 고정 순서로 JSON 직렬화한 SHA-256 해시를 보존하고 재시도 때 대조합니다.
  재시도는 현재 초안을 반환하며 수정·보관 상태를 되돌리지 않습니다. 수정된 현재 본문으로 최초 요청을 판별하지 않습니다.
- `GET /api/campaign-drafts`: 최대 100개 요약을 반환하며 본문·대상 식별자는 제외합니다.
- `GET /api/campaign-drafts/:id`: 본문, 버전, 보관 상태와 원래·현재 남은 대상 수를 반환합니다.
- `PUT /api/campaign-drafts/:id`: `expected_version`, `snapshot_id`, `name`, `body`를 받습니다. 버전이 다르면 409이며 보관된 초안은 수정하지 못합니다. 성공한 수정은 내용이 같아도 버전을 1 증가시킵니다.
- `POST /api/campaign-drafts/:id/archive`: `expected_version`으로 보관하고 버전을 1 증가시키며 이후 수정·재보관은 409로 거절합니다.

생성은 201, 성공한 재시도·조회·수정·보관은 200을 사용합니다.
잘못된 요청은 400, 권한 부족은 403, 없거나 다른 작업 공간의 대상은 같은 404, 버전·상태·ID 충돌과 저장 한도는 409로 구분합니다.
재시도·버전 검사·한도·참조 확인은 한 트랜잭션으로 처리합니다.
기존 공개 API는 변경하지 않습니다.

## 수용 기준

1. 실제 PostgreSQL에서 관리자만 같은 작업 공간의 고정 대상으로 초안을 만들 수 있습니다.
2. 생성 응답을 잃어 재시도해도 한 초안만 생기며, 다른 내용으로 같은 ID를 재사용하면 충돌합니다.
3. 동시 수정 중 한 버전만 저장되고 한도 경합이 초과 저장을 만들지 않습니다.
4. 개인·연결 삭제 후 현재 명단 수는 감소하지만 원래 수와 초안은 보존하며 삭제된 식별자가 복원되지 않습니다.
5. 작업 공간 내보내기·삭제·이동·서버 역할 테스트에 실제 초안 행을 넣어 경계를 검사합니다.
6. 초안 작업 전후 outbox·동의 원장·고정 명단이 바뀌지 않습니다.
7. #35 전체, #36 발송, #52 방송 권한의 완료나 운영 배포로 보고하지 않습니다.

## 관리 화면

연락처 메뉴에서 소유자와 관리자가 고정 대상 선택, 일반 텍스트 초안 생성·목록·조회·수정·보관을 사용할 수 있습니다.
대상이 없으면 저장된 필터에서 명단을 고정한 뒤 목록을 새로고침하도록 안내합니다.
보관된 필터의 고정 명단도 선택할 수 있으며, 상세에 원래 인원과 현재 남은 인원을 구분합니다.
이 인원은 발송 가능 인원이나 동의 확인 결과가 아닙니다.
보관된 초안은 조회만 하며 100개 저장 한도에 계속 포함됩니다.

생성 응답을 잃으면 UUID와 최초 본문을 유지하고 입력·다른 초안 선택을 잠급니다.
운영자가 같은 요청을 재시도해 결과를 확인할 수 있습니다.
재시도가 요청 한도에 막혀도 원래 요청의 결과가 확인된 것은 아니므로 동일 UUID와 본문을 유지합니다.
수정·보관의 결과가 불명인 경우에도 동일 요청만 재시도하며, 충돌 응답 뒤에는 자동으로 다시 저장하지 않습니다.
버전 충돌은 입력을 보존하고 저장 버튼을 막으며, 명시적으로 저장된 값을 다시 읽은 뒤 수정합니다.
다른 초안을 열거나 새 초안을 시작할 때, 저장하지 않은 입력이 있으면 버릴지 확인합니다.
목록 새로고침은 편집 내용을 덮어쓰지 않습니다.

세션·작업 공간 변경과 권한 거절은 이전 입력·목록을 지우고 늦은 응답을 폐기합니다.
다른 탭의 세션 변경과 뒤로 가기 복원 신호에서도 내용을 지우며, 기존 ‘다시 불러오기’ 동작으로 서버 권한을 다시 확인해야 화면이 돌아옵니다.
무효화 이전에 시작한 작업 공간 조회는 신원·멤버십 응답 뒤에 화면을 다시 구성하지 못합니다.
같은 문서가 보낸 세션 알림은 새 로그인 조회를 취소하지 않도록 구분하며, 로컬 로그인 직후에는 먼저 보호된 데이터를 지운 뒤 다른 문서에 알립니다.
상세 조회에 성공하면 편집기 제목으로 포커스를 옮겨 긴 목록 아래의 편집기를 찾을 수 있게 합니다.
예약·승인·비용·템플릿 치환·실제 발송은 이 화면에 포함하지 않습니다.

## 승인 경계

새 저장 모델과 API 범위에 대한 방향 승인을 받았습니다.
운영 DB·배포·실계정·발송·가격 정책은 이번 `pr-loop` 구현 범위에서 제외합니다.
초기 API 변경은 화면이 없었으며, 후속 관리 화면의 로컬 검증과 전체 이슈의 운영 수용은 구분합니다.

## 선례 조회

개인 `auto-chatter`의 `campaign draft`, `plan entitlements` 및 축소 검색에서 관련 Oracle 결과는 \[no precedent found\]였습니다.
Provider sourceCommit은 `c1681868ac634e4b2414874716bb75a7864113c4`이며 원본 최신성은 미확인입니다.
현재 이슈·고정 대상·요금제 계약을 제안 근거로 사용하며 선례 조회를 방향 승인으로 취급하지 않습니다.

The shared API wrapper checks the captured workspace generation before starting authentication refresh after a 401 and before replaying the original request.
A session invalidated in either interval must reject the retired request without replaying its original input; an unchanged session retains the existing one-refresh retry.
Cookie-changing authentication requests and protected retries are serialized across participating documents with Web Locks. A localStorage pending/ready revision rejects queued work from an older or incomplete account transition before it sends. Automatic refresh is disabled without Web Locks or usable shared storage; explicit login remains available when Web Locks is unsupported, while storage publication failures prevent coordinated cookie-changing requests. This protects the tested active-document schedule; it does not establish server-side fencing of requests from closed or older clients. See [verification and limits](../notes/2026-10-22-auth-cookie-response-order.md).
