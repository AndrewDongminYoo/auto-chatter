# 인증 쿠키 응답 순서 후속 검증

#244의 세션 세대 검사는 이전 보호 요청의 재전송을 막지만, 브라우저가 늦은 refresh 응답의 `Set-Cookie`를 적용하는 것까지 막지는 않습니다. 두 문서가 쿠키를 공유하고 더미 제공자가 A의 토큰을 계속 인정하는 조건에서, B 로그인 뒤 지연된 A refresh 응답을 전달하면 후속 `/api/me`의 사용자가 A로 돌아가는 현상을 재현했습니다.

## 수정 동작

- 로그인, refresh, 로그아웃, 비밀번호 재설정은 같은 출처의 `auto-chatter-auth-cookies` 배타 Web Lock을 사용합니다. 첫 호출과 재시도를 포함한 모든 보호 요청은 같은 이름의 공유 잠금을 사용해 보호 요청끼리의 동시 실행을 유지합니다. 브라우저가 응답 헤더를 적용할 때까지 잠금을 유지합니다.
- 로그인·로그아웃·비밀번호 재설정은 요청 전에 공유 저장소에 `pending` 표식을 게시하고 응답 후 `ready`로 전환합니다. 전환 중 시작한 요청도 이전 요청으로 취급합니다. 완료 표식 기록이 실패하면 `pending`이 남아 다른 문서의 refresh·재전송을 차단합니다. 요청 전 게시가 실패하면 쿠키 변경 요청을 보내지 않습니다.
- refresh와 모든 보호 요청은 잠금 획득 후 로컬 세대와 공유 표식을 다시 확인합니다. 보호 요청은 성공한 JSON·텍스트 본문을 읽은 후에도 다시 확인해 전환 전의 늦은 응답을 폐기합니다. 같은 세션의 정상적인 한 번 갱신·재시도는 유지합니다.
- Web Locks 미지원 환경은 자동 refresh를 보내지 않고 재로그인을 안내하며 명시적 로그인은 유지합니다. 잠금이 있는 환경에서 저장소 쓰기가 실패하면 저장소 허용 후 재로그인을 안내합니다.
- 자동 갱신으로 넘어가기 전 첫 401 응답 본문을 취소하여 소비되지 않은 응답을 남기지 않습니다. 취소를 쿠키 갱신 차단 수단으로 사용하지 않습니다.

## 회귀 검증

단위 회귀는 실제 API 래퍼를 두 문서 문맥에서 실행하고 결정적인 FIFO 잠금 대체물로 순서를 제어합니다. 실제 쿠키 적용과 Web Locks 동작은 별도 Chromium fixture로 확인합니다. `src/app/auth-session.test.ts`는 `pnpm test`의 명시적 파일 목록에 포함됩니다.

| 검사                                                    | 수정 전                                  | 수정 후                          |
| ------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| refresh가 보류된 동안 다른 문서의 로그인 대기           | 로그인 선완료로 순서 assertion 실패      | 실제 pending Web Lock 확인       |
| 정상 순서: refresh 완료 후 B 로그인                     | B 유지                                   | B 유지                           |
| 겹치는 순서의 후속 인증 사용자                          | 지연 응답으로 B→A                        | refresh 뒤 B 로그인 완료, B 유지 |
| 이전 보호 요청 재전송                                   | 기존 세대 검사로 차단되는 별도 증거 확보 | 수정된 경쟁 스케줄에서도 0회     |
| 로그인 뒤 대기 중인 이전 refresh                        | 전송됨                                   | 공유 표식 검사로 전송 전 거절    |
| 공유 저장소 읽기·쓰기 실패 및 로그인 문서만의 게시 실패 | 안전한 차단 없음                         | 전송 전 차단 또는 pending 유지   |

전체 단위 테스트 394개, 타입 검사, Cloudflare 번들 dry run과 변경 파일의 Trunk 검사가 통과했습니다. 초기 수정 커밋 `e033f5c`의 `app.js` SHA256은 `5915efc24e86eaa479c29a5142429c8ee343311d0b779e94b3d077d6c52f3e20`입니다.

독립 실행 `repair_independent_06`은 자식 종료 코드 0, refresh 응답 후 로그인 응답, B→B 유지, 원래 요청 재전송 0회와 페이지 오류 없음을 확인했습니다. 동일 fixture를 수정 전 소스에 실행한 `repair_independent_baseline_07`은 자식 종료 코드 1이며, refresh 보류 중 로그인이 완료돼 `Login must wait until the older refresh response settles` assertion에서 실패했습니다. 양쪽 manifest의 95개 파일이 일치했습니다. 중간 실행 `repair_fixed_03`과 `repair_repo_parent_04`는 복사 입력의 읽기 권한 누락에 따른 준비 실패이며 성공 근거에서 제외했습니다.

