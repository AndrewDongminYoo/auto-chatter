# 최근 댓글 활동 구현 계획

## 승인과 범위

PR #214의 화면 확인·병합 후 다음 이슈 선정과 pr-loop를 계속하라는 요청을 따릅니다.
[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [상대 기간 명세](../specs/2026-10-16-segment-relative-activity.md)만 구현합니다.
병합·운영 DB·배포·발송은 별도 범위입니다.

## 순서와 성공 기준

1. 기존 settings DB 테스트에 상대 기간·저장·입력 실패 사례를 추가하고 미지원 조건 실패를 확인합니다.
2. contacts.ts의 파싱·집계·저장과 nullable 일수 제약을 구현하고 경계·미리보기·페이지·레거시 결과를 확인합니다.
3. schema·migration 053·전체 실행기를 함께 갱신하고 제한된 서버 역할의 workerd 경로를 검사합니다.
4. 기존 필터 화면의 최근 일수·복원·무효화와 미리보기 기준 시각을 구현하고 실제 브라우저로 확인합니다.
5. README·CLAUDE·기존 기간/세그먼트 명세·수용표·검증 기록을 같은 PR에서 갱신합니다.
6. `corepack pnpm check-types`, `corepack pnpm test`, UTF-8 격리 DB의 `corepack pnpm test:db`와 `corepack pnpm test:cloudflare`, 변경 경로 Trunk를 실행합니다.
7. 범위에 맞는 독립 검토와 루트 점검 후 의미별 커밋·푸시·PR·현재 커밋 CI 및 코드/보안 리뷰를 마칩니다.
8. 보존된 실제 화면 자료의 운영자 승인을 요청하고 merge commit 병합을 기다립니다.

## 구현 제한

의존성·범용 상대 시간 표현식·달력 일자 선택·DM 활동·캠페인 대상 고정은 추가하지 않습니다.
메인 작업 공간을 사용하며 기존 파일의 관련 경로만 수정합니다.
