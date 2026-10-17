# CSV 태그 사전 검사 구현 계획

## 승인과 범위

PR #215 화면 승인과 병합 후 다음 이슈 선정 및 pr-loop 계속 요청을 따릅니다.
[#25](https://github.com/AndrewDongminYoo/auto-chatter/issues/25)의 [읽기 전용 사전 검사](../specs/2026-10-17-contact-csv-preview.md)만 구현합니다.
실제 가져오기 적용과 운영 변경은 제외합니다.

## 순서와 성공 기준

1. 기존 CSV DB 테스트에 요청·권한·기존 연락처·무변경 사례를 추가합니다. → 검증: 새 API가 없는 404 실패를 확인합니다.
2. v1 파서와 실제 읽기 전용 집계, 기존 태그 정규화 재사용, API를 구현합니다. → 검증: 파서 경계·중복·권한·무변경 DB 테스트.
3. 관리자 파일 검사 화면과 결과 무효화를 구현합니다. → 검증: 실제 브라우저의 파일·지연 응답·초안 보존·모바일.
4. 관련 README·CLAUDE·CSV 명세·수용표와 검증 기록을 갱신합니다. → 검증: 구현 주장 대조와 변경 경로 Trunk.
5. 타입·단위·UTF-8 DB·제한된 workerd 역할 검사를 실행합니다. → 검증: 프로젝트의 선언된 전체 검사.
6. 독립 검토와 루트의 반례 확인 후 한 기능 커밋·PR·현재 head CI/코드/보안 리뷰를 진행합니다. → 검증: 최종 후보와 원격 증거 일치.
7. 보존된 화면 승인 자료를 제시하고 운영자 병합을 기다립니다.

## 파일과 제약

주요 구현은 `src/app/contact-csv-preview.ts`, `src/app/contacts.ts`, `src/app/api.ts`, `public/app/contact-csv-preview.js`, `public/app/app.js`, `public/app/index.html`입니다.
기존 CSV 단위/DB 테스트와 Worker 테스트에 회귀 사례를 추가하여 테스트 파일 목록이나 의존성을 바꾸지 않습니다.
새 DB 테이블·마이그레이션·파일 저장·발송 경로는 추가하지 않습니다.
