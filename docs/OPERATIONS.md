# 운영자 안내서 (Operations Guide)

이 문서는 codesh 서비스의 설치, 구성, 운영, 백업 및 모니터링을 담당하는 시스템 관리자를 위한 안내서입니다. 세부 명령어 목록과 빌드 구성은 [deploy/README.md](../deploy/README.md)를 함께 참고하십시오.

---

## 1. 시스템 요구사항

- **운영체제**: Linux (Docker Compose 지원 환경 권장)
- **런타임 의존성**: Docker Engine 및 Docker Compose 플러그인(`docker compose`)
- **하드웨어 권장 사양**:
  - 최소: 2 vCPU, 4GB RAM
  - 권장: 4 vCPU, 8GB RAM (부하 테스트에 쓴 사양). 사용자 규모별 사양은 11.5를 참고하십시오.
  - 디스크: 최소 20GB 이상 (MongoDB 데이터 볼륨 및 Docker 이미지 보관)
- **네트워크**:
  - 외부 인터넷 연결 없이 오프라인 환경에서 단독 구동할 수 있습니다.
  - 런타임 중 외부 CDN, 웹 폰트, 분석 스크립트, 외부 API 호출이 발생하지 않습니다. 유일한 예외는 운영자가 끌 수 있는 업데이트 확인(15장)으로, 12시간마다 GitHub API에 GET 요청 하나를 보내고 인터넷이 없으면 조용히 실패합니다. `UPDATE_CHECK=off`이면 아무 요청도 보내지 않습니다.
  - 외부 노출 포트: Caddy 에지 프록시의 HTTP(80) 및 HTTPS(443) 포트만 외부에 공개됩니다.

---

## 2. 오프라인 번들 설치

인터넷 연결이 불가능한 폐쇄망 서버에는 사전 패키징된 오프라인 번들(`.tar.gz`)을 통해 배포합니다.

