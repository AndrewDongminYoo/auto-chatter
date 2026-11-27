# 외부 연락처 읽기 API 설계

## 목적

[이슈 #48](https://github.com/AndrewDongminYoo/auto-chatter/issues/48)의 두 번째 단계입니다.
[작업 공간 API 키](2026-11-27-workspace-api-keys-design.md)를 가진 CRM이나 자체 서버가 작업 공간의 댓글 연락처를 읽어 갈 수 있게 합니다.
첫 단계의 `GET /v1/key`는 2026-11-27 운영에서 Andrew가 발급한 실제 키로 `200` 응답을 확인했습니다(근거는 아래 "검증"의 문서 항목).

이번 단계에서 이슈의 남은 완료 조건 가운데 읽기 쪽 두 가지도 함께 만듭니다.
외부 API의 OpenAPI 계약 문서와 권한 침해 테스트입니다.
연락처 변경과 플로 시작 같은 쓰기 API는 다음 단계입니다.

## Andrew가 정한 것

- 응답 범위는 [연락처 CSV 내보내기 v1](2026-10-04-contact-csv-export.md#파일-범위와-형식-v1)과 같은 정보입니다. 댓글 작성자의 사용자명과 동의 상태는 내보내지 않으므로, 외부로 나가는 개인정보의 범위가 늘지 않습니다.
- 동기화는 전체 목록을 커서 페이지로 읽는 방식입니다. 변경된 연락처만 읽는 증분 동기화는 만들지 않으며, migration도 없습니다.

## 목표

- `GET /v1/contacts`가 키의 작업 공간에 저장된 댓글 연락처를 페이지 단위로 돌려줍니다.
- `contacts:read` 권한이 없는 키는 거절합니다.
- 다른 작업 공간의 데이터는 어떤 입력으로도 읽을 수 없습니다.
- 외부 API 전체(`GET /v1/key`, `GET /v1/contacts`)의 계약을 OpenAPI 3.1 문서로 저장소에 둡니다.
- 권한 침해 테스트로 위의 경계를 고정합니다.

## 비목표

- 연락처 쓰기, 플로 시작, 웹훅 등록 같은 쓰기 API.
- 증분 동기화(`updated_since`)와 연락처 변경 시각 추적.
- 연락처 한 명 조회 경로, 검색·필터(연결 ID 하나로 좁히기는 예외, 아래 참고), 세그먼트 조회.
- DM 대화 상대, 동의 상태, 댓글·DM 원문, 연락처 사용자명.
- 요금제별 API 제한.

## 피해야 할 결과

- 다른 작업 공간의 연락처가 응답에 섞이는 것.
- CSV 내보내기보다 많은 개인정보가 API로 나가는 것.
- 페이지 사이에 연락처가 빠지거나 두 번 나오는데 클라이언트가 알 수 없는 것. 단, 읽는 동안 새로 생긴 연락처가 이미 지나간 위치에 들어가면 이번 순회에서는 빠지며, 이 한계는 계약 문서에 적습니다.

## 설계 결정 (작성자의 판단)

### 경로와 요청

- `GET /v1/contacts?limit=<1~100, 기본 100>&after=<커서>&connection_id=<UUID>`.
- `connection_id`는 선택이며, 주면 그 연결의 연락처만 돌려줍니다. 키의 작업 공간에 속하지 않는 연결 ID는 연락처가 없는 연결과 같은 빈 목록이 아니라 `404 connection_not_found`입니다. 작업 공간 밖의 연결이 존재하는지는 드러내지 않습니다(어느 작업 공간에도 없는 ID와 같은 응답).
- 알 수 없는 쿼리 키, 범위 밖의 `limit`, 형식이 틀린 커서는 `400 invalid_request`입니다.
- 커서는 마지막 행의 `(connection_id, sender_id)`를 담은 base64url 문자열입니다. 클라이언트는 내용을 해석하지 않고 그대로 돌려보냅니다. 커서에는 작업 공간을 넣지 않으며, 서버는 항상 키의 작업 공간 조건을 함께 겁니다.

### 응답

- 본문: `{ "contacts": [...], "next_cursor": "<커서>" | null }`. 마지막 페이지의 `next_cursor`는 `null`입니다.
- 연락처 한 건은 CSV v1의 열을 JSON 이름으로 옮긴 객체입니다: `channel`(`instagram`), `identity_kind`(`comment_sender`), `connection_id`, `sender_id`, `connection_username`, `first_comment_recorded_at`, `last_comment_recorded_at`, `comment_count`, `automation_paused`, `tags`(문자열 배열), `fields`(활성 필드 UUID를 키로 `{name,type,value}`).
- CSV와 마찬가지로 `sender_id`와 `comment_count`는 문자열이고, 필드 값은 PostgreSQL이 만든 JSON 그대로여서 숫자 정밀도를 잃지 않습니다. CSV의 표시용 작은따옴표는 API에서는 붙이지 않습니다.
- 정렬은 연결 UUID, 그다음 작성자 텍스트의 고정된 순서입니다. 작성자 순서는 CSV의 `C` 정렬이 아니라 열의 기본 collation이며, DB 기본 collation이 `C`이면 CSV와 같습니다.
  `instagram_comment_events_contact_lookup_idx`가 열의 기본 collation으로 만들어져 있어서, `C` 정렬의 커서 범위와 정렬은 이 인덱스를 쓰지 못하고 페이지마다 남은 댓글 전체를 다시 집계합니다. migration 없이 페이지 한 번의 비용을 그 페이지의 연락처로 묶으려고 인덱스의 collation을 씁니다.
  클라이언트는 순서에 기대지 않고 커서만 씁니다.
- 연결 해제한 계정의 연락처도 CSV처럼 포함합니다.
- `format_version`, `exported_at`, `workspace_id`는 행마다 넣지 않습니다. 작업 공간은 `GET /v1/key`가 알려 줍니다.

### 권한과 한도

- 인증과 한도는 첫 단계와 같습니다. IP별 1분 600회 뒤 키 조회, 키별 1분 60회입니다. 페이지당 100명이므로 키 하나로 1분에 6,000명을 읽을 수 있습니다.
- 키의 `scopes`에 `contacts:read`가 없으면 `403 insufficient_scope`입니다. 지금 `api_keys.scopes`의 CHECK 제약은 `{contacts:read}`만 허용하므로 실제 키로는 이 응답이 나오지 않습니다. 권한이 늘어날 때를 위한 방어 경로이며, 키 행을 모의 객체로 만든 단위 테스트로만 확인합니다. 이를 위해 migration이나 테스트 DB의 제약 변경을 하지 않습니다.
- 인증에 성공한 `200` 응답은 `GET /v1/key`와 같이 마지막 사용 시각과 IP를 기록합니다. `400`, `403`, `404`는 기록하지 않습니다.
- 한 페이지는 한 번의 읽기 쿼리이며 트랜잭션이나 잠금을 잡지 않습니다.

### OpenAPI 문서

- 위치는 `docs/api/openapi-v1.json`(OpenAPI 3.1)이며 저장소에만 둡니다. 서버가 이 파일을 제공하지 않습니다.
- 두 경로, Bearer 인증, 오류 코드(`400 invalid_request`, `401 invalid_api_key`, `403 insufficient_scope`, `404 connection_not_found`, `404 not_found`, `405 method_not_allowed`, `429 rate_limited`, `503`), 응답 스키마, 커서 사용법과 페이지 사이에 새 연락처가 빠질 수 있다는 한계를 적습니다.
- 단위 테스트가 문서의 경로·메서드 목록과 `public-api.ts`가 처리하는 경로·메서드 목록이 같은지 확인합니다.

### 권한 침해 테스트

DB 테스트로 다음을 고정합니다.

- 작업 공간 A의 키로 B의 연락처를 읽을 수 없습니다. B의 연결 ID를 `connection_id`로 줘도, B의 행 위치를 담은 커서를 줘도 B의 연락처가 나오지 않습니다.
- 폐기된 키, 만료된 키, 형식이 틀린 키, 쿼리 문자열로 보낸 키는 `401`입니다.
- 응답 객체에 CSV v1에 없는 키(사용자명, 동의, 원문, 자격 증명)가 없습니다.
- 키를 만든 멤버를 제거한 뒤에는 그 키로 읽을 수 없습니다.

### 그 밖의 작성자 판단

- 커서가 가리키는 연결과 `connection_id`가 다르면 `400 invalid_request`입니다.
- 한 페이지 쿼리의 시간 제한은 CSV 내보내기와 같은 10초입니다.
  이 제한은 클라이언트 쪽 읽기 시간 제한(`query_timeout`)입니다. CSV 내보내기는 트랜잭션 안에서 `statement_timeout`도 걸지만, 한 페이지는 트랜잭션을 잡지 않으므로 서버 쪽 제한을 걸지 않습니다. 시간이 초과되면 요청은 `503`으로 끝나지만, `pg`가 취소 요청을 보내지 않으므로 PostgreSQL에서 문장이 더 실행될 수 있습니다.
- 필드 JSON은 PostgreSQL이 만든 텍스트를 응답에 그대로 이어 붙여, JavaScript 숫자 변환으로 정밀도를 잃지 않게 합니다.

## 빌더에게 맡기는 것

- 쿼리의 구체적인 형태. CSV 내보내기의 SELECT와 필드 JSON 생성을 재사용할 수 있으면 재사용합니다.
- 커서 인코딩의 세부 형식.
- OpenAPI 문서의 설명 문장(영어).

## 검증

- 단위: 쿼리 검증, 커서 왕복, `403 insufficient_scope`, OpenAPI 경로 목록 일치.
- DB: 페이지 경계(정확히 100명, 101명, 0명), 정렬, 연결 해제 계정 포함, 필드 자료형과 숫자 정밀도, 위의 권한 침해 테스트.
- workerd: 실제 Worker에서 `/v1/contacts`가 키와 한도를 거쳐 응답함.
- 문서:
  - `docs/specs/2026-11-27-workspace-api-keys-design.md`에 날짜를 붙인 "운영 확인" 절을 더합니다. 내용은 다음과 같습니다: 2026-11-27 migration 080을 백업 뒤 운영에 적용하고 Worker `eb7c4df5`(main `11cfbae`)를 배포했으며 공개 smoke 35/35가 통과했습니다. 같은 날 키 없는 요청과 잘못된 키가 `401 invalid_api_key`임을 확인했고, Andrew가 운영 대시보드에서 발급한 키(만료 2026-12-27)로 `GET /v1/key`의 `200` 응답을 받았습니다. 키 ID와 작업 공간 ID는 적지 않습니다.
  - `docs/notes/2026-09-27-manychat-acceptance-matrix.md`의 #48 행에서 "실제 키 발급과 사용은 확인하지 않음"을 위 확인 결과로 바꿉니다. 이 PR이 연락처 API를 운영에 배포하지는 않으므로, 연락처 API는 "로컬 구현"으로만 적습니다.
  - `docs/agents/feature-invariants.md`의 API 키 절을 갱신합니다.
- 단위·DB·workerd 테스트는 운영 Worker나 운영 DB의 동작을 증명하지 않습니다.