독립 보안 검토에서 발견한 공유 저장소 쓰기 실패 문제는 요청 전 pending 게시와 실패 시 전송 차단으로 보강했고, 최종 독립 검토에서 해결을 확인했습니다. 인계받은 감사 예산 16회 중 15회를 사용해 1회가 남았습니다. 호스팅 검토의 기존 사용 2/5회와 만료 기한 `2026-10-22T03:59:37.354448Z`는 변경하거나 새 라운드를 시작하지 않았습니다. 실제 제공자 호출, DB 접근, 고객 데이터, 발송 또는 배포 검증은 수행하지 않았습니다.

## 브라우저 fixture 실행

`scripts/auth-session-acceptance.mjs`는 `/target`, `/tools`, `/fixture`를 읽기 전용 입력으로 사용하는 전용 fixture입니다. Chromium 내부 샌드박스가 꺼져 있으므로 호스트에서 직접 실행하지 않습니다. 부모 실행기 `scripts/run-auth-session-acceptance.py`가 외부 네트워크 차단, UID 65534, 읽기 전용 파일 시스템, capabilities 제거, no-new-privileges, CPU 1개·메모리 768MiB·PID 128개, scratch 256MiB와 150초 제한을 적용합니다. 실행 중 fixture도 제한을 검사합니다. 비밀값, 홈 디렉터리, Docker 소켓, 운영 서비스는 target에 마운트하지 않습니다.

런타임과 의존성 준비는 target 실행 전에 별도로 끝냅니다. 다음은 AMD64에서 확인한 준비 예입니다. 검증할 커밋의 추적 파일만 `git archive`로 복사하여 로컬 자격증명과 미추적 파일을 제외합니다.

```sh
auth_validation_dir="$PWD/../auth-cookie-validation"
mkdir -p "$auth_validation_dir/target" "$auth_validation_dir/tools" "$auth_validation_dir/fixture"
git archive HEAD | tar -x -C "$auth_validation_dir/target"
docker pull --platform linux/amd64 mcr.microsoft.com/playwright:v1.64.0-noble
npm pack playwright-core@1.64.0 --ignore-scripts --pack-destination "$auth_validation_dir/tools"
tar -xzf "$auth_validation_dir/tools/playwright-core-1.64.0.tgz" -C "$auth_validation_dir/tools"
mv "$auth_validation_dir/tools/package" "$auth_validation_dir/tools/playwright-core"
docker image inspect mcr.microsoft.com/playwright:v1.64.0-noble
```

확인한 이미지 ID는 `sha256:847f71bbb3f17fc1032d50d75bf6fb3fdcf188b16dff81f24667fe9ae9409e01`, registry digest는 `sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`입니다. 아키텍처와 실제 내려받은 이미지 ID를 확인한 뒤 `tools/toolchain.json`에 `{"image_id":"sha256:..."}`를 기록합니다. 다른 아키텍처에서 이 ID를 재사용하지 않습니다.

다음으로 새 loopback TLS 파일과 소스 manifest를 만듭니다. 생성한 TLS 키를 Git·보고서에 포함하지 않습니다.

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$auth_validation_dir/fixture/key.pem" \
  -out "$auth_validation_dir/fixture/cert.pem" -days 1 -subj /CN=localhost
python3 - "$auth_validation_dir" "$(git rev-parse HEAD)" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
files = {str(p.relative_to(root / 'target')): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in sorted((root / 'target').rglob('*')) if p.is_file()}
(root / 'source-manifest.json').write_text(json.dumps({'head': sys.argv[2], 'files': files}, indent=2))
PY
chmod -R a+rX "$auth_validation_dir/target" "$auth_validation_dir/tools" "$auth_validation_dir/fixture"
python3 scripts/run-auth-session-acceptance.py \
  --validation-root "$auth_validation_dir" --mode fixed --run-id fixed_01