### 2.1 번들 생성 (인터넷 가능 빌드 머신)
Docker와 인터넷이 연결된 환경(또는 개발 박스)에서 번들 스크립트를 실행합니다.
```sh
deploy/bundle.sh [버전]
```
- 실행 결과로 `deploy/dist/codesh-<버전>.tar.gz`, 이미지가 없는 온라인 업데이트용 `codesh-deploy-<버전>.tar.gz`와 각각의 SHA256 체크섬 파일이 생성됩니다.
- 직접 만들 필요 없이 [GitHub 릴리스](https://github.com/kim0040/codesh/releases)에서 `codesh-<버전>-linux-amd64.tar.gz`(또는 `-linux-arm64`)와 `.sha256` 파일을 받아도 됩니다. 릴리스 파일은 GitHub Actions가 만들고 빌드 출처 증명(attestation)이 붙습니다(15.8).
- 번들 아카이브 내부에는 모든 컨테이너 이미지(`images.tar`), 설정 예시(`.env.example`), 배포 파일(`docker-compose.yml`), 관리 스크립트(`install.sh`, `backup.sh`, `restore.sh`, `upgrade.sh` 등)가 포함됩니다.

### 2.2 폐쇄망 설치 절차
생성된 번들과 `.sha256` 파일을 대상 서버로 복사하고, 체크섬을 확인한 다음 압축을 풀고 설치 스크립트를 실행합니다. 체크섬 값은 번들과 다른 신뢰할 수 있는 경로(예: 직접 전달한 메모)로 대조하십시오.
```sh
sha256sum -c codesh-<버전>.tar.gz.sha256
tar xzf codesh-<버전>.tar.gz
cd codesh-<버전>
PUBLIC_URL=http://codesh.corp ./install.sh
```
`install.sh` 스크립트는 다음 작업을 순차적으로 수행합니다.
1. 번들 안의 `SHA256SUMS`로 모든 파일을 검사하고, 맞지 않으면 아무것도 하지 않고 중단.
1. `images.tar`로부터 Docker 이미지를 로컬에 로드(`docker load`).
2. `.env` 파일이 없으면 `.env.example`을 복사하고 전달받은 환경 변수(`PUBLIC_URL`, `HTTP_PORT` 등)를 반영.
3. `generate-secrets.sh`를 실행하여 32자 이상의 무작위 암호화 비밀키 자동 생성.
4. `docker compose up -d --wait`로 전체 스택 실행 및 `/healthz` 헬스체크 통과 대기 (최대 120초). 시작할 때마다 일회성 서비스 `mongo-users`가 앱 전용 MongoDB 사용자 `codesh_app`을 만들거나 비밀번호와 역할을 다시 맞춥니다.

---

## 3. 환경 변수 (.env) 설정

`deploy/.env.example`에 정의된 모든 환경 변수의 용도와 기본값입니다.

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `CODESH_VERSION` | `1.0.0` | 실행할 codesh 릴리스(이미지 태그). `install.sh`, `upgrade.sh`, `update.sh`가 맞춰 줍니다. |
| `CODESH_REGISTRY` | `ghcr.io/kim0040` | `docker compose pull`이 이미지를 받는 곳입니다. 공개 GitHub 패키지 또는 직접 운영하는 미러를 지정합니다. 오프라인 번들은 번들의 값으로 맞춥니다. |
| `UPDATE_CHECK` | `on` | 새 릴리스 확인(15장). `off`이면 외부로 아무 요청도 보내지 않습니다. |
| `UPDATE_REPO` | `kim0040/codesh` | 릴리스를 확인할 GitHub 저장소(`소유자/이름`)입니다. |
| `UPDATE_CHANNEL` | `stable` | `prerelease`로 바꾸면 릴리스 후보(`1.2.0-rc.1` 등)도 알려 줍니다. |
| `HTTPS_PROXY` / `NO_PROXY` | 주석 처리됨 | 업데이트 확인이 거칠 HTTPS 프록시와 거치지 않을 호스트입니다(15.9). |
| `HTTP_PORT` | `80` | Caddy 컨테이너가 호스트에 바인딩할 HTTP 포트입니다. |
| `HTTPS_PORT` | `443` | Caddy 컨테이너가 호스트에 바인딩할 HTTPS 포트입니다. |
| `SITE_ADDRESS` | `:80` | Caddy가 응답할 주소입니다. `:80`은 모든 IP/도메인의 일반 HTTP 요청을 처리합니다. 도메인(예: `codesh.corp`)을 지정하면 HTTPS가 활성화됩니다. |
| `PUBLIC_URL` | 비어 있음 | 사용자가 브라우저 주소창에 입력하는 기준 URL(예: `https://codesh.corp`, 끝 슬래시 제외)입니다. 세션 쿠키의 Secure 플래그, OIDC 콜백 주소, CSRF 원본 검증에 사용됩니다. 일반 HTTP IP 접근 시 비워둘 수 있습니다. |
| `NETWORK_SUBNET` | `172.29.88.0/24` | Compose 내부 브리지 네트워크 서브넷입니다. 호스트 내부 사설망과 대역이 충돌하는 경우에만 변경합니다. |
| `TRUST_PROXY` | `NETWORK_SUBNET`과 동일 | API 앞단에 위치한 리버스 프록시(Caddy)의 CIDR 대역입니다. Caddy가 실행되는 네트워크 대역을 신뢰하여 `X-Forwarded-For` 헤더로부터 실제 클라이언트 IP를 추출합니다. 비워두면 모든 사용자가 동일 IP로 인식되어 레이트 리밋을 공유하게 됩니다. |
| `CADDY_TRUSTED_PROXIES` | `127.0.0.1/32` | Caddy 앞단에 별도의 로드밸런서가 있을 때, 해당 프록시의 `X-Forwarded-For` 헤더를 신뢰하기 위한 CIDR 대역입니다. |
| `SESSION_SECRET` | 자동 생성 | `codesh_sid` 쿠키 서명에 사용하는 최소 32자의 비밀키입니다. |
| `COLLAB_SECRET` | 자동 생성 | API 서버와 Collab 서버가 협업 세션 토큰(HMAC-SHA256)을 검증할 때 공유하는 최소 32자의 비밀키입니다. |
| `ADMIN_TOKEN` | 비어 있음 | `/api/admin/*` 및 관리 콘솔 접근에 사용하는 Bearer 토큰입니다. 비워두면 관리자 기능이 비활성화됩니다. |
| `MONGO_PASSWORD` | 자동 생성 | MongoDB root 사용자 `codesh`의 비밀번호입니다. `mongo-users`, `backup.sh`, `restore.sh`만 사용하고 API와 Collab은 사용하지 않습니다. 최초 컨테이너 구동 시 볼륨을 시딩하는 데 사용되며, 이후 변경은 `mongosh`로 수행해야 합니다. |
| `MONGO_APP_PASSWORD` | 자동 생성 | API와 Collab이 접속하는 `codesh_app` 사용자(`codesh` DB의 `readWrite`만 보유)의 비밀번호입니다. `mongo-users`가 시작할 때마다 이 값으로 맞추므로, 바꾼 뒤 `docker compose up -d`만 하면 됩니다. |
| `VALKEY_PASSWORD` | 자동 생성 | Valkey 서버 접근 비밀번호(`requirepass`)입니다. |
| `COLLAB_REPLICAS` | `1` | Collab(실시간 협업 편집) 인스턴스 복제본 수입니다. |
| `MONGO_CACHE_GB` | `2` | MongoDB의 WiredTiger 캐시 메모리 크기(GB)입니다. |
| `VALKEY_MAXMEMORY` | `1gb` | Valkey의 최대 메모리 사용량 한도입니다. 참여 코드, 접속자 상태, 승인·차단과 보안 카운터를 보관하므로 메모리 초과 시 키를 임의 삭제하지 않는 `noeviction` 정책을 사용합니다(14장). |
| `RATE_LIMIT_API_PER_MIN` | `1200` | 클라이언트 주소당 분당 허용되는 일반 API 요청 횟수입니다. 모든 `RATE_LIMIT_*`는 주소별로 세고, IPv6는 /64 전체에도 16배 한도의 카운터가 따로 있습니다. |
| `RATE_LIMIT_CODE_PER_MIN` | `30` | 클라이언트 IP당 분당 허용되는 참여 코드 확인 요청 횟수입니다. |
| `RATE_LIMIT_CREATE_PER_MIN` | `60` | 클라이언트 IP당 분당 허용되는 공유 생성 요청 횟수입니다. |
| `RATE_LIMIT_LOGIN_PER_MIN` | `10` | 클라이언트 IP당 분당 허용되는 인증/로그인 시도 횟수입니다. |
| `COMPOSE_PROFILES` | 주석 처리됨 | `mdns`로 지정하면 로컬 네트워크용 mDNS 사이드카 컨테이너가 함께 실행됩니다. |
| `MDNS_HOSTNAME` | `codesh.local` | mDNS를 통해 로컬 네트워크에 알릴 도메인 이름입니다. |
| `MDNS_IP` | 비어 있음 | 호스트에 여러 네트워크 카드가 있을 때 mDNS로 응답할 특정 IP 주소입니다. 비워두면 비루프백 IPv4 전체를 공지합니다. |

---

## 4. HTTPS 및 TLS 구성

도메인 기반 HTTPS를 구성하려면 `SITE_ADDRESS`를 도메인으로 설정하고 `deploy/tls/` 디렉터리에 `.caddy` 파일을 추가합니다.

### 4.1 자체 인증서 적용
인증기관(CA)에서 발급받은 인증서와 키를 사용하는 경우:
1. 인증서 파일(`codesh.crt`)과 비밀키(`codesh.key`)를 `deploy/tls/`에 배치합니다.
2. `deploy/tls/tls.caddy` 파일을 생성하고 다음 내용을 작성합니다.
   ```caddy
   tls /etc/caddy/tls/codesh.crt /etc/caddy/tls/codesh.key
   ```
3. `.env` 파일에서 `SITE_ADDRESS=codesh.corp` 및 `PUBLIC_URL=https://codesh.corp`로 변경 후 컨테이너를 재시작합니다.

### 4.2 Caddy 내장 로컬 CA 사용
인터넷 없이 HTTPS를 제공하려면 Caddy 내장 CA를 사용합니다.
1. `cp tls/internal.caddy.example tls/local.caddy`로 설정을 복사합니다(`tls internal`과 HTTPS 전용 HSTS).
2. `.env`에 `SITE_ADDRESS=codesh.local`, `PUBLIC_URL=https://codesh.local`을 지정하고 `docker compose up -d caddy api`로 재시작합니다.
3. 루트 인증서만(`root.crt`, 비밀키 `root.key`는 절대 배포하지 않음) 추출하여 지문을 확인한 뒤 모든 클라이언트 기기에 신뢰할 수 있는 루트 인증서로 등록합니다.

인증서 추출·지문 확인·운영체제별 등록 절차는 [TLS 안내](../deploy/tls/README.md)에 있습니다. CA 비밀키가 있는 `caddy-data` 볼륨은 보호하고 백업하십시오.

---

## 5. mDNS (codesh.local) 옵션

DNS 서버가 없는 독립 네트워크 환경에서 `http://codesh.local`로 접속할 수 있도록 mDNS 브로드캐스트 사이드카를 지원합니다.
- `.env`에서 `COMPOSE_PROFILES=mdns` 주석을 해제합니다.
- 사이드카 컨테이너는 호스트 네트워크 모드(`network_mode: host`)로 동작하므로 Linux 호스트 환경에서만 지원됩니다.
- 여러 IP가 할당된 서버에서는 `MDNS_IP`에 광고할 IP를 직접 지정할 수 있습니다.

---

## 6. Collab 인스턴스 수평 확장 (Scaling)

실시간 동시 접속자가 많을 경우 Collab 편집 서버 인스턴스를 늘려 트래픽을 분산할 수 있습니다.
```sh
docker compose up -d --scale collab=3
```
또는 `.env`에서 `COLLAB_REPLICAS=3`으로 설정합니다.

- **문서 라우팅**: Caddy 에지 프록시가 `lb_policy query doc` 규칙을 통해 동일한 문서(`doc=<id>`)에 대한 웹소켓 접속을 동일한 Collab 인스턴스로 자동 집중시킵니다.
- **인스턴스 간 동기화**: 서로 다른 인스턴스 간 통신은 Valkey Pub/Sub 채널(`perm:<shareId>`, `cmd:<shareId>`) 및 분산 문서 락(`doclock:<id>`), `@hocuspocus/extension-redis` 확장을 통해 실시간으로 처리됩니다.
- **장애 격리**: 개별 Collab 복제본이 비정상 종료되거나 `/healthz` 응답에 실패하면 Caddy가 5초 간격의 상태 점검에서 이를 감지해 해당 복제본으로 새 연결을 보내지 않습니다.

---

## 7. 프록시 및 네트워크 그룹 구성

### 7.1 TRUST_PROXY 및 IP 추출
- API 서버는 직접 연결된 피어가 `TRUST_PROXY` CIDR 대역에 포함된 경우에만 `X-Forwarded-For` 헤더를 신뢰합니다.
- 헤더를 오른쪽(직전 홉)부터 역방향으로 탐색하여 신뢰할 수 없는 최초의 클라이언트 주소를 식별하므로, 헤더 스푸핑이 불가능합니다.
- 리버스 프록시 뒤에서 `TRUST_PROXY`가 비어 있으면 경고 로그가 기록되며, 모든 사용자가 단일 프록시 IP로 집계되어 레이트 리밋과 PIN 실패 한도를 공유하는 문제가 발생합니다.

### 7.2 CSRF 방어 (X-Codesh)
- 브라우저 기반 CSRF 공격을 방지하기 위해, `/api/` 하위의 모든 변경 요청(POST, PATCH, DELETE 등)은 **`X-Codesh: 1`** 헤더를 반드시 포함하거나 앱 자체 Origin과 일치해야 합니다. 누락 시 403 `forbidden` 에러가 반환됩니다.
- 관리자 API(`/api/admin/*`)는 Bearer 토큰으로 인증되므로 이 검사에서 제외됩니다.

### 7.3 네트워크 그룹과 방 (Rooms)
사용자의 소속 네트워크 그룹(`net`)은 다음 우선순위로 결정됩니다.
1. **방 (Rooms)**: 관리자가 설정에서 정의한 CIDR 대역 목록(`settings.rooms`) 중 클라이언트 IP가 일치하는 방이 있으면 해당 방 이름을 그룹으로 사용합니다.
2. **서브넷**: 방에 일치하지 않으면 클라이언트의 IPv4 `/24` 대역(`settings.subnetPrefixV4` 기준) 또는 IPv6 `/64` 대역이 기본 네트워크 그룹이 됩니다.
- **근처 공유** 탐색 및 **방 전체에 띄우기** 기능은 동일한 네트워크 그룹에 속한 사용자 사이에서만 동작합니다.

---

## 8. 관리 콘솔과 설정 (§10)

### 8.1 관리 콘솔 접속
- `.env`에 `ADMIN_TOKEN`을 지정하고 스택을 실행합니다.
- 브라우저에서 `/admin`으로 이동한 후 관리자 토큰을 입력하여 로그인합니다.
- 토큰은 브라우저 세션 스토리지에 보관되며, 올바른 토큰을 사용한 요청은 로그인 속도 제한 슬롯을 소모하지 않습니다.

### 8.2 관리자 설정 항목 (MongoDB `settings` 컬렉션)

관리 콘솔의 **설정** 탭에서 실시간으로 수정할 수 있습니다.

- **공유 보관 시간 (`anonymousTtlHours`, 기본값: 24)**: 저장하지 않은 공유가 마지막 활동 후 만료되기까지의 시간(시간 단위)입니다.
- **이력 보관 기간 (`historyRetentionDays`, 기본값: 7)**: 소유자가 볼 수 있는 버전별 편집 이력 보관 일수입니다.
- **공유 최대 크기 (`maxDocBytes`, 기본값: 5MB, 최대 12MB)**: 단일 공유 문서의 최대 텍스트 용량입니다. MongoDB 문서 16MB BSON 한도를 보호합니다.
- **업로드 최대 크기 (`maxUploadMB`, 기본값: 200MB)**: 파일이나 `.zip` 업로드 시 1회당 허용되는 최대 용량입니다.
- **게스트 허용 (`guestAllowed`, 기본값: true)**: 로그인 없이 익명으로 공유를 생성하고 참여할 수 있는지 여부입니다.
- **방 (`rooms`, 기본값: `[]`)**: 방 이름과 CIDR 목록을 등록하여 회의실이나 강의실 단위로 네트워크 그룹을 분리합니다.
- **근처 공유 네트워크 범위 (`subnetPrefixV4`, 기본값: 24)**: 방에 속하지 않은 사용자를 묶을 IPv4 서브넷 마스크 길이입니다.
- **새 공유를 근처 공유에 표시 (`nearbyDefault`, 기본값: true)**: 신규 생성 공유의 기본 근처 공개 여부입니다.
- **감사 로그 기록 (`audit.enabled`, 기본값: false)**: 공유 생성, 열람, 다운로드, 삭제 활동을 기록할지 여부입니다.
- **감사 로그 보관 기간 (`audit.retentionDays`, 기본값: 90)**: 감사 로그 보관 일수입니다.
- **비밀 정보 경고 (`secretWarning`, 기본값: true)**: API 키나 비밀번호 패턴의 텍스트가 입력될 때 경고 표시 여부입니다.
- **OIDC / LDAP 로그인 (`auth.oidc`, `auth.ldap`, 기본값: null)**: 조직에서 사용하는 인증 제공자 연동 설정입니다.
- **바닥글 연락처 (`contact`, 기본값: "")**: 소개 페이지 하단에 노출될 IT 지원 부서 이메일 또는 연락처입니다.
- **코드 템플릿 (`templates`, 기본값: `[]`)**: 새 공유를 만들 때 고를 수 있는 조직 전용 시작 파일입니다. 관리 콘솔 **설정** 탭의 **코드 템플릿**에서 추가·수정·삭제하며(삭제 전 확인), 저장하면 바로 템플릿 선택 창에 **우리 조직** 그룹으로 나타납니다.
  - 최대 50개, 템플릿마다 `{id, name(60자), language, description(200자), files}`. `id`는 서로 달라야 하고 `builtin-`으로 시작할 수 없습니다(기본 제공 템플릿과 충돌 방지). 관리 콘솔은 새 템플릿에 `org-…` id를 부여합니다.
  - 파일은 상대 경로(`..`, 절대 경로 불가)로 중복 없이 지정하며, 한 템플릿의 파일 전체 크기는 `maxDocBytes` 이하여야 합니다. 서버(`PUT /api/admin/settings`)와 관리 콘솔이 같은 검사를 하므로, `maxDocBytes`를 줄일 때 기존 템플릿이 한도를 넘으면 저장이 거부되고 해당 템플릿에 경고가 표시됩니다.
  - 기본 제공 템플릿 16종은 코드에 포함되어 있어 설정과 무관하게 항상 나타납니다. 이름과 설명은 번역 키로 저장되므로 한국어/영어 화면에서 각각 표시됩니다.
- **공개 설정 노출**: `anonymousTtlHours`, `historyRetentionDays`, `contact`는 로그인 없이 `GET /api/settings/public`으로 읽을 수 있으며, 소개 페이지·이력 화면·공유 만료 안내의 문구가 이 값을 따릅니다. 비밀 값(인증 설정, 방 CIDR 등)은 포함되지 않습니다.

폴더와 태그는 MongoDB `share_labels` 컬렉션에 사람(`clientId`)별로 저장되며(관리 콘솔 설정 없음), 공유가 삭제·만료될 때 collab의 정리 작업(sweeper)이 남은 항목을 지웁니다.

---

## 9. 백업, 복원 및 업그레이드

### 9.1 데이터베이스 백업
```sh
./backup.sh [저장디렉터리]
```
- 기본 저장 디렉터리는 `./backups`입니다.
- 실행 중인 MongoDB 컨테이너 내부에서 `mongodump`를 실행하여 `codesh-<타임스탬프>.archive.gz` 아카이브 파일로 백업합니다.
- 백업 파일은 `0600`, 새로 만드는 백업 디렉터리는 `0700`으로 생성됩니다. root 비밀번호는 컨테이너 안의 임시 설정 파일로만 전달되고 명령행 인자에 나타나지 않습니다.
- Valkey(참여 코드, 접속자 상태, 승인·차단, 카운터)는 백업 대상에서 제외됩니다. 볼륨을 유지하고 운영 중 flush하지 마십시오.

### 9.2 백업 복원
```sh
./restore.sh backups/codesh-<타임스탬프>.archive.gz [--yes]
```
- Collab 및 API 컨테이너를 일시 정지하여 진행 중인 쓰기 작업을 안전하게 플러시합니다.
- `mongorestore --drop`을 사용하여 기존 데이터베이스를 백업 데이터로 대체한 후 서비스를 다시 시작합니다.

### 9.3 새 버전으로 업그레이드
인터넷이 되는 서버는 `./update.sh`로 업데이트합니다(15.4). 인터넷이 없는 서버는 새 번들로 업그레이드합니다.
```sh
./upgrade.sh ../codesh-<새버전>.tar.gz
```
- 번들 옆에 `.sha256` 파일이 있어야 합니다. 압축을 풀기 전에 아카이브 체크섬을, 이미지를 로드하기 전에 번들 안의 `SHA256SUMS`를 검사하며, 하나라도 다르면 백업·이미지 로드·파일 교체 없이 중단합니다.
- 기존 데이터베이스를 자동으로 사전 백업합니다.
- 새 번들의 컨테이너 이미지를 로드하고 관리 스크립트와 Compose 설정을 갱신합니다.
- 기존 `.env` 설정을 그대로 유지하면서 신규 추가된 환경 변수 키가 있을 경우 기본값을 보충합니다.
- 컨테이너를 롤링 재시작하고 헬스체크 정상 완료를 검증합니다.

---

## 10. 모니터링 및 메트릭

### 10.1 상태 점검 엔드포인트
- `GET /healthz`: Caddy 및 API 서버의 기본 동작 여부 확인 (Valkey ping 응답 검증).
- `GET /readyz`: API 서버가 Valkey와 MongoDB를 모두 읽을 수 있는지 확인합니다. Caddy를 거쳐 응답하며 `update.sh`가 새 버전을 확인할 때 사용합니다. Collab 서버에도 같은 경로가 있지만 Caddy를 거치지 않으므로 collab 컨테이너의 3002 포트에서 확인합니다(Compose 헬스체크가 사용).

### 10.2 프로메테우스 메트릭 수집
Caddy는 보안을 위해 루프백과 전용 Compose 서브넷의 요청에 대해서만 메트릭 경로를 개방합니다.
- `GET /metrics/api`: API 서버의 HTTP 요청 처리량, 지연 시간, Fastify 및 프로세스 상태.
- `GET /metrics/collab`: Collab 서버의 Hocuspocus 활성 연결 수(`hocuspocus_connections_count`), 활성 문서 수(`hocuspocus_documents_count`), 이벤트 루프 상태.
- Collab 인스턴스가 여러 개인 경우 Caddy를 통한 `/metrics/collab`은 복제본 중 하나로부터 응답하므로, 인스턴스별 메트릭이 필요한 경우 컨테이너 포트(3002)로 직접 스크랩하십시오.

---

## 11. 용량 목표와 부하 테스트 (Capacity)

### 11.1 목표

기준은 한 공유에 50명이 모인 수업(10명이 초당 5자씩 입력하고 50명 모두 커서를 움직임)과, 실습 모드에서 학생 50명을 한 화면으로 지켜보는 교사입니다. 아래 목표를 넉넉히 지키는 것이 합격선입니다.

| 항목 | 목표 |
|---|---|
| 원격 편집 지연 (한 사람이 입력 → 다른 사람의 문서에 반영, 종단 간) | p95 < 100 ms, p99 < 250 ms |
| 편집 유실·중복 | 0건, 모든 복제본이 같은 내용으로 수렴 |
| 원격 커서 | 묶어서 보내도 100 ms 안에 최신 위치 (p95 ≤ 100 ms) |
| 재접속 폭주 | 50명이 한꺼번에 끊겨도 5초 안에 모두 다시 동기화, 오류·유실 없음 |
| 브라우저 (원격 커서 49개가 움직이는 공유) | 50 ms를 넘는 긴 작업 없음, 입력 → 화면 p95 < 50 ms, 60 fps 유지 |
| 실습 교사 화면 (학생 50명이 입력 중) | 50 ms를 넘는 긴 작업 없음, 60 fps 유지 |
| 서버 자원, 한 공유 50명 | collab ≤ 0.5코어·512 MiB, api ≤ 0.25코어·256 MiB, MongoDB ≤ 0.5코어·1 GiB, Valkey ≤ 0.1코어·64 MiB |
| 서버 자원, 동시 사용자 약 200명 | collab ≤ 1코어·1 GiB, api ≤ 0.5코어·512 MiB, MongoDB ≤ 1코어·2 GiB, Valkey ≤ 0.25코어·128 MiB |

자원 예산은 실측 평균의 두 배 이상이 되도록 잡았습니다(11.4). Node 프로세스(collab, api)는 하나가 코어 하나까지만 쓰므로, collab이 1코어에 가까워지면 복제본을 늘립니다(6장, 11.6).

### 11.2 시나리오와 실행 방법

`scripts/load`는 실제 클라이언트와 같은 프로토콜(API로 세션·토큰 발급, Hocuspocus 웹소켓, Yjs, awareness)로 접속하는 가상 사용자를 워커 스레드 여러 개에서 돌립니다. 이름 있는 시나리오는 다음과 같습니다.

| 시나리오 | 내용 |
|---|---|
| `single-share-50` | 공유 1개: 작성자 10명(초당 5자, 입력마다 커서 이동) + 보기 전용 40명(초당 5번 커서 이동), 60초 |
| `lab-50` | 실습 1개: 학생 50명이 각자 사본에 초당 3자, 교사 탭 하나가 소켓 하나로 50개 사본을 모두 구독, 60초 |
| `reconnect-storm` | `single-share-50`을 40초 돌리다 15초에 모든 소켓을 한꺼번에 끊음. `--storm restart --restart-cmd "<명령>"`이면 그 명령(예: collab 재시작)을 대신 실행 |
| `mixed-200` | `single-share-50` + `lab-50` + 작은 공유 20개(작성자 2명 + 보기 3명): 연결 250개, 약 200명 |

결과에는 그룹별 지연 백분위수(편집, 커서), 전달 건수, 수렴 검사(복제본 해시, 빠지거나 중복된 입력, 커서 누락), 오류, 서버 지표(`/metrics`), 서비스별 `docker stats`, 호스트 CPU가 들어갑니다. 목표를 하나라도 놓치면 종료 코드가 1입니다. 결과는 `.box-out/perf/<시나리오>-<라벨>-<시각>.json`에 쌓이고 `pnpm load:report`가 `.box-out/perf/report.md`로 요약합니다.

운영 구성(`deploy/docker-compose.yml`) 그대로 측정하려면 기존 스택과 겹치지 않는 임시 스택을 띄웁니다(프로젝트 이름, env 디렉터리, 이미지 태그, 포트 8850, 서브넷이 따로이고, 한 호스트에서 모든 가상 사용자가 접속하므로 속도 제한과 할당량을 올려 둡니다).

```sh
PERF_DIR=/srv/codesh-perf scripts/load/perf-stack.sh up
pnpm load -- --url http://localhost:8850 --scenario single-share-50 --docker-project codesh-perf --label before
pnpm load -- --url http://localhost:8850 --scenario reconnect-storm --docker-project codesh-perf \
  --storm restart --restart-cmd "PERF_DIR=/srv/codesh-perf scripts/load/perf-stack.sh restart-collab"
pnpm load:report
PERF_DIR=/srv/codesh-perf scripts/load/perf-stack.sh down
```

`PERF_COLLAB_ENV="COLLAB_BROADCAST_WINDOW_MS=0"`처럼 collab 환경 변수를 바꿔 `up`하면 같은 스택에서 설정끼리 비교할 수 있습니다. 운영 중인 서버에 직접 걸 때는 속도 제한(`RATE_LIMIT_*`)에 걸리지 않도록 먼저 올려 두십시오.

### 11.3 브라우저 측정

`pnpm --filter @codesh/web test:perf`는 실제 Chromium 한 개를 열고, 같은 공유에 가상 참여자 49명(`apps/web/perf/sim-clients.ts`: 작성자 9명, 보기 40명)을 붙인 채 입력하면서 단계별로 측정합니다: 혼자 / 49명이 가만히 있음 / 40명이 커서를 움직임 / 9명 입력 + 40명 이동 / 같은 상황에서 보기만 함. 두 번째 테스트는 학생 50명이 입력하는 실습의 교사 화면입니다. 단계마다 긴 작업(`longtask`), 긴 애니메이션 프레임과 그 스크립트, 입력 → 화면 지연, 프레임 간격, Chromium 성능 지표(스크립트·레이아웃·스타일 시간, 메인 스레드 CPU 시간, 스타일·레이아웃 계산 횟수)를 `.box-out/perf/browser-*.json`에 남깁니다. 개발 서버의 React 개발 빌드는 수치를 왜곡하므로 운영 빌드(`E2E_PERF_URL`, 기본값은 위 임시 스택 `http://localhost:8850`)에 대고 돌립니다. `E2E_PERF_SMOOTH=off`는 부드러운 타이핑을 끄고 잽니다.

### 11.4 측정 결과

측정 환경: instabox VM 한 대(4 vCPU, 8 GB RAM)에서 운영 Compose 스택(11.2의 임시 스택), 부하 생성기(1–1.7코어를 씀), 브라우저를 모두 같이 돌렸습니다. 네트워크는 루프백이라 실제 LAN 왕복 시간(보통 1–5 ms)은 빠져 있고, 같은 VM을 다른 작업이 함께 쓰는 동안(부하 평균 최대 41) 잰 수치도 섞여 있습니다. 그래서 절댓값은 비관적이고 흔들리며, 변경 전후는 번갈아 연달아 재서 비교했습니다. 원본은 `.box-out/perf/*.json`, 요약은 `.box-out/perf/report.md`입니다.

**서버 (지연은 ms, 편집 p50 / p95 / p99 / 최대, 커서 p50 / p95 / p99)**

| 시나리오 | 변경 | 편집 지연 | 커서 지연 | 웹소켓 메시지/s | collab CPU (1코어 대비) | Caddy CPU | 결과 |
|---|---|---|---|---|---|---|---|
| single-share-50 | 전 | 5.3 / 13.3 / 19.7 / 57 | 2.8 / 11.5 / 18.8 | 13,329 | 29% | 20% | 통과 |
| single-share-50 | 후 | 4.5 / 10.6 / 15.2 / 48 | 14.8 / 32.8 / 38.0 | 5,078 | 18% | 9% | 통과 |
| single-share-50, VM 포화(호스트 CPU 99%) | 전 | 13.4 / 54.4 / 90.5 / 212 | 11.4 / 54.0 / 90.2 | 11,188 | 22% | 16% | 통과 |
| single-share-50, VM 포화(호스트 CPU 99%) | 후 | 9.0 / 30.1 / 49.3 / 132 | 18.3 / 45.1 / 63.5 | 5,075 | 18% | 9% | 통과 |
| lab-50 | 전 | 1.0 / 2.3 / 4.1 / 9 | 같음 | 758 | 15% | 3% | 통과 |
| lab-50 | 후 | 0.8 / 2.2 / 4.6 / 10 | 같음 | 752 | 13% | 3% | 통과 |
| mixed-200 | 전 | 5.6 / 19.1 / 29.6 / 75 | 4.5 / 18.3 / 28.5 | 14,965 | 48% | 24% | 통과 |
| mixed-200 | 후 | 4.7 / 31.0 / 59.7 / 192 | 15.0 / 44.0 / 68.2 | 8,531 | 47% | 17% | 통과 |
| mixed-200, VM 혼잡(호스트 CPU 86–94%) | 전 | 14.4 / 116 / 205 / 584 | 13.6 / 107 / 188 | 13,180 | 44% | 21% | p95 초과 |
| mixed-200, VM 혼잡(호스트 CPU 86–94%) | 후 | 14.0 / 94.8 / 165 / 463 | 26.5 / 98.2 / 158 | 8,273 | 43% | 16% | 통과 |

모든 실행에서 편집 유실·중복 0건, 모든 복제본 수렴, 오류 0건입니다. "후"의 mixed-200 첫 줄은 다른 작업이 VM을 쓰던 때에 쟀고, 바로 이어 다시 잰 실행에서는 30 ms 창이 적용되지 않는 실습·소그룹 공유까지 두 배 느려졌습니다(창과 무관한 잡음). 번갈아 잰 비교 세 쌍 중 VM이 붐빈 두 쌍(위 "VM 포화/혼잡" 줄)에서는 "후"가 빨랐고, 나머지 한 쌍도 창과 무관한 그룹까지 함께 느려져 잡음과 구분되지 않았습니다. 50명 공유의 메시지가 62% 줄었고 collab·Caddy CPU와 collab 메모리(241 → 170 MiB, mixed-200)가 함께 줄었습니다. 커서는 그 대가로 최대 30 ms 늦게 도착하지만 p95 33–44 ms(VM이 붐빌 때도 98 ms)로 목표 100 ms 안입니다.

**재접속 폭주와 장애 (50명 공유, 모두 편집 유실·중복 0건, 오류 0건, 수렴)**

| 상황 | 끊긴 클라이언트 | 5초 안에 재동기화 | 재동기화 p95 / 최대 | 그동안 입력한 편집의 지연 p95 |
|---|---|---|---|---|
| 모든 소켓이 한꺼번에 끊김 (전 → 후) | 50 | 50 → 50 | 636 / 644 ms → 588 / 590 ms | 611 → 545 ms |
| collab 컨테이너 재시작 (전 → 후) | 50 | 50 → 50 | 2.55 / 2.58 s → 2.48 / 2.50 s | 2.07 → 2.10 s |
| Valkey 재시작 | 0 | 50 | – | 지연 변화 없음 (p95 11.1 ms) |
| MongoDB 재시작 | 0 | 50 | – | 지연 변화 없음 (p95 11.3 ms) |
| MongoDB 8초 정지(`docker pause`) | 0 | 50 | – | 지연 변화 없음 (p95 7.8 ms) |

VM이 다른 작업으로 포화(부하 평균 41, 호스트 CPU 96%)됐을 때 같은 측정을 하면 0.79 s, 3.8 s까지 늘었지만 목표 5초 안이었습니다. collab 재시작 시간의 대부분은 컨테이너가 다시 뜨는 시간이고, 클라이언트는 그동안 간격을 늘려 가며 재접속을 시도합니다(0.4초부터 1.6배씩, 최대 4초, 무작위로 흩뜨림). 그래서 50명이 한 순간에 몰리지 않습니다. 끊긴 동안 입력한 편집은 클라이언트가 들고 있다가 재접속 때 합쳐져 빠짐없이 전달됐습니다. Valkey가 내려가 있는 동안 collab은 Valkey 발행에 실패했다는 로그(`failed to publish`)를 남기지만, 문서는 메모리에서 계속 편집되고 같은 인스턴스의 클라이언트끼리는 그대로 동기화됩니다. 복제본이 여럿이면 그 사이 다른 인스턴스로 가야 할 변경은 Valkey가 돌아온 뒤 다음 변경 때 오가는 Yjs 동기화 단계로 따라잡게 되어 있습니다(이번에는 인스턴스 하나로만 쟀습니다). MongoDB가 멈추거나 재시작하는 동안 저장할 변경은 메모리 버퍼에 쌓였다가 MongoDB가 돌아오면 이어서 쓰도록 되어 있고(ARCHITECTURE.md §6), 편집 경로는 MongoDB를 기다리지 않으므로 지연이 그대로였습니다.

**한계 측정 (한 공유 150명: 작성자 20명 + 보기 130명, 목표 밖)**: 편집 유실·중복 0건, 오류 0건, 수렴했고 collab은 0.35코어, 메모리 136 MiB였습니다. 지연은 p95 344 ms로 목표를 넘었는데, 150명 각각이 모든 변경을 받아 해석하는 부하 생성기가 2.8코어를 쓰며 자기 이벤트 루프 지연이 p99 418 ms까지 밀렸고 호스트 CPU가 98%로 포화해, 서버 몫(collab 이벤트 루프 지연 p99 70 ms)만 따로 떼어 잴 수 없었습니다. 이 규모는 부하 생성기를 다른 머신에 두고 다시 재야 합니다.

**브라우저 (원격 커서 49개, 두 번 잰 평균; 메인 스레드 CPU ms/s, 스타일·레이아웃 계산 횟수/s)**

| 단계 | 전: CPU / 스타일 / 레이아웃 | 후: CPU / 스타일 / 레이아웃 | 입력 → 화면 p95 전 → 후 | 50 ms 넘는 긴 작업 전 → 후 |
|---|---|---|---|---|
| 혼자 입력 (대조군) | 107 / 80 / 26 | 105 / 80 / 26 | 20.0 → 20.3 ms | 0 → 0 |
| 40명이 커서 이동 + 나 입력 | 377 / 304 / 53 | 259 / 106 / 37 | 23.1 → 20.5 ms | 0 → 0 |
| 9명 입력 + 40명 이동 + 나 입력 | 692 / 629 / 144 | 551 / 153 / 68 | 29.9 → 26.6 ms | 0 → 0 |
| 같은 상황, 보기만 | 502 / 377 / 263 | 356 / 137 / 42 | – | 1 → 0 |
| 실습 교사 화면, 학생 50명 입력 | 140 (한 번) | 120 | – | 0 → 0 |

모든 단계가 60 fps(최저 57.8 → 59.6)였습니다. 줄어든 것은 원격 커서 이름표 애니메이션을 다시 시작할 때마다 일으키던 강제 리플로(커서마다 `offsetWidth` 읽기), 두 레이어가 따로 하던 커서 위치 계산, 커서가 움직일 때마다 참여자 목록·편집기 컨텍스트·따라가기·실습 타일이 다시 렌더링되던 일입니다. 부드러운 타이핑은 같은 49명 상황에서 메인 스레드 CPU를 약 15%(초당 478 → 551 ms, 혼자 입력할 때 85 → 105 ms) 더 쓰지만 스타일·레이아웃 계산 횟수는 그대로이고 긴 작업도 생기지 않았으며, 입력 → 화면 p95(22 → 27 ms)는 50 ms 목표 안입니다. VM이 다른 작업으로 붐빌 때는 켜고 끄는 것과 무관하게(끈 상태에서도) 50 ms 넘는 작업이 몇 개 생겼습니다. 헤드리스 Chromium의 소프트웨어 렌더링이라 GPU가 있는 실제 PC에서는 더 가볍습니다.

### 11.5 권장 하드웨어

| 규모 | 최소 | 권장 | 메모 |
|---|---|---|---|
| 한 공유 50명 (동시 사용자 약 50명) | 2 vCPU, 4 GB RAM, SSD 20 GB | 4 vCPU, 8 GB RAM | 4 GB에서는 `MONGO_CACHE_GB=1` |
| 동시 사용자 약 200명 (수업 + 실습 + 소그룹) | 4 vCPU, 8 GB RAM, SSD 40 GB | 8 vCPU, 16 GB RAM | collab 하나로 충분. 400명 이상이거나 collab CPU가 계속 0.7코어를 넘으면 `COLLAB_REPLICAS=2` |

근거: 한 공유 50명에서 서버 전체가 평균 약 0.4코어(collab 0.18, Caddy 0.09, MongoDB 0.08–0.13, 순간 최대 MongoDB 0.4), 메모리 약 0.7 GB(collab 120 MiB, api 110 MiB, MongoDB 190–340 MiB, Caddy 40 MiB, Valkey 7 MiB)를 썼습니다. 약 200명 혼합에서는 평균 약 0.8코어(collab 0.45, Caddy 0.17, MongoDB 0.13–0.18, 순간 최대 1.3코어), 메모리 약 0.9 GB입니다. 최소 사양은 CPU 여유 두 배 이상과 MongoDB 캐시·OS 몫의 메모리를 남기는 크기이고, 권장 사양은 수업 여러 개가 겹치거나 재접속 폭주가 오는 순간까지 감당하는 크기입니다. 수치가 VM 한 대에서 나왔고 부하 생성기가 같은 CPU를 나눠 썼으므로 실제 서버에서는 여유가 더 큽니다. 메모리 상한(`mem_limit`)은 Compose에 넣지 않았습니다. 실측이 예산에 한참 못 미치고, 상한을 잘못 잡으면 순간 부하에 컨테이너가 OOM으로 죽는 편이 더 위험하기 때문입니다. 위 11.1의 예산을 감시 기준으로 쓰십시오.

### 11.6 감시 지표와 조치 기준

`/metrics/collab`(10.2)에서 다음을 보십시오.

| 지표 | 정상 | 조치 |
|---|---|---|
| `codesh_collab_nodejs_eventloop_lag_p99_seconds` | 0.01–0.03 (10 ms 해상도로 재므로 유휴 시에도 0.01 안팎) | 5분 넘게 0.05 초과: collab이 포화. 복제본 추가 |
| `rate(codesh_collab_ws_messages_sent_total[1m])`, `rate(codesh_collab_ws_bytes_sent_total[1m])` | 50명 공유 하나에 약 5,000건/s, 4.5 MB/s | 사용자 수에 비해 급증하면 커서 폭주를 의심 |
| `codesh_collab_slow_client_closes_total` | 거의 증가하지 않음 | 계속 증가: 수신이 느린 클라이언트(버퍼 4 MB 초과, 4408 종료 후 재접속). 네트워크 확인 |
| `codesh_collab_awareness_dropped_total` | 0 | 증가: 연결당 초당 30회를 넘는 커서 갱신을 버리는 중(비정상 클라이언트) |
| `codesh_collab_flush_errors_total`, `codesh_collab_flush_seconds` | 오류 0, p99 < 0.1 s | 오류 증가: MongoDB 쓰기 실패. 편집은 메모리에 남아 재시도되지만 MongoDB를 바로 점검 |
| 컨테이너 CPU(`docker stats`) | collab이 1코어의 70% 미만 | 계속 넘으면 `COLLAB_REPLICAS` 증가 |

설정으로 바꿀 수 있는 것: 연결이 8개 이상인 문서는 커서만 바뀐 변경을 30 ms 창으로 묶어 보냅니다(편집은 즉시 나감, ARCHITECTURE.md §4). `COLLAB_BROADCAST_WINDOW_MS`로 창을 바꿀 수 있고(0–200, 0이면 끔) 비교 측정 외에는 기본값을 권장합니다.

---

## 12. CLI 도구 (codesh CLI)

터미널 환경에서 코드를 즉시 공유하고 내려받을 수 있는 CLI 도구(`packages/cli`)를 제공합니다.

### 12.1 연결 설정
CLI는 다음 순서로 대상 서버 URL을 찾습니다.
1. 명령행 플래그: `--url <URL>`
2. 환경 변수: `CODESH_URL`
3. 설정 파일: Windows는 `%APPDATA%\codesh\codesh.json`, Linux/macOS는 `~/.config/codesh.json`의 `"url"` 필드

Windows에서 저장소를 내려받은 뒤 Node.js 22 이상과 Corepack을 준비하고 다음 명령으로 CLI를 빌드해 전역 링크를 등록할 수 있습니다.
```powershell
corepack pnpm install --filter @codesh/cli...
corepack pnpm --filter @codesh/cli build
corepack pnpm --filter @codesh/cli link --global
$env:CODESH_URL = "http://192.168.1.20"
codesh push .\sample-project --no-qr
codesh open 123456
codesh pull 123456 -o .\received
```
폴더 공유는 폴더 이름을 포함한 상대 경로로 보관하고, 경로 구분자는 공유 안에서 `/`로 정규화됩니다. 내려받은 텍스트 파일의 줄바꿈 바이트는 변경하지 않습니다. `codesh open`은 Windows 기본 브라우저를 열며, QR 출력은 ANSI 색상 코드 없이 표시합니다. `Ctrl+C`는 실행 중인 CLI를 종료합니다.

### 12.2 주요 명령어
- **코드 및 파일 공유 (`codesh push`)**:
  ```sh
  codesh push main.py utils.py --title "서버 로직"
  codesh push - --name snippet.py < snippet.py      # 표준 입력(stdin) 전달
  codesh push README.md --view-only                 # 보기 전용으로 공유
  ```
  성공 시 터미널에 아스키 QR 코드(생략 시 `--no-qr`), 접속 URL, 6자리 참여 코드가 출력됩니다.
- **브라우저에서 열기 (`codesh open`)**:
  ```sh
  codesh open 123456          # 6자리 코드로 열기
  codesh open abcd1234        # 8자리 공유 ID로 열기
  codesh open 123456 --print  # 브라우저를 띄우지 않고 URL만 출력
  ```
- **코드 및 아카이브 다운로드 (`codesh pull`)**:
  ```sh
  codesh pull 123456 -o ./project              # 디렉터리에 파일들로 풀기
  codesh pull 123456 --zip -o archive.zip      # ZIP 파일로 저장
  codesh pull 123456 --pin 1234                # PIN 잠금 해제 후 다운로드
  ```

---

## 13. 로그 및 문제 해결

### 13.1 로그 위치 및 로테이션
모든 서비스는 Docker `json-file` 로깅 드라이버를 사용하며, 컨테이너당 **최대 10MB x 3개 파일(총 30MB)**로 제한되어 디스크 풀림을 방지합니다.
```sh
docker compose logs -f api       # API 서버 로그
docker compose logs -f collab    # 실시간 협업 서버 로그
docker compose logs -f caddy     # 에지 프록시 접근 로그
docker compose logs -f mongo     # 데이터베이스 로그
docker compose logs -f valkey    # 캐시/메시징 로그
```

### 13.2 주요 장애 유형과 대응 방법

- **503 `unavailable` (실시간 편집 서버 응답 없음)**:
  - API 서버가 Collab 서버와의 통신(`cmd:<shareId>`) 응답을 5초 이내에 수신하지 못한 경우 발생합니다.
  - Collab 컨테이너 동작 여부 및 Valkey 연결 상태(`docker compose ps`, `docker compose logs collab`)를 확인하십시오.
- **컨테이너 부팅 실패 (취약한 시크릿 거부)**:
  - `NODE_ENV=production` 환경에서는 `SESSION_SECRET`, `COLLAB_SECRET`이 32자 미만이거나 개발용 기본값이면 기동을 거부합니다. `MONGO_PASSWORD`, `VALKEY_PASSWORD` 등이 비어 있으면 `docker compose`가 시작 전에 멈춥니다.
  - `./generate-secrets.sh .env`를 실행하여 안전한 비밀키를 채워 넣으십시오.
- **429 `rate_limited` 또는 PIN 차단**:
  - 특정 IP의 분당 요청 수가 `.env` 임계치를 초과했거나 PIN을 5회 연속 잘못 입력한 경우 발생합니다.
  - 리버스 프록시 뒤에서 모든 클라이언트가 단일 IP로 인식되는 경우 `TRUST_PROXY` 설정이 올바른지 확인하십시오.
- **웹소켓 4408 종료 (Slow Client)**:
  - 네트워크 지연 등으로 특정 클라이언트의 수신 버퍼가 4MB를 초과하면 서버가 4408 코드로 연결을 강제 종료합니다. 클라이언트는 자동으로 재연결을 시도하여 상태를 다시 동기화합니다.
- **403 `forbidden` (CSRF / Origin 불일치)**:
  - API 상태 변경 요청에 `X-Codesh: 1` 헤더가 누락되었거나 허용되지 않은 출처에서 전송된 경우 차단됩니다. API 연동 스크립트 작성 시 해당 헤더를 추가하십시오.


## 14. 운영자 보안 점검표

- [ ] **HTTPS**: 실제 접속 origin을 `PUBLIC_URL=https://...`로 지정해 `Secure` 쿠키를 사용합니다. 로컬 CA 옵션과 신뢰 등록은 [TLS 안내](../deploy/tls/README.md)를 따릅니다. 기본 `SITE_ADDRESS=:80` HTTP도 사용할 수 있지만, 트래픽을 관찰·변조할 수 있는 사람에게 문서, 세션 쿠키, 관리자 토큰, PIN, 편집 키와 협업 토큰이 노출됩니다. 서명 쿠키와 private 주소는 암호화를 제공하지 않습니다.
- [ ] **관리자 토큰**: `ADMIN_TOKEN`을 생성하고 접근 가능한 사람을 제한합니다. 빈 값이면 관리 API가 비활성화됩니다. 토큰을 URL·스크린샷·로그에 넣지 말고, 유출 시 즉시 교체하고 API를 재시작합니다.
- [ ] **백업**: 정기 백업과 별도 호스트의 복원 연습을 수행합니다. `backup.sh`는 `umask 077`, 파일 `0600`, 디렉터리 `0700`을 적용합니다. 백업에는 PIN 해시, 편집 키, 인증 설정과 감사 기록이 포함되므로 암호화된 별도 보관소에 저장합니다. `caddy-data`의 CA 비밀키도 보호하고 백업합니다. Valkey에는 차단, 승인과 일회성 코드 상태가 있으므로 실행 중 임의로 flush하지 않습니다.
- [ ] **메트릭**: Caddy의 `/metrics/api`, `/metrics/collab`은 루프백과 `NETWORK_SUBNET`에서만 접근됩니다. 일반 클라이언트 LAN은 허용하지 않습니다. 외부 수집기는 전용 네트워크 또는 인증된 프록시를 사용하고 Mongo/Valkey/API/Collab 포트를 공개하지 않습니다. 개발 Compose 포트도 기본적으로 `127.0.0.1`에만 바인딩됩니다.
- [ ] **실제 클라이언트 주소**: 속도 제한, PIN 카운터, 할당량, SSE 한도와 차단은 클라이언트 주소별로 적용됩니다. IPv6는 주소별 한도에 더해 /64 전체에 16배 한도가 있습니다(한 기기가 /64 안의 주소를 마음대로 바꿀 수 있기 때문). `TRUST_PROXY`가 Caddy를 가리켜야 API가 실제 주소를 봅니다. Docker Desktop(macOS/Windows), rootless Docker, 또는 IPv6를 사용하지 않는 Compose 네트워크로 들어오는 IPv6 접속은 모든 클라이언트를 같은 주소(게이트웨이)로 보이게 합니다. 이 경우 한 반 전체가 주소별 한도를 함께 쓰고 `/metrics/*`도 모든 클라이언트에 열리므로, Linux 호스트의 rootful Docker에서 IPv4로 접속하게 하거나 한도를 인원에 맞게 올리십시오. `curl http://<서버>/api/session`을 여러 기기에서 호출한 뒤 `docker compose logs api`에서 서로 다른 주소가 보이는지 확인합니다.
- [ ] **할당량과 디스크**: 아래 설정을 사용 인원에 맞게 조정하고, 429/503 증가·Mongo 볼륨 여유 공간·Valkey 사용량을 감시합니다. NAT 뒤의 클라이언트들은 주소별 한도를 공유합니다. 할당량은 첫 예약부터 시작하는 고정 창이며 실패한 업로드의 입장/수신량도 환급하지 않습니다. 공유로 변환하는 업로드는 수신량과 저장 문서량을 모두 계산합니다. 영구 저장 문서·편집 이력·DB 인덱스에는 별도 호스트 디스크 한도가 필요합니다.
- [ ] **차단과 PIN**: 차단(ban)은 그 클라이언트가 참여한 주소도 막으므로 쿠키를 지워도 다시 들어오지 못합니다. 다만 같은 주소로 다른 참여자가 들어와 있으면(NAT 등) 반 전체가 막히지 않도록 주소 차단은 생략됩니다. 공유별 PIN 오답은 10분에 200회까지이며, 이를 넘기면 맞는 PIN도 거절됩니다. 누군가 일부러 오답을 반복해 공유를 막으면 소유자가 PIN을 새로 지정해 카운터를 초기화합니다.
- [ ] **공개 범위**: 기본값은 누구나 편집 가능하고 주변 목록에 표시됩니다. 주변 목록은 네트워크 그룹 전체에 제목과 앞 8줄을 공개합니다. 민감한 내용은 관리 설정 `nearbyDefault=false` 또는 해당 공유의 `access.nearby=false`를 먼저 설정하고, 필요하면 PIN/승인을 사용합니다. 짧은 PIN은 강한 비밀번호가 아닙니다.
- [ ] **공용 기기**: 현재 웹 앱은 방문한 문서를 IndexedDB에 보관합니다. 로그아웃만으로 이 사본이 삭제되지 않으므로 개인 브라우저 프로필을 사용하거나 기기 이용 후 사이트 데이터를 지웁니다. URL의 편집 키도 브라우저 기록과 화면에 남을 수 있습니다. 웹 변경 추적은 [아키텍처의 남은 항목](ARCHITECTURE.md#pending-web-owned-changes)을 참고합니다.
- [ ] **업데이트**: 업데이트 확인을 쓸지 정합니다(기본 켜짐, 15.1). 자동 업데이트는 기본 꺼짐이며 켜면 서버가 매일 정한 시간에 허용된 릴리스를 받아 적용합니다(15.6). 받는 릴리스 파일은 `SHA256SUMS`와 이미지 digest로 확인하지만 서명은 아니므로, 더 강한 확인이 필요하면 `gh attestation verify`를 사용합니다(15.8).
- [ ] **오프라인 번들**: 아카이브와 `.sha256`을 신뢰할 수 있는 경로로 함께 전달합니다. `install.sh`는 추출된 `SHA256SUMS`를 검사하고, `upgrade.sh`는 압축 해제 전 아카이브 체크섬과 로드 전 내용 목록을 검사합니다. 체크섬은 서명이 아니므로 배포자 신원까지 보증하지는 않습니다.

| 환경 변수 | 기본값 | 의미 |
|---|---:|---|
| `QUOTA_WINDOW_SECONDS` | 86400 | 저장 입장/바이트 한도 창, 초 |
| `QUOTA_SHARES_PER_CLIENT` / `QUOTA_SHARES_PER_IP` | 200 / 1000 | 창 안의 공유 생성 수, 포크·실습 사본 포함 |
| `QUOTA_UPLOADS_PER_CLIENT` / `QUOTA_UPLOADS_PER_IP` | 200 / 1000 | 창 안의 업로드 요청 수 |
| `QUOTA_BYTES_PER_CLIENT` / `QUOTA_BYTES_PER_IP` | 536870912 / 2147483648 | 창 안의 수신/저장 문서 바이트 |
| `UPLOAD_STORAGE_MAX_BYTES` | 10737418240 | 전체 GridFS 콘텐츠 상한, 동시 업로드 포함 |
| `SSE_MAX_PER_CLIENT` / `SSE_MAX_PER_IP` | 20 / 200 | 동시 SSE 스트림 수(브라우저 탭마다 1개) |
| `PRESENCE_MAX_PER_NET` | 500 | 네트워크 그룹의 접속자 목록 상한. 가득 차면 새 접속자는 목록에만 빠지고 이벤트는 계속 받습니다 |
| `PENDING_MAX_PER_SHARE` | 100 | 공유별 승인 대기 수 |
| `BROADCASTS_PER_MIN` | 5 | 주소 및 네트워크 그룹별 분당 전체 알림 수 |
| `BROADCAST_FANOUT_MAX` | 500 | 전체 알림 대상 접속자 상한 |
| `MONGO_APP_PASSWORD` | 생성됨 | 앱 DB 사용자 `codesh_app`의 비밀번호 |

`*_PER_IP` 값은 주소 하나의 한도이며, IPv6 /64 전체에는 그 16배가 적용됩니다.

Valkey는 `noeviction`으로 참여 코드, 문서 잠금, 승인과 PIN/속도 제한 카운터를 보존합니다. `maxmemory`의 90%부터 새 저장·프로필·SSE 입장을 503으로 거절하며, OOM 시 필수 쓰기는 실패 처리합니다. 읽기 경로의 전역 속도 제한은 크기가 제한된 보수적 프로세스 내 카운터로 전환하고 `/healthz`도 유지합니다. 기존 협업의 잠금 갱신과 잠깐의 캐시 지연을 위한 여유 공간이 필요하므로 사용량 경고는 90%보다 먼저 설정하십시오. TTL이 있는 코드나 보안 카운터를 임의 축출하는 정책으로 바꾸지 마십시오.

GridFS 전역 바이트 예약은 Mongo의 `storage_quotas`에 보관됩니다. 기존 볼륨에서는 `uploads.files.length` 합계로 처음 초기화합니다. 업로더가 중단되거나 청크 정리가 실패하면 보수적으로 공간이 예약된 채 남을 수 있습니다. 업로드 거절(503)이 실제 사용량보다 이르게 나오면 원장을 다시 계산합니다. 원장 문서를 지우면 다음 업로드가 `uploads.files` 합계로 다시 만듭니다. 실행 중 원장을 지우면 진행 중 업로드 예약을 잃으므로 API·Collab을 멈춘 상태에서만 합니다.

```sh
./backup.sh
docker compose stop api collab
docker compose exec -T mongo sh -c 'mongosh --quiet -u codesh -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin codesh --eval "db.storage_quotas.deleteOne({ _id: \"uploads\" })"'
docker compose start api collab
```

(이 일회성 명령은 컨테이너 안에서만 비밀번호를 인자로 넘깁니다.) 콘텐츠 한도는 WiredTiger, 인덱스 및 파일시스템 오버헤드를 포함하지 않습니다.

### 14.1 MongoDB 최소 권한 사용자

API와 Collab은 `codesh` DB의 `readWrite` 역할만 가진 `codesh_app` 사용자로 접속합니다. root 사용자 `codesh`(`MONGO_PASSWORD`)는 일회성 서비스 `mongo-users`, `backup.sh`, `restore.sh`만 사용합니다. `mongo-users`는 `docker compose up` 때마다 root로 인증해 `codesh_app`을 만들거나 비밀번호(`MONGO_APP_PASSWORD`)와 역할을 다시 맞추고 종료하며, API와 Collab은 그 성공 후에 시작합니다.

이 사용자가 없던 이전 버전의 설치도 따로 전환할 필요가 없습니다. 이전 버전의 `upgrade.sh`로 이 버전 번들을 적용하면 새 `.env.example`의 `MONGO_APP_PASSWORD`가 추가되고 새 `generate-secrets.sh`가 값을 채운 뒤, 시작할 때 `mongo-users`가 기존 볼륨에 사용자를 만듭니다. 저장소에서 직접 `docker compose up`하는 설치는 먼저 `./generate-secrets.sh`를 한 번 실행하십시오(값이 없으면 Compose가 이를 안내하며 시작하지 않습니다).

`mongo-users`가 실패하면(예: `.env`의 `MONGO_PASSWORD`가 볼륨의 root 비밀번호와 다름) API와 Collab은 시작하지 않습니다. `docker compose logs mongo-users`로 원인을 확인하십시오. root 비밀번호를 바꾸려면 먼저 `mongosh`로 볼륨의 비밀번호를 바꾼 뒤 `.env`를 같은 값으로 고칩니다.

---

## 15. 업데이트

새 릴리스가 나오면 관리 콘솔의 **업데이트** 탭에 표시되고, 운영자가 서버에서 `./update.sh` 한 줄로 적용합니다. 원하면 정한 시간에 자동으로 적용하게 할 수 있습니다. 사용하는 서비스(GitHub 릴리스, GHCR 공개 패키지, 공개 저장소의 GitHub Actions, 인증 없는 GitHub API)는 모두 무료입니다(15.10).

### 15.1 업데이트 확인: 무엇이 언제 밖으로 나가나
- `UPDATE_CHECK=on`(기본값)이면 API 서버가 시작하고 3~5분 뒤, 그 뒤로 약 12시간(±30분)마다 한 번 확인합니다. API 인스턴스가 여러 개여도 Valkey 잠금으로 배포 전체에서 한 번만 요청합니다. 시작과 요청 처리를 막지 않는 백그라운드 작업입니다.
- 보내는 것: `GET https://api.github.com/repos/<UPDATE_REPO>/releases/latest` 하나(`UPDATE_CHANNEL=prerelease`이면 `/releases?per_page=20`). 헤더는 `User-Agent: codesh/<현재 버전>`, `Accept`, `X-GitHub-Api-Version`, 그리고 이전 응답의 `If-None-Match`(ETag)뿐입니다. 인증 정보, 쿠키, 설치 식별자, 사용 통계는 보내지 않습니다. GitHub는 요청을 보낸 서버의 공인 IP를 볼 수 있습니다.
- 인터넷이 없으면 5초 안에 실패하고 콘솔에 "인터넷에 연결되지 않아 확인할 수 없어요"가 표시됩니다. 서비스 동작에는 영향이 없습니다.
- 인증 없는 GitHub API는 IP당 시간당 60회까지 허용합니다. codesh는 12시간에 한 번(관리 콘솔의 "지금 확인"은 배포 전체에서 1분에 한 번) 요청하고, 한도에 걸리면 GitHub가 알려 준 재설정 시각까지 다시 묻지 않습니다. 같은 공인 IP를 쓰는 다른 프로그램이 한도를 다 쓴 경우에도 같은 방식으로 기다립니다.
- 결과(현재·최신 버전, 출시일, 릴리스 노트, 확인 시각, 상태)는 Valkey `update:state`에 보관합니다. 릴리스 노트는 최대 4000자의 일반 텍스트로만 저장하고 표시하며 HTML이나 Markdown으로 렌더링하지 않습니다.

### 15.2 업데이트 확인 끄기
`.env`에 `UPDATE_CHECK=off`를 쓰고 `docker compose up -d`로 API를 다시 만듭니다. 이후 API는 외부로 어떤 요청도 보내지 않으며 콘솔에는 "업데이트 확인이 꺼져 있어요"가 표시됩니다. `update.sh`는 운영자가 직접 실행할 때만 GitHub에 접속하므로 이 설정과 상관없습니다.

### 15.3 관리 콘솔
관리 콘솔(관리자 토큰 필요)의 **업데이트** 탭에서 설치된 버전과 최신 릴리스, 출시일, 릴리스 노트, 릴리스 페이지 링크(새 탭), "지금 확인" 버튼, 서버에서 실행할 명령, 자동 업데이트 상태와 마지막 실행 결과를 봅니다. 새 버전이 있으면 탭 이름 옆에 "새 버전" 배지가 붙습니다. 관리자가 아닌 사용자에게는 업데이트 관련 정보가 보이지 않으며, 공개된 것은 `GET /api/version`의 현재 버전 번호뿐입니다.

API는 `/api/admin/update`(조회)와 `/api/admin/update/check`(즉시 확인, 1분에 한 번)를 제공합니다. 자동 업데이트 상태는 `update.sh`가 쓰는 `state/update.json`을 API 컨테이너에 읽기 전용으로 연결(`./state:/codesh-state:ro`)해서 보여 줍니다. 어떤 컨테이너도 Docker 소켓에 접근하지 않으므로 콘솔에서 업데이트를 실행할 수는 없습니다.

열려 있는 브라우저 탭은 서버의 `/api/version`이 자기 빌드와 다르면 "새 버전이 있어요 · 새로고침" 알림을 띄웁니다(탭을 열 때, 다시 볼 때, 30분마다, 실시간 연결이 다시 붙을 때 확인). 새로고침을 누른 탭만 다시 불러오며, 다른 탭은 그대로 유지됩니다. 승인한 탭도 열려 있는 문서의 미전송 변경을 서버가 확인할 때까지 기다리고, 5초 안에 확인되지 않으면 새로고침하지 않습니다. 연결을 복구한 뒤 다시 시도하십시오. "나중에"를 누르면 다음 버전이 나올 때까지 다시 묻지 않습니다.

### 15.4 수동 업데이트 (인터넷이 되는 서버)
설치 폴더(`install.sh`를 실행한 곳)에서 실행합니다. Docker 권한이 있는 사용자 또는 root로 실행하십시오.
```sh
./update.sh --check              # 설치된 버전과 최신 릴리스만 보여 주고 아무것도 바꾸지 않음
./update.sh                      # 같은 주 버전(1.x)의 최신 릴리스로 업데이트 (확인 질문)
./update.sh --yes                # 질문 없이
./update.sh --version 1.4.2      # 특정 릴리스로
./update.sh --allow-major        # 새 주 버전(2.0.0 등)까지. 릴리스 노트의 변경 사항을 먼저 읽으십시오
```
`update.sh`는 다음 순서로 진행하며, 앞 단계가 실패하면 그 뒤는 실행하지 않습니다.
1. 설치 단위 공통 잠금을 취득한 뒤 현재 버전을 읽고 대상 릴리스를 고릅니다. `stable`은 draft와 prerelease 플래그 또는 접미사가 있는 버전을 제외합니다. JSON 파싱에는 **현재 설치된 API 이미지의 Node**를 일회성 컨테이너로 사용합니다(`--pull never`, 앱 시작·호스트 Node/Python/jq 설치 없음).
2. 릴리스의 `SHA256SUMS`와 배포 파일 `codesh-deploy-<버전>.tar.gz`를 받고 외부·내부 체크섬을 확인합니다. 새 파일·설정은 임시 폴더에서 준비합니다. MongoDB 이미지가 달라지면(주 버전뿐 아니라 모든 이미지 변경) 지원되는 별도 마이그레이션 경로가 필요하므로 백업·서비스 중지 전에 거절합니다.
3. 설치 파일을 바꾸지 않은 채 새 이미지를 모두 pull하고 `IMAGES`의 digest와 비교합니다. 다운로드·검증 중에는 기존 서버가 계속 쓰기를 받습니다. 실패하면 서비스는 그대로 유지됩니다.
4. 현재 파일·`.env`·문서·TLS 설정을 `state/rollback/`에 보관하고 maintenance에 들어갑니다. Caddy를 먼저 멈추고 API·Collab을 정지합니다. Collab의 SIGTERM flush와 정상 종료를 기다린 뒤 `backup.sh`로 백업하므로 다운로드 중 받은 쓰기와 종료 직전 편집도 백업에 들어갑니다.
5. 파일·설정을 교체하고 새 앱을 기동합니다. Caddy는 정지한 채 컨테이너 내부 `/healthz`·`/readyz`의 2xx 응답을 확인합니다(`UPDATE_HEALTH_TIMEOUT`, 기본 180초; 각 요청도 남은 시간으로 제한). 검증 후 ingress를 엽니다.
6. 검증 전 파일 복사·rename 오류나 HUP/INT/TERM, 기동 실패는 자동 복구로 이어집니다(15.7). 앱 검증을 통과한 뒤 ingress 활성화가 실패하면 이미 승인된 쓰기를 보존하기 위해 현재 파일·DB를 유지하고 쓰기를 닫은 채 `failed`로 기록합니다. 로그를 확인한 뒤 `docker compose up -d`로 재개합니다. SIGKILL·전원 차단처럼 trap이 실행되지 못한 경우에는 `state/update.json`과 `state/rollback/`을 확인하고 수동 복구합니다.

모든 실행은 `state/update.log`(1 MiB에서 교체, 이전 파일 3개 보관)에 남고, 결과는 `state/update.json`에 기록되어 콘솔에 표시됩니다. 비밀값은 명령행 인자로 전달하지 않으며, GHCR 공개 이미지는 로그인 없이 받습니다. 이전 버전의 이미지는 되돌리기를 위해 남겨 두므로 여유 공간이 부족하면 확인 후 `docker image prune`으로 정리하십시오.

### 15.5 오프라인 업데이트 (인터넷이 없는 서버)
인터넷이 되는 컴퓨터에서 [릴리스 페이지](https://github.com/kim0040/codesh/releases)의 번들(`codesh-<버전>-linux-amd64.tar.gz` 또는 `-linux-arm64.tar.gz`)과 릴리스의 `SHA256SUMS` 파일을 받아 서버의 설치 폴더 옆에 복사한 뒤 실행합니다.
```sh
./upgrade.sh ../codesh-<버전>-linux-amd64.tar.gz
./update.sh --bundle ../codesh-<버전>-linux-amd64.tar.gz    # 같은 잠금·검증·복구 경로
```
`upgrade.sh`와 `update.sh --bundle`은 같은 업데이트 엔진을 사용합니다. 번들 옆의 `<번들>.sha256` 또는 릴리스 `SHA256SUMS`를 확인하고 내부 체크섬으로 `images.tar`를 검증합니다. 이미지를 먼저 load한 뒤 온라인과 같은 maintenance·백업·자동 복구를 수행합니다. Docker load는 registry digest를 보존하지 않으므로 오프라인 무결성 검증은 아카이브·내용 체크섬을 사용합니다. 주 버전 변경에는 `--allow-major`가 필요합니다.

### 15.6 자동 업데이트 (선택, 기본 꺼짐)
```sh
sudo ./update.sh --enable-auto --at 04:00 --policy patch     # 켜기
sudo ./update.sh --enable-auto --dry-run                     # 무엇을 설치할지 보기만
sudo ./update.sh --disable-auto                              # 끄기
```
- systemd가 있으면 `/etc/systemd/system/codesh-update.service`와 `.timer`(매일 `--at` 시각, 최대 15분 무작위 지연, 꺼져 있던 동안 놓친 실행은 켜질 때 한 번)를 설치하고, 없으면 현재 사용자의 crontab에 한 줄을 추가합니다. 한 호스트에 설치 하나를 기준으로 합니다.
- 자동 업데이트 설치 경로는 영문자·숫자·`/ . _ -`만 허용합니다. 공백·작은따옴표·`%` 등이 있는 경로는 systemd/cron 파일을 쓰기 전에 거절합니다.
- 타이머는 `./update.sh --auto`를 실행합니다. 정책에 맞는 릴리스만 적용하며, 주 버전이 바뀌는 업데이트는 정책과 상관없이 자동으로 적용하지 않습니다.
  - `patch`(기본값): 같은 `x.y`의 버그 수정 릴리스만(1.2.0 → 1.2.3).
  - `minor`: 같은 주 버전의 기능 릴리스까지(1.2.0 → 1.5.1).
- 업데이트 순서와 되돌리기는 수동 업데이트와 같고, 결과는 콘솔의 "자동 업데이트"에 표시됩니다. 사용자가 적은 시간대를 고르십시오. 재시작하는 동안 실시간 편집은 잠시 끊겼다가 자동으로 다시 연결됩니다.

### 15.7 되돌리기 (롤백)
- 자동: ingress와 실패한 API·Collab을 먼저 멈추고 이전 파일을 복구합니다. 새 앱 기동을 시도했다면 **DB 인프라만 먼저 시작하여 백업을 복원한 뒤** 이전 앱을 기동합니다. 복원은 새 릴리스가 추가한 collection도 지우고 백업의 DB를 되살립니다. 파일 교체 중 실패처럼 새 앱이 DB에 접근하기 전이면 DB 복원은 생략합니다. 이전 앱의 health/readiness 검증 후에만 ingress를 엽니다. 성공한 복구는 `rolled-back`, 복구 실패는 `failed`와 복구 지침으로 기록되며 종료 코드는 1입니다.
- 수동: API·Collab·Caddy를 먼저 멈추고 `state/rollback/`의 파일을 설치 폴더로 복사합니다(`.env`, `docs`, `tls` 포함). 앱을 먼저 기동하지 말고 `./restore.sh backups/<업데이트 직전 백업> --yes`를 실행합니다. 이 명령은 공통 잠금 아래 DB 복원 → 앱 검증 → ingress 개방 순서로 동작합니다.
- 온라인·오프라인 업데이트, 자동 타이머, backup/restore는 같은 설치 잠금을 사용합니다. `flock`이 없으면 atomic mkdir(`state/install.lock.d`)로 잠급니다. SIGKILL 뒤 남은 잠금은 `owner` PID와 실제 프로세스를 확인한 뒤에만 제거합니다. 복구가 실패하면 ingress를 닫은 채 `state/rollback/`, 백업과 로그를 보존합니다.

### 15.8 릴리스 확인과 출처 증명
릴리스의 모든 파일과 GHCR 이미지에는 GitHub의 빌드 출처 증명이 붙습니다. GitHub CLI로 확인할 수 있습니다(인터넷 필요).
```sh
gh attestation verify codesh-<버전>-linux-amd64.tar.gz --repo kim0040/codesh
gh attestation verify oci://ghcr.io/kim0040/codesh-api:<버전> --repo kim0040/codesh
```
`SHA256SUMS`와 `.sha256`은 손상과 바뀐 파일을 찾아내지만 서명은 아닙니다. HTTPS로 GitHub에서 직접 받거나 출처 증명을 확인하십시오.

### 15.9 프록시
서버가 프록시를 거쳐야 인터넷에 나갈 수 있으면 `.env`에 `HTTPS_PROXY=http://프록시:포트`를 씁니다. Compose가 이 값과 `NODE_USE_ENV_PROXY=1`을 API 컨테이너에 전달합니다(Node 22의 `fetch`는 이 설정이 있어야 `HTTPS_PROXY`를 사용합니다). OIDC 로그인처럼 API가 내부 서버에 접속하는 경우가 있으면 그 호스트를 `NO_PROXY`에 넣으십시오. `update.sh`는 `curl`을 사용하므로 실행하는 셸의 `HTTPS_PROXY`를 따릅니다. 이미지 다운로드는 Docker 데몬의 프록시 설정을 따릅니다.

### 15.10 비용
- GitHub 릴리스(파일 보관과 다운로드), GHCR의 공개 패키지(저장과 전송), 공개 저장소의 GitHub Actions 실행과 빌드 출처 증명, 인증 없는 GitHub REST API는 모두 무료입니다. 인증 없는 API는 IP당 시간당 60회로 제한되며 codesh의 확인 주기(12시간)는 이 한도보다 훨씬 적습니다.
- 유료 서비스나 계정, 토큰이 필요하지 않습니다. 자동 업데이트도 서버 자신의 systemd 타이머 또는 cron으로 동작합니다.

### 15.11 소스에서 설치한 경우
저장소에서 직접 실행하는 설치(`deploy/`에서 `docker compose`)는 `update.sh`가 저장소 파일을 덮어쓰지 않도록 거절합니다. 다음 중 하나를 사용합니다.
```sh
git pull && docker compose build && docker compose up -d     # 소스에서 다시 빌드
docker compose pull && docker compose up -d                  # .env의 CODESH_VERSION 릴리스 이미지를 받아 실행
```

