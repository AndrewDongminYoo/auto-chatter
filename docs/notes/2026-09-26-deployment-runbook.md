# 단일 서버 배포 운영 절차

운영 기본 경로는 [Cloudflare + Supabase](2026-09-26-cloudflare-runbook.md)로 변경했습니다.
이 문서는 로컬 검증과 단일 서버 대체 배포용으로 유지합니다.

## 구성

`compose.yaml`의 기본 서비스는 `db`와 `ingress`입니다.
`send` 프로필은 실제 발송을 하는 `worker`, `public` 프로필은 Caddy `proxy`를 추가합니다.
프로필 없이 다시 실행해도 이미 켜진 워커나 프록시는 중지되지 않으므로, 중지할 때는 해당 서비스를 명시합니다.
수신기는 호스트의 `127.0.0.1`에만 바인딩하고 DB 포트는 호스트에 공개하지 않습니다.
워커 프로세스 하나는 Instagram 연결 하나만 처리하며 이 구성은 Instagram Login 전용입니다.
운영 DB는 관리용 `postgres`와 읽기·쓰기 전용 `automations_app` 역할을 분리합니다.
앱 역할에는 조회·삽입·갱신만 허용하며, 삭제와 스키마 변경은 허용하지 않습니다.
DB는 내부 `data` 네트워크에만 연결하고, 프록시는 `edge` 네트워크에서 수신기에 접근합니다.
워커와 수신기는 두 네트워크에 연결하며 워커의 외부 Meta 호출은 `edge`를 사용합니다.

## 최초 준비와 로컬 수신 확인

Docker Engine과 Compose 플러그인이 있는 서버에서 저장소 루트를 작업 디렉터리로 사용합니다.
다음 명령은 템플릿을 처음 준비할 때만 실행합니다.

```bash
cp -n deploy/environment.example deploy/runtime.env
chmod 600 deploy/runtime.env
```

`deploy/runtime.env`에 서로 다른 `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`와 실제 앱의 `INSTAGRAM_APP_SECRET`, 직접 정한 `INSTAGRAM_VERIFY_TOKEN`을 입력합니다.
암호 생성에는 `openssl rand -hex 32`를 사용할 수 있습니다.
`APP_IMAGE_TAG`에는 배포할 커밋 SHA를 기록합니다.
배포용 체크아웃은 커밋되지 않은 변경이 없어야 하며, 다음 검사에서는 실제 `HEAD`를 이미지 태그로 내보내 파일의 값을 덮어씁니다.
배포할 릴리스가 다르면 먼저 깨끗한 배포용 체크아웃을 해당 커밋으로 이동한 뒤 실행합니다.
검사나 빌드가 실패하면 다음 기동 단계로 진행하지 않습니다.
파일은 Git과 이미지 빌드 컨텍스트에서 제외되며, 애플리케이션에 필요한 변수만 각 컨테이너에 전달합니다.
Docker 관리 권한이 있는 사용자는 컨테이너 환경 변수를 볼 수 있으므로 서버 접근 권한도 제한해야 합니다.
Compose는 지정한 환경 파일을 직접 읽으므로 셸에서 `source`할 필요가 없습니다.
동일한 이름의 셸 환경 변수가 파일보다 우선하므로, 기존 개발용 값을 내보낸 셸에서는 실행하지 않습니다.
값을 출력하는 `config` 대신 `config --quiet`로 구성을 검사합니다.

```bash
docker compose --env-file deploy/runtime.env config --quiet
DEPLOY_REPO="$(pwd -P)"
test "$(git -C "$DEPLOY_REPO" rev-parse --show-toplevel)" = "$DEPLOY_REPO" &&
  test -z "$(git -C "$DEPLOY_REPO" status --porcelain)" &&
  export APP_IMAGE_TAG="$(git -C "$DEPLOY_REPO" rev-parse HEAD)" &&
  docker compose --env-file deploy/runtime.env build ingress
docker compose --env-file deploy/runtime.env up -d --wait db ingress
docker compose --env-file deploy/runtime.env ps
curl -i http://127.0.0.1:3000/webhooks/instagram
```

