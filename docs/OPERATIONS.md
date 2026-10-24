# 운영자 안내서 (Operations Guide)

이 문서는 codesh 서비스의 설치, 구성, 운영, 백업 및 모니터링을 담당하는 시스템 관리자를 위한 안내서입니다. 세부 명령어 목록과 빌드 구성은 [deploy/README.md](../deploy/README.md)를 함께 참고하십시오.

---

## 1. 시스템 요구사항

- **운영체제**: Linux (Docker Compose 지원 환경 권장)
- **런타임 의존성**: Docker Engine 및 Docker Compose 플러그인(`docker compose`)
- **하드웨어 권장 사양**:
  - 최소: 2 vCPU, 4GB RAM
  - 권장: 4 vCPU, 8GB RAM (부하 테스트에 쓴 사양, 11.1 참고)
  - 디스크: 최소 20GB 이상 (MongoDB 데이터 볼륨 및 Docker 이미지 보관)
- **네트워크**:
  - 외부 인터넷 연결 불필요 (오프라인 폐쇄망 단독 구동).
  - 런타임 중 외부 CDN, 웹 폰트, 분석 스크립트, 외부 API 호출이 전혀 발생하지 않습니다.
  - 외부 노출 포트: Caddy 에지 프록시의 HTTP(80) 및 HTTPS(443) 포트만 외부에 공개됩니다.

---

## 2. 오프라인 번들 설치

인터넷 연결이 불가능한 폐쇄망 서버에는 사전 패키징된 오프라인 번들(`.tar.gz`)을 통해 배포합니다.

### 2.1 번들 생성 (인터넷 가능 빌드 머신)
Docker와 인터넷이 연결된 환경(또는 개발 박스)에서 번들 스크립트를 실행합니다.
```sh
deploy/bundle.sh [버전]
```
- 실행 결과로 `deploy/dist/codesh-<버전>.tar.gz` 및 SHA256 체크섬 파일이 생성됩니다.
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
| `CODESH_VERSION` | `dev` | 배포할 codesh 이미지 태그. 오프라인 번들 설치 시 번들 버전으로 자동 설정됩니다. |
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
| `COMPOSE_PROFILES` | 주석 처리됨 | `mdns`로 지정하면 LAN용 mDNS 사이드카 컨테이너가 함께 실행됩니다. |
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
- **OIDC / LDAP 로그인 (`auth.oidc`, `auth.ldap`, 기본값: null)**: 인증 제공자 연동 설정입니다.
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
- `GET /readyz`: Collab 서버의 의존성 준비 완료 상태 확인 (MongoDB 및 Valkey 연결 검증). Caddy를 거치지 않으므로 collab 컨테이너의 3002 포트에서 확인합니다(Compose 헬스체크가 사용).

### 10.2 프로메테우스 메트릭 수집
Caddy는 보안을 위해 루프백과 전용 Compose 서브넷의 요청에 대해서만 메트릭 경로를 개방합니다.
- `GET /metrics/api`: API 서버의 HTTP 요청 처리량, 지연 시간, Fastify 및 프로세스 상태.
- `GET /metrics/collab`: Collab 서버의 Hocuspocus 활성 연결 수(`hocuspocus_connections_count`), 활성 문서 수(`hocuspocus_documents_count`), 이벤트 루프 상태.
- Collab 인스턴스가 여러 개인 경우 Caddy를 통한 `/metrics/collab`은 복제본 중 하나로부터 응답하므로, 인스턴스별 메트릭이 필요한 경우 컨테이너 포트(3002)로 직접 스크랩하십시오.

---

## 11. 부하 테스트 (Load Testing)

저장소의 Node 기반 부하 테스트 스크립트(`scripts/load`)를 사용하여 시스템의 동시성 및 동기화 성능을 측정할 수 있습니다.
```sh
pnpm load -- --url http://codesh.corp --shares 20 --writers 3 --viewers 10 --duration 60
```
> [!NOTE]
> 단일 머신에서 대규모 부하를 가할 경우 클라이언트 IP 속도 제한에 걸리지 않도록 `.env`의 `RATE_LIMIT_*` 변수들을 사전에 충분히 상향 조정해야 합니다.

### 11.1 실측 성능 측정 결과
- **측정 환경**: 4 vCPU 단일 호스트 머신, 로컬호스트(localhost) 네트워크
- **테스트 규모**: 20개 공유 문서 x 공유당 13개 클라이언트 (총 260개 동시 웹소켓 연결), 60초간 지속 편집
- **동기화 성공률**: 260 / 260 클라이언트 동기화 완료 (100%)
- **메시지 전송량**: 총 214,704건 메시지 배달
- **동기화 지연 시간 (Latency)**:
  - p50: **2.1 ms**
  - p95: **8.6 ms**
  - p99: **13.6 ms**
- **수렴 및 오류**: 20개 문서 전체 상태 일치 수렴(20/20 converged), 에러 발생 0건 (0 errors)

---

## 12. CLI 도구 (codesh CLI)

터미널 환경에서 코드를 즉시 공유하고 내려받을 수 있는 CLI 도구(`packages/cli`)를 제공합니다.

### 12.1 연결 설정
CLI는 다음 순서로 대상 서버 URL을 찾습니다.
1. 명령행 플래그: `--url <URL>`
2. 환경 변수: `CODESH_URL`
3. 설정 파일: `~/.config/codesh.json`의 `"url"` 필드

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
