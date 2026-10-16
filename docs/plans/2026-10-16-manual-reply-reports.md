# 수동 답장 현황 리포트 구현 계획

## 승인된 방향

다음 이슈를 선정해 pr-loop를 계속 진행하라는 요청에 따라 #50의 읽기 전용 첫 단계를 구현합니다.
계약은 [기능 명세](../specs/2026-10-16-manual-reply-reports.md)에 고정합니다.
병합과 운영 배포는 이번 실행에 위임되지 않았습니다.

## 순서와 성공 기준

1. `src/app/manual-reply-reports.db.test.ts`에서 API가 없어서 발생하는 기대 실패를 확인합니다.
   권한·격리·시간 경계·정확한 합계와 민감정보 배제를 실제 DB로 검사합니다.
2. `src/app/manual-reply-reports.ts`와 `src/app/api.ts`에 읽기 전용 조회를 구현하고 해당 테스트를 통과시킵니다.
3. `public/app/manual-reply-reports.js`, `app.js`, `index.html`, 필요한 `styles.css`에 기존 화면 관례를 따라 조회와 CSV를 추가합니다.
   브라우저에서 실제 입력·렌더링·내보내기·지연 응답 무효화를 확인합니다.
4. `package.json`의 명시적 DB 테스트 목록에 파일을 추가하고 CI와 같은 `corepack pnpm install --frozen-lockfile`로 lockfile 일치를 확인합니다.
5. `CLAUDE.md`, `README.md`, 기존 수용 기준표의 관련 주장만 갱신하고 검증 기록을 작성합니다.
   `AGENTS.md`는 CLAUDE 위임이 여전히 맞는지 확인합니다.
6. `corepack pnpm check-types`, `corepack pnpm test`, 격리 DB의 `corepack pnpm test:db`, `corepack pnpm test:cloudflare`와 변경 경로의 Trunk 검사를 수행합니다.
7. 최종 변경 규모에 맞는 독립 검토와 적대적 재검토 후 의미별 커밋, 푸시, PR 및 현재 커밋의 호스팅 리뷰·CI를 진행합니다.
8. 화면 자료를 보존하고 운영자의 시각 승인과 병합을 요청합니다.

## 제한

집계 테이블, 새로운 상태, 자동화 런 변경, 발송 경로 수정, 의존성 추가와 넓은 리팩터링은 하지 않습니다.
기존 원장과 한 SQL 문장을 사용하며 조회 결과는 현재 보존된 데이터에 한정됩니다.
로컬 검증은 운영 DB·Meta 전달·운영 적용을 증명하지 않습니다.
