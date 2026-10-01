# 작업 공간 데이터 내보내기

## 범위

[이슈 #83](https://github.com/AndrewDongminYoo/auto-chatter/issues/83)의 첫 번째 PR입니다.
로그인한 멤버는 설정 화면에서 자신의 작업 공간 데이터를 JSON 파일 하나로 내려받습니다.
작업 공간·로그인 계정 전체 삭제와 그에 따른 공개 문구 변경은 이어지는 PR에서 다룹니다.
관리자 이상만 내보낼 수 있으며, 역할은 [작업 공간 역할 계약](2026-09-30-workspace-roles.md)을 따릅니다.

## API

`GET /api/workspace/export`는 내보내기 트랜잭션 안에서 호출자의 `workspace_members` 행으로 작업 공간을 찾고, 멤버십이 없으면 `403 workspace_required`, 상담원이면 `403 role_forbidden`을 반환합니다.
응답은 `Cache-Control: no-store`와 `Content-Disposition: attachment; filename="auto-chatter-export-<UTC 날짜>.json"`을 가집니다.
본문은 `format`(`auto-chatter-workspace-export`), `version`(1), `exported_at`, `workspace_id`, `excluded`, `tables`로 구성됩니다.
`tables`의 각 값은 해당 테이블의 행을 열 이름 그대로 담은 배열입니다.
멤버십 확인과 모든 테이블 조회를 하나의 `REPEATABLE READ READ ONLY` 트랜잭션에서 수행해, 동시에 제거된 멤버는 내보낼 수 없고 서로 참조하는 행은 같은 시점의 상태로 내보내집니다.
행은 PostgreSQL이 만든 JSON 문자열 그대로 응답 본문에 넣고, 화면도 받은 문자열을 그대로 저장합니다. JavaScript에서 해석하면 2^53을 넘는 bigint ID가 반올림되기 때문입니다.

## 포함과 제외

- `src/app/workspace-export.ts`의 `EXPORTED_TABLES`에 있는 테이블을 내보냅니다. `workspace_id`가 없는 팔로우 대화와 확인 메시지 수신 기록은 작업 공간의 연결을 통해 범위를 정하고, `workspaces`는 호출자의 작업 공간 행 하나(ID와 시간대 설정)만 내보냅니다.
- 댓글·DM 작성자 ID와 본문처럼 작업 공간이 운영하며 쌓은 기록은 포함합니다.
- 연결의 `access_token_encrypted`와 초대의 `token_hash`는 제외합니다. 토큰 만료·발급 시각은 포함합니다.
- `instagram_oauth_states`(짧게 쓰이는 로그인 비밀값), `workspace_deletion_records`(이미 삭제된 작업 공간의 증적), `scheduled_steps`(작업 공간 데이터가 없는 서비스 전체 운영 상태, [운영 상태](2026-10-01-operations-health.md))는 `EXCLUDED_TABLES`로 제외합니다.
- 새 public 테이블은 `EXPORTED_TABLES`나 `EXCLUDED_TABLES` 중 하나에 넣어야 하며, DB 테스트가 이를 강제합니다. 이름에 `token`, `secret`, `encrypt`, `password`, `hash`가 들어간 열은 시각 열 세 개를 빼고 `omit`에 넣어야 합니다.

## 화면

연결 계정 목록 아래의 "데이터 내보내기" 버튼이 API 응답을 JSON 파일로 저장하고, 댓글·메시지 내용이 들어 있으니 안전하게 보관하라고 안내합니다.
오류는 기존 전역 안내 영역에 표시합니다.

## 한계

내보내기는 한 요청에서 전체 행을 메모리에 모읍니다.
현재 운영 규모에서는 문제가 없지만, 작업 공간 데이터가 Worker 메모리 한도에 가까워지면 테이블별 분할이나 비동기 생성이 필요합니다.

## 검증

1. DB 테스트는 다른 작업 공간의 행과 토큰 암호문·OAuth state가 빠지는지, 모든 내보내는 테이블이 채워지는지, 모든 public 테이블이 분류되었는지 확인합니다.
2. workerd 테스트는 제한된 서버 역할로 내보내기가 성공하고 토큰 암호문이 없는지 확인합니다.
3. 합성 API로 브라우저 다운로드, 오류 표시, 390px 폭을 확인합니다. 운영 배포는 별도로 승인을 받습니다.
