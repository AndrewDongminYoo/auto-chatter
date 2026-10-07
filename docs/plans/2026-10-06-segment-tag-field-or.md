# 태그·단일 필드 AND/OR

## 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 AND/OR를 기존 태그와 단일 필드 두 조건에 적용합니다.
선행 Draft #158 위에 별도 PR로 쌓으며 기존 조회·저장 형식의 기본 AND를 유지합니다.
중첩·다중 필드, 동의·활동, 식별자 병합, 제외 사유 미리보기와 발송 대상 고정은 이 변경의 범위가 아닙니다.

## 실행과 검증

1. `settings.db.test.ts`에 AND/OR 진리표·격리·저장 재평가·검증·55명 페이지 사례를 추가하고 기존 구현의 실패를 관찰합니다.
2. `contacts.ts`의 검증과 고정된 parameterized SQL을 확장합니다. workspace·계정·커서를 OR 바깥에 유지하고 기존 결과 형태를 보존합니다.
3. 마이그레이션 037·현재 스키마·전체 실행기에 기본 AND 컬럼과 OR 필수 조건 제약을 추가합니다. 기존 필터 업그레이드·반복 적용을 실제 로컬 DB로 확인합니다.
4. 기존 workerd 사례에서 제한된 역할의 OR 저장·조회와 다른 workspace 거부를 확인합니다. 권한·RLS·DELETE 경계는 바꾸지 않습니다.
5. `public/app`에 결합 선택·복원·실패 초안 보존·조건 제거 시 AND 복귀를 연결합니다. 합성 사용자와 실제 로컬 API로 Chromium 데스크톱·390px 화면을 검토합니다.
6. 타입·단위·DB·workerd·전체 Trunk를 실행하고 한 번의 구조화된 로컬 diff 검토 후 별도 Draft PR을 게시합니다. hosted CI와 실제 리뷰 상태를 확인합니다.

## 적용 경계

원본 checkout과 이전 두 Draft의 scope를 유지합니다.
`SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지하며 운영 DB·배포·실제 계정·메시지 작업을 하지 않습니다.
운영자 시각 승인과 운영 마이그레이션은 별도이며 이 회차에서는 병합하지 않습니다.
Ralph 리뷰 횟수를 새 이슈마다 초기화하지 않으며 추가 중량 리뷰 에이전트를 사용하지 않습니다.
