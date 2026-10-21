# 캠페인 초안 관리 화면 검증

## 범위

[#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)의 후속 범위로 연락처 메뉴에 관리자용 초안 관리 화면을 구현했습니다.
기준 로컬 HEAD는 `ce8694ab00caa50ee1cd51021ed756ffa038a744`이며, 원격 `main`의 PR #242 병합 커밋 `2e24859d13dff981d3b148f3a5ecf3a019107646`과 파일 내용이 같은 상태에서 작업했습니다.
기존 초안·고정 대상 API를 사용하며 서버 코드·DB 스키마·의존성은 변경하지 않았습니다.
고정 대상 선택, 일반 텍스트 초안 생성·조회·수정·보관, 보관된 초안 조회와 원래·현재 인원 구분을 제공합니다.
예약·실행 승인·발송 가능 여부·비용·템플릿 치환·실제 발송은 구현하지 않았으며 #35 전체 완료를 뜻하지 않습니다.

화면은 기존 대시보드의 카드·폼·글꼴·테마를 따릅니다.
별도 Copy voice 선언은 확인하지 못해 따뜻하고 직접적인 안내를 기본으로 하되, 문장 종결은 기존 화면의 합니다체를 유지했습니다.
구현 명칭·마이그레이션 번호·요청 해시는 사용자 안내에서 제외했으며, 저장과 발송의 차이·한도·재시도 동작만 설명합니다.

## 실패 재현과 수정

- 화면 컨트롤러가 없는 상태에서 실제 화면 모듈을 실행하는 새 검사가 실패하는 것을 확인했습니다.
- 응답 유실은 생성 UUID·본문을 유지한 채 입력을 잠그며, 같은 요청만 재시도합니다.
- 응답 유실 후 429를 받는 재시도가 UUID를 잊는 실패를 재현하고, 429에서도 기존 요청을 유지하도록 수정했습니다.
  서로 다른 UUID를 만드는 fixture에서 세 번의 요청 ID가 모두 같음을 검사합니다.
- 충돌은 입력을 보존하고 추가 저장을 막으며, 명시적으로 저장된 값을 읽은 뒤 수정합니다.
- 네이티브 select는 선택지 없는 값을 빈 값으로 바꿉니다.
  목록 조회 뒤 새로 생성된 고정 대상을 참조하는 초안을 여는 실패를 재현하고, 선택지를 먼저 만든 뒤 UUID를 선택하도록 수정했습니다.
- 세션 초기화 뒤 화면 복구 경로가 없던 실패를 재현하고 기존 ‘다시 불러오기’ 버튼으로 서버 권한을 다시 확인하도록 수정했습니다.
- 긴 목록의 첫 초안을 열어도 편집기가 화면 밖에 남는 것을 브라우저에서 확인했습니다.
  상세 조회 성공 후 편집기 제목에 포커스를 옮기도록 수정했습니다.
- 첫 전체 단위 실행에서는 기존 세션 이벤트 fixture에 새 컨트롤러가 없어 한 건 실패했습니다.
  해당 fixture에 캠페인 초기화와 재조회 진입 검사를 추가한 뒤 통과했습니다.

## 자동 검사

최소 확인 명령은 `corepack pnpm check-types`와 `corepack pnpm test`입니다.
타입 검사는 TypeScript의 정적 타입을, 단위 검사는 실제 화면 모듈의 상태·요청·응답 처리와 기존 순수 로직을 읽습니다.
전체 단위 검사 382개가 통과했습니다.
VM의 DOM 대체물만으로 실제 렌더링을 확인했다고 판단하지 않습니다.
`corepack pnpm build:cloudflare`는 번들·정적 자산 구성을 확인하며 실제 배포는 하지 않았습니다.
변경 경로를 지정한 `trunk fmt`·`trunk check`와 `git diff --check`도 통과했습니다.
서버·스키마 변경이 없어 전체 DB·workerd 자동 검사 묶음은 다시 실행하지 않았으며, 아래 실제 Worker 수용 검사로 화면과 기존 API를 연결했습니다.

## 실제 대시보드·Worker 검증

`scripts/segment-acceptance.mjs`를 새 전용 PostgreSQL 클러스터에서 실행했습니다.
실제 정적 앱·Worker·제한된 서버 DB 역할을 사용하고 외부 인증만 합성 응답으로 대체합니다.
발송과 공개 연결은 비활성화했으며 운영 DB·계정·공급자 호출은 사용하지 않았습니다.
이름을 지정한 `campaign35` 브라우저 세션에서 다음을 확인했습니다.

- 빈 목록에서 대상 고정 안내를 확인한 뒤, 로컬 API로 만든 고정 대상 2명을 선택해 초안을 저장했습니다.
- 화면 수정은 버전 2, 별도 API 변경은 버전 3이 됐습니다.
  이전 화면에서 저장하면 409 안내와 로컬 입력이 유지되고 저장 버튼이 비활성화됐습니다.
  다시 불러오기 확인을 거절하면 입력이 유지되고, 승인하면 버전 3의 서버 본문을 읽었습니다.
- 보관 후 버전 4와 읽기 전용 입력·저장 비활성화를 확인했습니다.
- 다음 생성 요청은 실제 서버가 저장한 성공 응답을 브라우저 fetch 대체물에서 한 번 버렸습니다.
  화면의 동일 요청 재시도 후 새 초안은 버전 1의 한 행만 존재했습니다.
  이 응답 유실 주입은 로컬 수용 검사만을 위한 것으로 제품 파일에는 들어가지 않습니다.
- 명단 한 행을 로컬 fixture에서 제거한 뒤 상세가 원래 2명·현재 1명으로 표시됐습니다.
- 목록에 없는 새 고정 대상으로 초안을 재배정한 뒤 기존 화면에서 열었습니다.
  새 대상 UUID와 대체 선택지가 유지되고, 사용자 입력 없이 변경 상태가 되지 않았으며 편집기 제목이 포커스를 받았습니다.
- 브라우저에서 합성 `pageshow` 복원 신호를 전달하면 본문·카드가 지워지고 재조회 버튼이 나타났습니다.
  실제 재조회 후 카드가 돌아오고 재조회 버튼이 숨겨졌습니다.
  실제 브라우저 BFCache 진입 자체를 재현한 검사는 아닙니다.
- 상담원으로 새 로그인하면 카드와 이전 본문이 없고 직접 조회 API는 403을 반환했습니다.
- 390px 화면의 문서 폭은 390px였으며, 충돌·보관·응답 유실 화면을 캡처해 시각적으로 확인했습니다.
- 카드에 한정한 axe 검사에서 위반 0개·미완료 0개를 확인했습니다.
  최초 검사에서 일반 div의 aria-label 문제가 미완료로 나타나 의미 있는 group 역할을 추가한 뒤 다시 검사했습니다.

초안 생성·수정·보관 후 DB의 초안은 2개였으며 비공개 답장 outbox·수동 답장·동의 이벤트는 각각 0개였습니다.
이는 해당 합성 시나리오의 관찰이며, 기존 비어 있지 않은 발송 원장의 불변성 검사는 초기 API 검증 기록을 참조합니다.
검증 후 브라우저 세션·Worker·임시 PostgreSQL을 종료했으며 두 로컬 포트의 연결 거절을 확인했습니다.
캡처와 실패·최종 검사 로그는 인접 작업 공간의 `../pr-loop-reviews/auto-chatter/2026-10-22-campaign-draft-ui/`에 보관합니다.

## 리뷰와 Oracle

컨트롤러 상태 전이와 앱 연결·접근성을 나눈 독립 읽기 전용 리뷰를 수행했습니다.
발견한 대상 선택·요청 한도 재시도·세션 복구·포커스 문제를 수정했고, 해당 경로 재검토에서 남은 지적은 없었습니다.
루트 검토에서 실제 API 응답 모양, 생성 중복 방지, 버전 충돌과 권한 거절을 대조했습니다.

Oracle 조회 실패는 설정 장애가 아니었습니다.
`/Users/dongminyu/.codex/agents/oracle.toml`의 Retrieval 절은 일반 역할에 MCP가 없으며 전용 `run-mcp-worker.py oracle` 런처를 사용하도록 정합니다.
서브에이전트가 `/Users/dongminyu/Development/01_personal/llm-wiki-dongminyu/wiki/index.md`의 개인 원격 매핑으로 프로젝트 ID `auto-chatter`를 확인한 뒤 전용 런처 조회에 성공했습니다.
`campaign draft`·`dashboard UI`, 재표현 `campaign`·`dashboard`에서 관련 결과는 \[no precedent found\]였습니다.
제공자 리비전은 `c1681868ac634e4b2414874716bb75a7864113c4`이며 현재 원본과의 최신성은 미확인입니다.
설정·전역 MCP 활성화 변경은 없었고, 기존 계약과 승인된 관리 화면 범위로 방향을 유지했습니다.

## PR #243 세션 경합 수정

호스티드 코드 리뷰에서 세션 변경 전에 시작한 작업 공간 조회가 늦게 완료되면 카드를 다시 구성할 수 있는 경로를 지적했습니다.
실제 `loadWorkspace`와 세션 무효화 함수를 실행하고 `/api/me` 또는 `/api/workspace` 응답을 각각 보류하는 회귀 검사에서 이전 응답이 초안 구성을 한 번 호출하는 실패를 재현했습니다.
세션 무효화 시 작업 공간 조회 세대를 증가시키고, 멤버십 응답 직후에도 세대를 검사하도록 수정했습니다.
수정 후 두 경로 모두 초안 구성을 호출하지 않았고 관련 화면 검사 22개가 통과했습니다.
이 회귀 검사는 실제 앱 함수를 읽지만 HTTP·DOM은 대체하며, 새 브라우저나 운영 검증을 뜻하지 않습니다.
전체 수정 후 타입·단위·번들·정적 검사 결과는 PR의 현재 커밋과 로컬 리뷰 기록으로 대조합니다.

세대 무효화가 같은 탭의 두 BroadcastChannel 객체 사이에서도 로그인 조회를 취소하는 부작용을 별도로 재현했습니다.
문서별 발신 표식을 전달해 같은 문서의 알림만 제외하고, 다른 문서와 구버전 알림은 계속 처리합니다.
로그인 성공 시 보호된 데이터를 동기적으로 지운 뒤 알림을 보내므로 자기 메시지를 제외해도 로컬 초기화는 유지됩니다.
실제 BroadcastChannel 객체의 같은 문서·다른 문서 전달 검사와 실제 API 함수의 초기화 순서 검사를 추가했습니다.

필터 작업의 완료 처리와 수명 주기를 공유하지 않도록 작업 공간 조회 전용 세대를 사용합니다.
세션 무효화는 이 세대만 증가시키며, 기존 필터 작업의 세대와 잠금 해제 처리는 유지됩니다.
최종 관련 회귀 검사 42개가 통과했습니다.

## Automatic retry session boundary

The final scoped security coverage critic identified a separate unreviewed path: the shared API wrapper could replay a retired request after a 401 and shared authentication refresh.
This was a source-grounded coverage question, not a confirmed security finding.
A regression against the previous source failed with `Missing expected rejection` when a session changed before the first 401 response.
The wrapper now checks the captured workspace generation before starting refresh and again before replaying the original request.
The regression covers a session change before the 401 response, during pending refresh, and an unchanged session that must still refresh and retry exactly once.
The affected CSV/API test file passes after the repair.
The original audit candidate is retained as incomplete; the pushed replacement requires fresh current-head audit coverage, hosted review and CI.

Fresh ordinary implementation verification passed: `corepack pnpm check-types`, `corepack pnpm test` (386 passed), `corepack pnpm build:cloudflare` (dry run), and explicit-path `trunk check --no-fix`.
These checks validate the implementation and are not OS-sandboxed security-audit evidence.