```

실행 후 생성한 TLS 파일을 삭제합니다.

`observations.json`의 `parent_execution.exit_code`와 각 assertion을 확인합니다. 부모 Python의 종료 코드 0만으로 성공을 뜻하지는 않습니다. `fixed`는 로그인 대기·최종 B 유지·재전송 0회를 요구합니다. `observe`는 영향 소스의 회귀 재현을 기대하는 진단으로, 안전한 결과의 게이트가 아닙니다. `negative`는 최종 B 유지를 요구하며 영향 소스에서 의도한 assertion으로 실패합니다. 같은 run ID의 결과를 덮어쓰지 않습니다.

인계 자료에 포함된 최초 `networkidle` 실패도 보존했습니다. 초기 `/api/me`가 미완료로 관측돼도 DOM·초기 화면 처리·refresh는 종료돼 있었으므로 fixture는 이 상태들을 명시적으로 기다립니다. 스크린샷은 진단용 한 장이며 별도 모바일 UI 검증으로 사용하지 않습니다.

## 보장 범위

이 수정은 새로운 클라이언트끼리 같은 출처의 Web Locks와 공유 저장소에 참여하는, 실행 중인 문서의 순서를 보호합니다. 오래된 자산을 유지한 탭, 참여하지 않는 직접 HTTP 클라이언트, 문서 종료로 잠금이 해제된 이후의 요청을 서버에서 세대 제어하는 변경은 아닙니다. 기존 탭은 다시 불러와야 합니다.

fixture는 실제 `appApi`·`AuthClient`와 대상 대시보드를 사용하며, 제공자만 주입 가능한 합성 응답으로 대체합니다. DB를 열면 실패하고 인증 외 표시 데이터도 합성입니다. 실제 Supabase 설정, 세션 실효·로테이션, 운영 악용 가능성, 캠페인 데이터 유출은 확인하지 않았습니다. 따라서 기존의 광범위한 감사 finding을 이 fixture만으로 운영 취약점 확정 또는 전면 해결로 처리하지 않습니다.

## PR #253 P1 리뷰 후속

리뷰 댓글 `4348124202`가 재시도 이전의 첫 보호 요청이 잠금을 우회하는 경로와 성공 응답의 세션 재검사 누락을 지적했습니다. 리뷰 대상 `e033f5c`에서 추가 단위 테스트가 첫 쓰기 전송과 늦은 성공 본문 반환을 재현했습니다. 첫 요청까지 공유 잠금과 전송 전 검사에 포함하고, 성공한 JSON·텍스트 본문을 읽은 뒤 세션을 다시 검사하도록 수정했습니다. 인증 전환은 배타 잠금이므로 보호 요청에 새 쿠키가 중간에 섞이지 않으며, 보호 요청끼리는 병렬 실행을 유지합니다.

중간 공유 잠금 수정 소스의 `app.js` SHA256은 `cc7f019d234001e15b7fb51804e60d958770a5f0634d326d804f1a2b97ee00e0`입니다. 전체 단위 테스트 396개, 타입 검사와 번들 dry run이 통과했습니다. Chromium fixture도 로그인 응답을 보류한 동안 첫 보호 쓰기의 HTTP 요청이 0회임을 확인했고, 두 보호 읽기가 동시에 공유 잠금을 점유하는 대조군을 통과했습니다. 기존의 최종 B 유지·이전 요청 재전송 0회 검사도 유지했습니다.

독립 최종 검증까지 인계받은 감사 예산 16회 중 16회를 모두 사용했습니다. 호스팅 리뷰 라운드나 만료 기한은 초기화하지 않습니다. 운영 제공자, 구버전 클라이언트와 문서 종료 이후의 범위 한계는 그대로입니다.

첫 요청의 공유 잠금 보강만으로도 충분하지 않은 추가 경계를 확인했습니다. B 로그인이 이미 완료됐으나 A 문서가 BroadcastChannel 알림을 받기 전이라면, 호출 때마다 최신 저장소 값을 읽는 API는 A의 이전 UI 입력을 B 세션으로 수용할 수 있습니다. 이를 문서가 수용한 `acceptedAuthRevision`과 비교하도록 수정했습니다. 성공한 로컬 로그인은 자신의 ready 표식만 수용하고, 다른 문서의 세션 변경은 전체 문서 다시 불러오기로만 수용합니다. 일반 `loadWorkspace()` 호출은 기준점을 갱신하지 않습니다.

최종 `app.js` SHA256은 `e490c32126f3e1c5ac76068a493a79d7ea4af19dabf5d90fd601a8367422296a`입니다. BroadcastChannel을 사용할 수 없는 A 문서에서 B의 로그인 완료 뒤에도 로컬 세대가 바뀌지 않은 상태로 첫 쓰기를 시도했으며, HTTP 요청 없이 거절됨을 확인했습니다. 이후 명시적 다시 불러오기가 문서를 교체하고 B의 역할을 수용하는 대조군도 통과했습니다. JSON·텍스트의 늦은 성공 본문 폐기와 세 종류 인증 전환의 첫 쓰기 차단을 함께 검사합니다.

동시 실행 도중 Docker VFS 디스크 부족으로 발생한 준비·결과 수집 실패는 통과로 집계하지 않았습니다. 실행 중인 컨테이너가 없는 상태에서 이미지·마운트 메타데이터가 참조하지 않는 이번 실패 실행의 임시 레이어만 정리하고, 격리 제한을 유지한 순차 재검증을 완료했습니다.

최종 전체 단위 테스트 399개, 타입 검사, Cloudflare 번들 dry run과 변경 파일의 Trunk 검사가 통과했습니다. 독립 실행 `review253_final_independent_07`은 자식 종료 코드 0으로 첫 쓰기 HTTP 0회, 알림 없는 완료 전환 뒤 쓰기 HTTP 0회, 공유 읽기 동시 실행, 명시적 문서 재로드와 기존 B 유지·재전송 0회를 확인했습니다. 리뷰 대상 소스 `e033f5c`에 같은 fixture를 실행한 `review253_final_baseline_08`은 `Initial protected write must not bypass the authentication transition lock`의 `1 !== 0` assertion에서 자식 종료 코드 1로 실패했습니다. 양쪽 manifest의 95개 파일은 모두 일치했습니다. 최종 독립 소스 검토에는 남은 차단 사항이 없었습니다.