마지막 요청은 검증 토큰이 없으므로 `403`이 정상입니다.
수신기 상태 검사는 이 HTTP 응답만 확인하며, 실제 Meta 권한이나 지속적인 DB 준비 상태를 입증하지 않습니다.
별도로 DB 상태, 서명된 이벤트의 저장 결과와 발송 실패 상태를 확인해야 합니다.
빈 DB 볼륨에서는 최신 `db/schema.sql`과 애플리케이션 역할을 자동 생성합니다.
기존 볼륨에는 초기화 스크립트가 다시 실행되지 않습니다.
환경 파일의 암호만 바꿔도 DB 역할의 암호가 바뀌지는 않으므로, 암호 교체는 DB 역할과 실행 환경에 함께 적용해야 합니다.
이 구성이 만들지 않은 기존 DB를 연결하는 작업은 역할·스키마 확인 후 별도 이관 절차로 처리합니다.

## 공개 HTTPS 연결

서버와 도메인을 확정한 뒤 DNS를 서버로 연결하고 TCP 80·443 접근을 허용합니다.
`WEBHOOK_DOMAIN`에 스킴이나 경로 없이 도메인 이름을 입력하고, 운영 포트는 기본값 80·443을 사용합니다.
Caddy는 도메인에 대한 인증서를 발급·갱신하고 HTTP를 HTTPS로 전환합니다.
인증서 상태는 `caddy_data` 볼륨에 보존합니다.
[Caddy의 자동 HTTPS 조건](https://caddyserver.com/docs/automatic-https)을 따릅니다.

외부 공개가 승인된 서버에서 실행합니다.

```bash
docker compose --env-file deploy/runtime.env --profile public up -d proxy
docker compose --env-file deploy/runtime.env logs --tail 50 proxy
```

Meta 콜백 URL은 `https://<도메인>/webhooks/instagram`입니다.
개발자 대시보드에서 같은 검증 토큰으로 구독 확인을 완료하고 실제 댓글 이벤트가 저장되는지 확인합니다.
공개 주소의 인증서·구독 확인·실제 이벤트 수신은 로컬 검사로 대신할 수 없습니다.

## 발송 활성화와 중지

먼저 DB에 작업 공간, 활성 Instagram 연결과 규칙을 등록하고 발송할 대상과 내용을 검토합니다.
`META_GRAPH_VERSION`, `META_INSTAGRAM_ACCOUNT_ID`, `META_INSTAGRAM_ACCESS_TOKEN`, `META_INSTAGRAM_CONNECTION_ID`를 입력합니다.
발송 전 읽기 전용 계정 확인을 실행합니다.

```bash
docker compose --env-file deploy/runtime.env --profile send run --rm --no-deps worker node src/instagram/worker-main.ts --check-permissions
```

이 명령의 성공은 계정 ID 일치만 확인합니다.
댓글 관리 권한과 실제 비공개 답장 발송 가능 여부는 별도로 확인합니다.
실제 발송이 승인된 뒤 아래 명령으로 워커를 켭니다.
기존 대기 작업도 처리하므로 활성화 전에 outbox를 점검합니다.

```bash
docker compose --env-file deploy/runtime.env --profile send up -d worker
docker compose --env-file deploy/runtime.env logs --tail 50 worker
```

발송 중지 명령은 다음과 같습니다.
최대 3분의 종료 유예 동안 이미 진행 중인 요청은 끝날 수 있습니다.
강제 종료되거나 응답이 불명확한 작업은 `unknown`으로 남고 자동 재발송되지 않습니다.

```bash
docker compose --env-file deploy/runtime.env --profile send stop worker
```

## 백업과 복원 연습

DB 백업에는 개인 데이터가 포함될 수 있으므로 접근을 제한하고, 서버 외부의 암호화된 저장소에도 복사합니다.
아래 명령은 수동 백업이며 주기적 실행과 외부 저장소·보존 기간은 운영 전에 정해야 합니다.

```bash
umask 077
mkdir -p backups
docker compose --env-file deploy/runtime.env exec -T db pg_dump -U postgres -d automations -Fc > "backups/automations-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

명령 종료 상태와 파일 크기를 확인하고, 다른 빈 DB에 실제로 복원해 읽을 수 있는지 확인합니다.
다음은 같은 PostgreSQL에 새로운 연습용 DB를 만드는 예시입니다.
기존 DB에 덮어쓰는 명령이 아니며 `automations_restore_check`가 이미 있으면 새 이름을 사용합니다.

```bash
docker compose --env-file deploy/runtime.env exec -T db createdb -U postgres automations_restore_check
docker compose --env-file deploy/runtime.env exec -T db pg_restore -U postgres -d automations_restore_check --exit-on-error < backups/<백업파일>.dump
docker compose --env-file deploy/runtime.env exec -T db psql -U postgres -d automations_restore_check -c 'SELECT status, count(*) FROM private_reply_outbox GROUP BY status;'
```

실제 장애 복구에서는 워커를 중지한 상태로 새 환경에 복원하고, 백업 이후 발송됐을 수 있는 대기 작업을 공급자 기록과 대조합니다.
오래된 백업을 복원한 뒤 바로 워커를 켜면 이미 발송한 요청을 다시 보낼 수 있습니다.
복원된 DB를 운영에 사용하기 전에, 아래 명령으로 미확정 작업을 수동 검토 상태로 격리합니다.
연습용 DB에서는 `-d automations`를 `-d automations_restore_check`로 바꿔 검증합니다.

```bash
docker compose --env-file deploy/runtime.env exec -T db psql -U postgres -d automations -v ON_ERROR_STOP=1 -c "UPDATE private_reply_outbox SET status = 'unknown', failure_code = 'restore_review_required' WHERE status IN ('pending', 'sending');"
```

`unknown`은 자동 재시도하지 않습니다.
공급자 메시지 ID나 발송 기록으로 전달 여부가 확인된 작업만 개별 정리하고, 확인할 수 없는 작업은 그대로 유지합니다.
발송되지 않았다는 근거가 있는 작업만 운영자 검토 후 별도로 재등록하며, 일괄 `pending` 전환은 하지 않습니다.
격리와 검토가 완료된 후에만 발송 재개를 승인합니다.

## 업데이트와 마이그레이션

먼저 현재 실행 중인 이미지 태그·ID와 워커 활성 여부를 릴리스 기록에 남기고 이전 이미지를 보관합니다.
새 이미지 빌드 전에 확인하며, 롤백 후보 이미지는 정리 명령으로 삭제하지 않습니다.

```bash
docker compose --env-file deploy/runtime.env images
docker inspect "$(docker compose --env-file deploy/runtime.env ps -q ingress)" --format '{{.Image}}'
docker compose --env-file deploy/runtime.env --profile send ps worker
```

롤백 대조에는 테이블에 표시되는 축약 ID 대신 `docker inspect`가 출력한 전체 `sha256:...` 값을 기록합니다.
워커가 실행 중이면 같은 방식으로 `--profile send ps -q worker`의 컨테이너 ID를 조회해 이미지 ID도 함께 기록합니다.

백업과 복원 확인 후 수신기와 워커를 중지하고, 새 코드에서 적용할 마이그레이션을 번호 순서대로 실행합니다.
현재 `001`과 `002`는 재실행 가능하며, 빈 볼륨의 최신 스키마에도 다시 적용할 수 있습니다.
자동 마이그레이션 원장은 아직 없으므로 릴리스 기록에 DB 식별자, SQL 파일명·Git SHA, 적용 시각과 종료 결과를 남깁니다.
이후 추가되는 마이그레이션은 해당 기록과 개별 릴리스 지침으로 적용 여부를 결정하며 재실행 가능하다고 가정하지 않습니다.
중지 기간에는 웹훅 수신이 불가능하므로 유지보수 시간을 정하고 이후 이벤트 수신을 확인합니다.
현재 마이그레이션의 실행 예시는 다음과 같습니다.

```bash
docker compose --env-file deploy/runtime.env --profile send stop worker ingress
docker compose --env-file deploy/runtime.env exec -T db psql -U postgres -d automations -v ON_ERROR_STOP=1 -f /migrations/001_reply_worker.sql
docker compose --env-file deploy/runtime.env exec -T db psql -U postgres -d automations -v ON_ERROR_STOP=1 -f /migrations/002_rate_limit_backoff.sql
```

마이그레이션 실패 시 기동하지 않고 원인을 해결합니다.
최초 준비의 체크아웃 검사·태그 설정·빌드 명령을 새 릴리스에서 다시 실행한 뒤 `up -d --wait ingress`로 수신기를 시작합니다.
실제 사용한 `APP_IMAGE_TAG`를 운영 환경 파일에도 기록해 다음 셸에서 같은 이미지를 선택하도록 합니다.
수신과 DB 상태를 확인한 뒤 승인된 발송 워커를 다시 시작합니다.
프록시가 수신기의 이전 주소를 사용해 일시적으로 실패하면 프록시도 재시작하고 공개 주소를 확인합니다.
코드 롤백은 호환 가능한 DB 스키마에서만 진행합니다.
워커를 먼저 중지하고, 기록해 둔 이전 태그와 이미지 ID가 일치하는지 확인한 뒤 수신기를 복원합니다.

```bash
docker compose --env-file deploy/runtime.env --profile send stop worker ingress
export APP_IMAGE_TAG='<이전-커밋-SHA>'
EXPECTED_IMAGE_ID='<릴리스-기록의-이미지-ID>'
test "$(docker image inspect "automations:$APP_IMAGE_TAG" --format '{{.Id}}')" = "$EXPECTED_IMAGE_ID" &&
  docker compose --env-file deploy/runtime.env up -d --wait --no-build --pull never ingress
```

이미지 ID가 릴리스 기록과 다르면 중단합니다.
이전 이미지로 수신과 outbox 상태를 확인하고, 롤백 전에도 발송이 승인되어 활성화돼 있었던 경우에만 아래 명령으로 워커를 이전 이미지로 다시 만듭니다.

```bash
docker compose --env-file deploy/runtime.env --profile send up -d --no-build --pull never worker
```

롤백 결과를 확인한 뒤 환경 파일에도 이전 태그를 기록합니다.
스키마 변경의 역방향 호환성은 자동 보장하지 않습니다.

## 종료와 검증 경계

전체 서비스를 중지하려면 두 프로필을 포함해 `down`을 실행합니다.
`down`은 명명된 DB·인증서 볼륨을 보존하지만 `down -v`는 삭제하므로 운영 환경에서는 사용하지 않습니다.

```bash
docker compose --env-file deploy/runtime.env --profile send --profile public down
```

이 구성은 단일 서버 기준이며 고가용성, 자동 외부 백업, 장애 알림, 여러 연결의 앱 전체 할당량 조정을 제공하지 않습니다.
컨테이너의 `restart` 정책은 프로세스 종료 시 적용되며 `unhealthy` 상태만으로 재시작되지는 않습니다.
[Compose 프로필](https://docs.docker.com/compose/how-tos/profiles/)과 [환경 변수 우선순위](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/)는 Docker 공식 문서를 기준으로 합니다.

### 로컬 검증 결과

2026-09-26에 실제 비밀값 대신 합성 자격 증명과 별도 `automations-deploy-review` Compose 프로젝트를 사용했습니다.
다음 결과는 로컬 컨테이너와 모의 이벤트에 대한 검증이며 공개 서버나 실제 Meta 발송을 검증한 결과가 아닙니다.

- 필수 변수를 제거하면 `config --quiet`가 실패하고, 합성 값을 넣으면 통과했습니다.
- 이미지 빌드 후 비관리자 실행과 개발 의존성·테스트 파일·추가 빌드 파일의 제외를 확인했습니다.
- 기본 실행에서 DB와 수신기만 기동했고, 잘못된 구독 토큰과 서명을 거부했습니다.
- 같은 서명된 모의 댓글을 두 번 보내도 DB에는 `pending` 작업 하나만 남았습니다.
- 앱 DB 역할의 테이블 생성과 삭제는 거부됐고, 이벤트 삽입은 성공했습니다.
- 기존 마이그레이션 적용과 컨테이너 재시작 후에도 작업을 보존했고, 백업을 별도 DB에 복원해 같은 행을 확인했습니다.
- 복원된 `pending`과 `sending` 행을 격리 SQL로 각각 `unknown`으로 바꿨습니다.
- 로컬 Caddy CA를 신뢰하는 HTTPS 클라이언트로 구독 확인을 통과했으며, 프록시에서는 `db:5432`로 연결할 수 없었습니다.
- Meta 설정을 비운 워커는 공급자 호출 전에 종료 코드 2로 실패했습니다.
- 잘못된 롤백 이미지 ID는 검사에서 실패하고, 기록한 실제 ID는 통과했습니다.
- `corepack pnpm test`의 단위 테스트 46개와 `TEST_DATABASE_URL=<local-test-db-url> corepack pnpm test:db`의 PostgreSQL 통합 테스트 36개가 통과했습니다.
- `corepack pnpm check-types` 타입 검사와 `sh -n deploy/init-app-user.sh` 구문 검사가 통과했습니다.

실제 Meta 워커의 지속 실행, 공인 인증서 발급·갱신, 서버 재부팅과 외부 백업 저장은 별도 운영 검증으로 남아 있습니다.
