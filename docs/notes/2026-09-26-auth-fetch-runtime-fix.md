# 인증 요청의 Cloudflare 런타임 오류 수정

## 증상과 원인

운영자가 `/api/auth/signup`의 HTTP 503을 보고했습니다.
동일한 운영 Worker에서 존재하지 않는 진단 계정의 로그인 요청도 503 `auth_unavailable`을 반환했고, 같은 로그인 요청을 Supabase Auth에 직접 보냈을 때는 400 `invalid_credentials`였습니다.
진단에는 예약된 `example.invalid` 주소를 사용했으며 사용자 생성이나 이메일 발송은 수행하지 않았습니다.

`AuthClient`가 native fetch를 속성에 저장한 뒤 `this.fetchImpl(...)`로 호출하면서 클라이언트 객체를 함수 수신자로 전달했습니다.
workerd에서 이 호출이 실패해 인증 제공자 응답을 받기 전에 503으로 처리됐습니다.
주입된 테스트 함수로 실행하는 Node 단위 테스트는 이 런타임 차이를 검출하지 못했습니다.
생성자에서 `(input, init) => fetchImpl(input, init)`으로 감싸 독립 함수 호출로 실행하도록 수정했습니다.
인증 헤더·쿠키·오류 판정과 DB 권한은 변경하지 않았습니다.

## 회귀 검증

`src/cloudflare/runtime.db.test.mjs`에 실제 번들·workerd native fetch를 사용하는 테스트를 추가했습니다.
외부 Supabase 응답만 합성하며 회원가입 성공 응답 200과 잘못된 로그인 응답 401을 검사합니다.
이 테스트는 기존 `test:cloudflare` 목록에 포함된 파일에서 실행되며, 이름으로 선택하면 DB 없이 실행할 수 있습니다.

```bash
corepack pnpm build:cloudflare
node --test --test-name-pattern='workerd auth routes' src/cloudflare/runtime.db.test.mjs
corepack pnpm check-types
corepack pnpm test
trunk check --no-fix src/app/auth.ts src/cloudflare/runtime.db.test.mjs
```

- 수정 전 회귀 테스트는 회원가입 503으로 실패했습니다.
- 수정 후 회귀 테스트 1개가 통과했습니다.
- 수정 코드만 되돌렸을 때 동일한 503으로 다시 실패했고, 복원 후 다시 통과했습니다.
- 최종 코드 기준 타입 검사와 단위 테스트 76개가 통과했습니다.
- 변경한 코드·테스트 파일의 Trunk 검사와 diff 공백 검사가 통과했습니다.
- `src/app`·`src/cloudflare`·`src/instagram`의 호출 경로를 확인했습니다.
  Cloudflare Graph transport에는 독립 함수 래퍼가 주입되므로 같은 수정이 필요하지 않았습니다.
- 로컬 diff 검토에서 추가 수정이 필요한 발견 사항은 없었습니다.

## 운영 배포와 확인 범위

수정 커밋 `b15b3d0`을 푸시하고 Worker 버전 `7bfd9b14-f325-486f-84d5-09b4c2c44d2b`로 배포했습니다.
기존 secrets를 유지했고 `SEND_ENABLED=false`로 배포했습니다.

| 운영 요청                        | 배포 후 결과                                 |
| -------------------------------- | -------------------------------------------- |
| 예약된 진단 주소로 잘못된 로그인 | 401 `authentication_failed`; 수정 전에는 503 |
| 회원가입에 빈 객체 전달          | 400 `invalid_credentials`                    |
| 로그인 없이 `/api/me` 조회       | 401 `login_required`                         |
| `/app/` 조회                     | 200                                          |

배포 직후에는 실제 이메일 주소의 회원가입과 인증 메일 수신을 검증하지 않았습니다.
이후 운영자가 `ydm2790@gmail.com`의 회원가입 완료를 보고했고, 운영 DB에서 해당 사용자의 `email_confirmed_at`과 `last_sign_in_at`을 확인했습니다.
이는 사용자 생성·이메일 인증·로그인 완료 상태를 확인한 결과이며 메일 수신 화면이나 확인 링크 복귀를 직접 관찰한 것은 아닙니다.
기존 관리자 스크립트로 해당 사용자를 기존 수신 작업 공간에 배정했고 COMMIT 후 소유권을 재조회했습니다.
소유권 배정 시점에는 Instagram OAuth 토큰이 없었습니다.
이후 운영자의 OAuth 연결과 저장된 토큰의 Meta 프로필·웹훅 구독 조회를 확인했으며 상세 결과는 [다중 사용자 배포 전환](2026-09-26-multi-user-cutover.md)에 기록합니다.
이 인증 수정 검증 당시 발송은 비활성화 상태였습니다.
이후 승인된 첫 실발송 테스트의 현재 상태는 [첫 실발송 테스트 기록](2026-09-26-first-live-reply-test.md)에 기록합니다.
DB 통합 테스트 전체는 실행하지 않았으며 이 수정에는 DB·마이그레이션 변경이 없습니다.

## Oracle 선례

개인 계정의 `auto-chatter` 조회에서 반환된 `wiki/concepts/authoring-time-vs-runtime-verification.md`는 정적 선언과 코드 검사만으로 실제 런타임 동작을 증명할 수 없다는 선례입니다.
이 선례를 반영해 Node 단위 테스트 외에 실제 workerd 회귀 테스트와 배포된 Worker HTTP 응답을 확인했습니다.
조회에서 반환된 provenance는 `c1681868ac634e4b2414874716bb75a7864113c4`이며 위키 원문의 최신성은 별도 확인하지 않았습니다.
프로젝트별 fetch 수신자 규칙은 `[no precedent found]`였습니다.
