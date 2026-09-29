# Instagram 공개 연결 검증 실행 계획

## 목표와 경계

[GitHub #14](https://github.com/AndrewDongminYoo/auto-chatter/issues/14)의 일반 사용자 연결과 Meta 권한 심사 준비를 진행합니다.
앱 게시 또는 테스트 준비 표시만으로 일반 사용자 권한을 추정하지 않습니다.
실제 메시지 발송, Meta 설정 변경, 심사 제출 및 공개 스위치 활성화는 각각 확인된 결과와 운영 승인을 거칩니다.

## 실행 순서

1. `src/app/api.ts`, `src/app/instagram-oauth.ts`, `src/app/api.test.ts`에서 기본 제한, 확인된 내부 계정 허용, 공개 스위치, 거부된 콜백 결과를 검사합니다.
   검증: 제한 경로의 403과 DB 미접근, 내부·공개 경로의 OAuth URL, 거부된 콜백의 제한된 303 안내를 각각 확인합니다.
2. `public/app/index.html`, `public/app/app.js`에서 연결 제한과 거부 사유를 보여줍니다.
   검증: 합성 사용자로 허용·제한 화면을 실제 브라우저에서 확인하고, 제한 상태의 버튼 비활성화와 안내를 검사합니다.
3. `.env.example`, `wrangler.json`, `docs/specs/2026-09-29-instagram-public-access.md`, `docs/notes/2026-09-29-instagram-app-review-status.md`, Cloudflare 운영 문서에 설정·심사 자료·운영 배포 상태를 기록합니다.
   검증: `corepack pnpm check-types`, `corepack pnpm test`, `git diff --check`와 문서 린트를 실행합니다.
4. Meta 대시보드에서 권한 등급과 심사 상태를 확인하고, 앱 역할이 없는 별도 전문 계정으로 연결·구독·실제 수신·허용된 답장·해제·팔로우 불명·중복·버튼 응답을 기록합니다.
   검증: 실제 계정과 운영 이벤트 식별자를 비밀값 없이 기록하며, 완료하지 못한 항목은 미검증으로 유지합니다.
5. 심사 영상과 설명을 실제 시연 결과에 맞게 확정하고 제출 여부를 결정합니다.
   검증: 제출 화면의 권한·영상·정책 URL을 최종 확인합니다.

1–3은 코드와 로컬 검증으로 진행할 수 있습니다.
4–5는 Meta 권한, 별도 계정, 실제 수신·발송 승인에 의존하므로 로컬 모의 테스트로 완료 처리하지 않습니다.
