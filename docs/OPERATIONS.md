# 운영자 안내서 (Operations Guide)

이 문서는 gachipad 서비스의 설치, 구성, 운영, 백업 및 모니터링을 담당하는 시스템 관리자를 위한 안내서입니다. 세부 명령어 목록과 빌드 구성은 [deploy/README.md](../deploy/README.md)를 함께 참고하십시오.

---

## 목차

1. [시스템 요구사항](#1-시스템-요구사항)
2. [오프라인 번들 설치](#2-오프라인-번들-설치)
3. [환경 변수 (.env) 설정](#3-환경-변수-env-설정)
4. [HTTPS 및 TLS 구성](#4-https-및-tls-구성)
5. [mDNS (gachipad.local) 옵션](#5-mdns-gachipadlocal-옵션)
6. [Collab 인스턴스 수평 확장 (Scaling)](#6-collab-인스턴스-수평-확장-scaling)
7. [프록시 및 네트워크 그룹 구성](#7-프록시-및-네트워크-그룹-구성)
8. [관리 콘솔과 설정 (§10)](#8-관리-콘솔과-설정-10)
9. [데이터베이스 관리 및 업그레이드](#9-데이터베이스-관리-및-업그레이드)
10. [모니터링 및 메트릭](#10-모니터링-및-메트릭)
11. [용량 목표와 부하 테스트 (Capacity)](#11-용량-목표와-부하-테스트-capacity)
12. [CLI 도구 (gachipad CLI)](#12-cli-도구-gachipad-cli)
13. [로그 및 문제 해결](#13-로그-및-문제-해결)
14. [운영자 보안 점검표](#14-운영자-보안-점검표)
15. [업데이트](#15-업데이트)
16. [codesh에서 gachipad로 이름 변경 (1.0.x에서 업그레이드)](#16-codesh에서-gachipad로-이름-변경-10x에서-업그레이드)

---

## 1. 시스템 요구사항

- **운영체제**: Linux (Docker Compose 지원 환경 권장)
- **런타임 의존성**: Docker Engine 및 Docker Compose 플러그인 2.20 이상(`docker compose`)
- **하드웨어 권장 사양**:
  - 최소: 2 vCPU, 4GB RAM
  - 권장: 4 vCPU, 8GB RAM (부하 테스트에 쓴 사양). 사용자 규모별 사양은 11.5를 참고하십시오.
  - 디스크: 최소 20GB 이상 (데이터베이스 볼륨 및 Docker 이미지 보관). SQLite 백엔드를 사용할 경우 런타임 스냅샷(`VACUUM INTO`) 및 백업 검증·복원을 위해 비압축 데이터베이스 파일 크기의 약 2배 이상의 여유 디스크 공간(운영 여유 공간)을 확보해야 합니다(압축 백업 아카이브 및 안전 백업 저장을 위한 디스크 공간은 별도로 확보해야 합니다).
- **네트워크**:
  - 외부 인터넷 연결 없이 오프라인 환경이나 내부 네트워크 환경에서 단독 구동할 수 있습니다.
  - 런타임 중 외부 CDN, 웹 폰트, 분석 스크립트, 외부 API 호출이 발생하지 않습니다. 유일한 예외는 운영자가 끌 수 있는 업데이트 확인(15장)으로, 12시간마다 GitHub API에 GET 요청 하나를 보내고 인터넷이 없으면 조용히 실패합니다. `UPDATE_CHECK=off`이면 아무 요청도 보내지 않습니다.
  - 외부 노출 포트: Caddy 에지 프록시의 HTTP(80) 및 HTTPS(443) 포트만 외부에 공개됩니다.

---

## 2. 오프라인 번들 설치

인터넷 연결이 불가능한 내부 네트워크 서버에는 사전 패키징된 오프라인 번들(`.tar.gz`)을 통해 배포합니다.

### 2.1 번들 생성 (인터넷 가능 빌드 머신)
Docker와 인터넷이 연결된 환경(또는 개발 박스)에서 번들 스크립트를 실행합니다.
```sh
deploy/bundle.sh [버전]
```
- 실행 결과로 `deploy/dist/gachipad-<버전>.tar.gz`, 이미지가 없는 온라인 업데이트용 `gachipad-deploy-<버전>.tar.gz`와 각각의 SHA256 체크섬 파일이 생성됩니다.
- 직접 만들 필요 없이 [GitHub 릴리스](https://github.com/kim0040/gachipad/releases)에서 `gachipad-<버전>-linux-amd64.tar.gz`(또는 `-linux-arm64`)와 `.sha256` 파일을 받아도 됩니다. 릴리스 파일은 GitHub Actions가 만들고 빌드 출처 증명(attestation)이 붙습니다(15.8).
- 번들 아카이브 내부에는 모든 컨테이너 이미지(`images.tar`), 설정 예시(`.env.example`), 배포 파일(`docker-compose.yml`), 관리 스크립트(`install.sh`, `backup.sh`, `restore.sh`, `upgrade.sh` 등)가 포함됩니다.

### 2.2 오프라인 및 내부 네트워크 설치 절차
생성된 번들과 `.sha256` 파일을 대상 서버로 복사하고, 체크섬을 확인한 다음 압축을 풀고 설치 스크립트를 실행합니다. 체크섬 값은 번들과 다른 신뢰할 수 있는 경로(예: 직접 전달한 메모)로 대조하십시오.
```sh
sha256sum -c gachipad-<버전>.tar.gz.sha256
tar xzf gachipad-<버전>.tar.gz
cd gachipad-<버전>        # 릴리스 파일은 이름이 gachipad-<버전>-linux-amd64(또는 -arm64)입니다
PUBLIC_URL=http://gachipad.local ./install.sh [--db sqlite|postgres|mongodb|external] [--database-url URL]
```
`install.sh` 스크립트는 다음 작업을 순차적으로 수행합니다.
1. 번들 안의 `SHA256SUMS`로 모든 파일을 검사하고, 맞지 않으면 아무것도 하지 않고 중단.
2. 데이터베이스 백엔드 확인: TTY 환경에서는 로컬 데이터베이스 포트(5432, 3306, 27017), 실행 중인 DB 컨테이너, 설치된 클라이언트 도구(`psql`, `mysql`/`mariadb`, `mongosh` 등), 가용 메모리를 검사하여 표시하고 대화형 선택 프롬프트(기본값: sqlite)를 제공합니다. 비대화형 환경에서는 `--db` 인자가 없으면 SQLite가 기본 선택됩니다. `DATABASE_URL` 플래그나 환경 변수가 있으면 해당 외부 데이터베이스 또는 SQLite 파일이 우선 적용됩니다.
3. `images.tar`로부터 Docker 이미지를 로컬에 로드(`docker load`).
4. 백엔드 가드 검사: 기존에 다른 백엔드로 생성된 비어있지 않은 데이터 볼륨이나 마커가 존재하면 데이터 복사 도구 없는 임의의 백엔드 전환을 즉시 거부하고 중단.
5. `.env` 파일이 없으면 `.env.example`을 복사하고 선택한 백엔드(`GACHIPAD_DB`, `DATABASE_URL`) 및 전달받은 환경 변수(`PUBLIC_URL`, `HTTP_PORT` 등)를 반영.
6. `generate-secrets.sh`를 실행하여 32자 이상의 무작위 암호화 비밀키 자동 생성 및 선택한 DB에 맞는 `COMPOSE_PROFILES` 구성.
7. `docker compose up -d --wait`로 전체 스택 실행 및 `/healthz` 헬스체크 통과 대기 (최대 120초). 번들 MongoDB를 사용할 경우 일회성 서비스 `mongo-users`가 앱 전용 사용자 `gachipad_app`을 준비합니다.
8. `state/database-kind`에 선택된 백엔드 마커 기록.

---

## 3. 환경 변수 (.env) 설정

`deploy/.env.example`에 정의된 모든 환경 변수의 용도와 기본값입니다.

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `GACHIPAD_VERSION` | `1.0.1` | 실행할 gachipad 릴리스(이미지 태그). `install.sh`, `upgrade.sh`, `update.sh`가 맞춰 줍니다. |
| `GACHIPAD_REGISTRY` | `ghcr.io/kim0040` | `docker compose pull`이 이미지를 받는 곳입니다. 공개 GitHub 패키지 또는 직접 운영하는 미러를 지정합니다. 오프라인 번들은 번들의 값으로 맞춥니다. |
| `GACHIPAD_DB` | `sqlite` | 데이터베이스 백엔드 선택 (`sqlite`, `postgres`, `mongodb`, `external`). 신규 설치 기본값은 `sqlite`입니다. |
| `GACHIPAD_DATABASE_URL` | 자동 파생 | 번들 PostgreSQL, MongoDB 또는 기본 SQLite의 내부 연결 URL입니다. `generate-secrets.sh`가 자동 설정하므로 수동 편집하지 않습니다. |
| `DATABASE_URL` | 비어 있음 | 외부 PostgreSQL, MySQL/MariaDB, MongoDB 서버 연결 URL 또는 명시적 SQLite 파일 경로입니다. |
| `POSTGRES_PASSWORD` | 자동 생성 | 번들 PostgreSQL 17의 `gachipad_app` 사용자 비밀번호입니다. `GACHIPAD_DB=postgres`일 때 생성됩니다. |
| `POSTGRES_DATABASE` | `gachipad` | 번들 PostgreSQL 데이터베이스 이름입니다. |
| `POSTGRES_USER` | `gachipad_app` | 번들 PostgreSQL 사용자 이름입니다. |
| `GACHIPAD_EXTERNAL_BACKUP_CONFIRMED` | 비어 있음 | 외부 데이터베이스 사용 시 외부 서버 백업을 수행했음을 확인하는 플래그입니다(`1`로 설정). |
| `GACHIPAD_COPY_WINDOW_MINUTES` | `15` | `migrate-db.sh` 및 `copy-db`가 사용하는 오프라인 복사 시간 창(분 단위 15~1440)입니다. |
| `UPDATE_CHECK` | `on` | 새 릴리스 확인(15장). `off`이면 외부로 아무 요청도 보내지 않습니다. |
| `UPDATE_REPO` | `kim0040/gachipad` | 릴리스를 확인할 GitHub 저장소(`소유자/이름`)입니다. |
| `UPDATE_CHANNEL` | `stable` | `prerelease`로 바꾸면 릴리스 후보(`1.2.0-rc.1` 등)도 알려 줍니다. |
| `HTTPS_PROXY` / `NO_PROXY` | 주석 처리됨 | 업데이트 확인이 거칠 HTTPS 프록시와 거치지 않을 호스트입니다(15.9). |
| `HTTP_PORT` | `80` | Caddy 컨테이너가 호스트에 바인딩할 HTTP 포트입니다. |
| `HTTPS_PORT` | `443` | Caddy 컨테이너가 호스트에 바인딩할 HTTPS 포트입니다. |
| `SITE_ADDRESS` | `:80` | Caddy가 응답할 주소입니다. `:80`은 모든 IP/도메인의 일반 HTTP 요청을 처리합니다. 도메인(예: `gachipad.local`)을 지정하면 HTTPS가 활성화됩니다. |
| `PUBLIC_URL` | 비어 있음 | 사용자가 브라우저 주소창에 입력하는 기준 URL(예: `https://gachipad.local`, 끝 슬래시 제외)입니다. 세션 쿠키의 Secure 플래그, OIDC 콜백 주소, CSRF 원본 검증에 사용됩니다. 일반 HTTP IP 접근 시 비워둘 수 있습니다. |
| `NETWORK_SUBNET` | `172.29.88.0/24` | Compose 내부 브리지 네트워크 서브넷입니다. 호스트 내부 사설망과 대역이 충돌하는 경우에만 변경합니다. |
| `TRUST_PROXY` | `NETWORK_SUBNET`과 동일 | API 앞단에 위치한 리버스 프록시(Caddy)의 CIDR 대역입니다. Caddy가 실행되는 네트워크 대역을 신뢰하여 `X-Forwarded-For` 헤더로부터 실제 클라이언트 IP를 추출합니다. 비워두면 모든 사용자가 동일 IP로 인식되어 레이트 리밋을 공유하게 됩니다. |
| `CADDY_TRUSTED_PROXIES` | `127.0.0.1/32` | Caddy 앞단에 별도의 로드밸런서가 있을 때, 해당 프록시의 `X-Forwarded-For` 헤더를 신뢰하기 위한 CIDR 대역입니다. |
| `SESSION_SECRET` | 자동 생성 | `gachipad_sid` 쿠키 서명에 사용하는 최소 32자의 비밀키입니다. |
| `COLLAB_SECRET` | 자동 생성 | API 서버와 Collab 서버가 협업 세션 토큰(HMAC-SHA256)을 검증할 때 공유하는 최소 32자의 비밀키입니다. |
| `ADMIN_TOKEN` | 비어 있음 | `/api/admin/*` 및 관리 콘솔 접근에 사용하는 Bearer 토큰입니다. 운영 환경에서는 32자 미만의 토큰이 거부됩니다. `openssl rand -hex 32`로 생성합니다. 토큰 교체 시 `deploy/.env`를 수정하고 API를 재시작(`docker compose up -d api`)합니다. 비워두면 관리자 기능이 비활성화됩니다. |
| `ADMIN_ALLOW_CIDR` | 비어 있음 | 관리 콘솔 및 `/api/admin/*` 접근을 허용할 쉼표 구분 CIDR 목록입니다. 비워두면 모든 IP에서 토큰으로 접근할 수 있습니다. IPv4와 IPv6는 별개이므로 둘 다 사용 시 각각 명시해야 합니다(예: `10.0.0.0/8,fd00::/8`). Caddy 등 역방향 프록시 뒤에서는 실제 프록시 CIDR만 `TRUST_PROXY`에 설정해야 실제 클라이언트 IP로 평가됩니다. |
| `MONGO_PASSWORD` | 자동 생성 | MongoDB root 사용자 `gachipad`의 비밀번호입니다. `mongo-users`, `backup.sh`, `restore.sh`만 사용하고 API와 Collab은 사용하지 않습니다. 최초 컨테이너 구동 시 볼륨을 시딩하는 데 사용되며, 이후 변경은 `mongosh`로 수행해야 합니다. |
| `MONGO_APP_PASSWORD` | 자동 생성 | API와 Collab이 접속하는 `gachipad_app` 사용자(`gachipad` DB의 `readWrite`만 보유)의 비밀번호입니다. `mongo-users`가 시작할 때마다 이 값으로 맞추므로, 바꾼 뒤 `docker compose up -d`만 하면 됩니다. |
| `VALKEY_PASSWORD` | 자동 생성 | Valkey 서버 접근 비밀번호(`requirepass`)입니다. |
| `COLLAB_REPLICAS` | `1` | Collab(실시간 협업 편집) 인스턴스 복제본 수입니다. |
| `MONGO_CACHE_GB` | `2` | MongoDB의 WiredTiger 캐시 메모리 크기(GB)입니다. |
| `VALKEY_MAXMEMORY` | `1gb` | Valkey의 최대 메모리 사용량 한도입니다. 참여 코드, 접속자 상태, 승인·차단과 보안 카운터를 보관하므로 메모리 초과 시 키를 임의 삭제하지 않는 `noeviction` 정책을 사용합니다(14장). |
| `RATE_LIMIT_API_PER_MIN` | `1200` | 클라이언트 주소당 분당 허용되는 일반 API 요청 횟수입니다. 모든 `RATE_LIMIT_*`는 주소별로 세고, IPv6는 /64 전체에도 16배 한도의 카운터가 따로 있습니다. |
| `RATE_LIMIT_CODE_PER_MIN` | `30` | 클라이언트 IP당 분당 허용되는 참여 코드 확인 요청 횟수입니다. |
| `RATE_LIMIT_CREATE_PER_MIN` | `60` | 클라이언트 IP당 분당 허용되는 공유 생성 요청 횟수입니다. |
| `RATE_LIMIT_LOGIN_PER_MIN` | `10` | 클라이언트 IP당 분당 허용되는 인증/로그인 시도 횟수입니다. |
| `COMPOSE_PROFILES` | 주석 처리됨 | `mdns`로 지정하면 로컬 네트워크용 mDNS 사이드카 컨테이너가 함께 실행됩니다. |
| `MDNS_HOSTNAME` | `gachipad.local` | mDNS를 통해 로컬 네트워크에 알릴 도메인 이름입니다. |
| `MDNS_IP` | 비어 있음 | 호스트에 여러 네트워크 카드가 있을 때 mDNS로 응답할 특정 IP 주소입니다. 비워두면 비루프백 IPv4 전체를 공지합니다. |

---

## 4. HTTPS 및 TLS 구성

도메인 기반 HTTPS를 구성하려면 `SITE_ADDRESS`를 도메인으로 설정하고 `deploy/tls/` 디렉터리에 `.caddy` 파일을 추가합니다.

### 4.1 자체 인증서 적용
인증기관(CA)에서 발급받은 인증서와 키를 사용하는 경우:
1. 인증서 파일(`gachipad.crt`)과 비밀키(`gachipad.key`)를 `deploy/tls/`에 배치합니다.
2. `deploy/tls/tls.caddy` 파일을 생성하고 다음 내용을 작성합니다.
   ```caddy
   tls /etc/caddy/tls/gachipad.crt /etc/caddy/tls/gachipad.key
   ```
3. `.env` 파일에서 `SITE_ADDRESS=gachipad.local` 및 `PUBLIC_URL=https://gachipad.local`로 변경 후 컨테이너를 재시작합니다.

### 4.2 Caddy 내장 로컬 CA 사용
인터넷 없이 HTTPS를 제공하려면 Caddy 내장 CA를 사용합니다.
1. `cp tls/internal.caddy.example tls/local.caddy`로 설정을 복사합니다(`tls internal`과 HTTPS 전용 HSTS).
2. `.env`에 `SITE_ADDRESS=gachipad.local`, `PUBLIC_URL=https://gachipad.local`을 지정하고 `docker compose up -d caddy api`로 재시작합니다.
3. 루트 인증서만(`root.crt`, 비밀키 `root.key`는 절대 배포하지 않음) 추출하여 지문을 확인한 뒤 모든 클라이언트 기기에 신뢰할 수 있는 루트 인증서로 등록합니다.

인증서 추출·지문 확인·운영체제별 등록 절차는 [TLS 안내](../deploy/tls/README.md)에 있습니다. CA 비밀키가 있는 `caddy-data` 볼륨은 보호하고 백업하십시오.

---

## 5. mDNS (gachipad.local) 옵션

DNS 서버가 없는 독립 네트워크 환경에서 `http://gachipad.local`로 접속할 수 있도록 mDNS 브로드캐스트 사이드카를 지원합니다.
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

### 7.2 CSRF 방어 (X-Gachipad)
- 브라우저 기반 CSRF 공격을 방지하기 위해, `/api/` 하위의 모든 변경 요청(POST, PATCH, DELETE 등)은 **`X-Gachipad: 1`** 헤더를 반드시 포함하거나 앱 자체 Origin과 일치해야 합니다. 누락 시 403 `forbidden` 에러가 반환됩니다.
- 관리자 API(`/api/admin/*`)는 Bearer 토큰으로 인증되므로 이 검사에서 제외됩니다.

### 7.3 네트워크 그룹과 방 (Rooms)
사용자의 소속 네트워크 그룹(`net`)은 다음 우선순위로 결정됩니다.
1. **방 (Rooms)**: 관리자가 설정에서 정의한 CIDR 대역 목록(`settings.rooms`) 중 클라이언트 IP가 일치하는 방이 있으면 해당 방 이름을 그룹으로 사용합니다.
2. **서브넷**: 방에 일치하지 않으면 클라이언트의 IPv4 `/24` 대역(`settings.subnetPrefixV4` 기준) 또는 IPv6 `/64` 대역이 기본 네트워크 그룹이 됩니다.
- **근처 공유** 탐색 및 **방 전체에 띄우기** 기능은 동일한 네트워크 그룹에 속한 사용자 사이에서만 동작합니다.

---

## 8. 관리 콘솔과 설정 (§10)

### 8.1 관리 콘솔 접속 및 보안 강화
- **접속**: `.env`에 `ADMIN_TOKEN`을 지정하고 스택을 실행합니다. 브라우저에서 `/admin`으로 이동한 후 관리자 토큰을 입력하여 로그인합니다. 토큰은 탭 범위의 브라우저 세션 스토리지(`sessionStorage`)에 보관됩니다.
- **HTTPS 필수 운영**: Bearer 토큰은 관리자 API 요청마다 `Authorization` 헤더에 담겨 전송됩니다. 루프백(`localhost`, `127.0.0.1`)이 아닌 호스트에서 일반 HTTP로 접속할 경우 토큰 노출 위험을 알리는 지속적인 경고 배너가 표시됩니다. 운영 환경에서는 반드시 HTTPS를 구성하십시오.
- **관리자 CIDR 제한 (`ADMIN_ALLOW_CIDR`)**: 관리 콘솔 및 `/api/admin/*` 접근을 허용할 IP 대역을 쉼표로 구분하여 제한할 수 있습니다. 비어 있으면 올바른 토큰을 가진 모든 주소에서 접근할 수 있습니다.
  - **IPv4와 IPv6 독립 지정**: 두 주소 체계는 독립적이므로 클라이언트가 둘 다 사용할 수 있는 환경에서는 각각 명시해야 합니다(예: `ADMIN_ALLOW_CIDR=10.0.0.0/8,fd00::/8`).
  - **`TRUST_PROXY` 필수 요건**: Caddy 등 역방향 프록시 뒤에 배포된 경우, `TRUST_PROXY`가 실제 프록시 CIDR만 가리키도록 설정해야 합니다. `TRUST_PROXY`가 비어 있거나 잘못되면 프록시 자체의 IP가 평가되어 의도한 클라이언트 제한이 적용되지 않습니다.
- **전역 관리자 추측 예산 (Global Admin Guess Budget)**: 무차별 대입 공격을 방지하기 위해 Valkey 기반의 전역 토큰 버킷을 사용합니다.
  - API 복제본 전체에서 공유되는 토큰 버킷으로, 최대 용량 100회, 10분당 100회(6초당 1회) 비율로 리필됩니다.
  - 올바른 관리자 토큰 요청은 예산을 소비하지 않으며, 잘못된 토큰 시도만 버킷을 소모합니다.
  - 예산이 고갈되면 30초간 모든 잘못된 토큰 검증이 일시 중지되며 `429` 및 `Retry-After` 헤더가 반환됩니다.
  - `ADMIN_ALLOW_CIDR`로 명시적 허용된 주소는 이 전역 대기를 우회합니다.
  - 동일 NAT 뒤에 있더라도 잘못된 시도로 인해 올바른 토큰을 가진 관리자가 차단되지 않습니다. Valkey 장애 시 fail-closed 방식으로 동작합니다.
- **관리자 토큰 생성 및 교체 (Rotation)**:
  - 프로덕션 환경에서는 32자 미만의 토큰이 거부됩니다.
  - 토큰 생성: `openssl rand -hex 32`
  - 교체 절차: `deploy/.env`의 `ADMIN_TOKEN` 값을 수정한 후 API 컨테이너를 재시작합니다:
    ```sh
    docker compose up -d api
    ```
  - 관리 콘솔에서 로그아웃한 뒤 새 토큰으로 로그인합니다. 공용 기기 사용 후에는 반드시 콘솔에서 로그아웃하십시오.

### 8.2 관리자 콘솔 운영 패널

관리 콘솔은 상단 탭을 통해 다양한 운영 기능을 제공합니다.

1. **개요 (Overview)**:
   - 실시간 메트릭: 활성 공유 수, 현재 접속자 수, 메모리에 로드된 문서 수, 웹소켓 연결 수, 업로드 스토리지 사용량/한도, API 가동 시간, 서버 버전.
   - 구성 요소 상태 배지: MongoDB, Valkey, Collab 인스턴스의 헬스 상태(`정상`, `중단됨`, `확인되지 않음`).
   - 최근 24시간 활성 공유 생성 추이 차트(시간별 집계).
   - 최근 24시간 오류 건수 및 진단 화면 바로가기 버튼.
2. **공유 (Shares)**:
   - 최대 100건의 실시간 공유 메타데이터 목록(문서 본문이나 비밀값은 포함되지 않음).
   - 제목 검색(최대 100자) 및 타임스탬프/ID 기반 커서 페이징(`최신`, `이전`).
   - 공유 잠금 / 잠금 해제: 권한 generation을 회전하고 실시간 잠금 이벤트를 발행하여 편집을 통제합니다.
   - 영구 삭제: 즉시 데이터베이스 및 스토리지를 정리하며 대상 확인 대화상자를 거칩니다.
3. **진단 (Diagnostics)**:
   - 실시간 진단 이벤트 필터링: 심각도(`전체`, `warn`, `error`), 출처(`전체`, `api`, `collab`), 기간(`전체`, `최근 24시간`).
   - 서버 진단 번들 내보내기 버튼: 클릭 시 `gachipad-server-diagnostics-<버전>.json` 파일을 즉시 내려받습니다.
4. **보안 (Security)**:
   - 보안 설정 현황: `ADMIN_ALLOW_CIDR` 적용 여부, `TRUST_PROXY` 적용 여부, 분당 로그인 및 API 요청 한도.
   - 실패한 관리자 로그인 감사 목록: 프로세스당 1분에 최대 1건씩 HMAC으로 단방향 해시된 클라이언트 주소와 함께 기록되며, 원시 IP나 입력된 추측 토큰은 보관되지 않습니다.
5. **설정 (Settings)**, **접속자 (People)**, **감사 로그 (Audit log)**, **상태 (Status)**, **업데이트 (Updates)**, **코드 템플릿 (Code templates)**.

### 8.3 관리자 설정 항목 (MongoDB `settings` 컬렉션)

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

## 9. 데이터베이스 관리 및 업그레이드

gachipad는 SQLite, 번들 PostgreSQL, 번들 MongoDB 및 외부 데이터베이스 서버(PostgreSQL, MySQL/MariaDB, MongoDB)를 지원합니다. Valkey는 데이터베이스 백엔드 선택과 무관하게 실시간 협업 상태, 세션, 락 관리를 위해 항상 필수로 구동됩니다.

### 9.1 데이터베이스 백엔드 선택 (옵션별 비교)

환경의 인프라 규모와 요구사항에 따라 적합한 백엔드를 선택합니다.

| 백엔드 | 운영 노력 | 백업 방식 | Collab 인스턴스 확장 | 리소스 사용량 | 권장 시점 |
|---|---|---|---|---|---|
| **SQLite** (신규 기본값) | 가장 낮음 (별도 서버 프로세스 및 자격 증명 없음, 파일 기반) | `backup.sh`: `VACUUM INTO` 온라인 스냅샷 (`gachipad-data` 볼륨 내부 임시 생성 후 압축), live WAL 잠금 없음 | 단일 호스트 (공유 볼륨 내 복제본 간 공유, 다중 호스트 불가) | 매우 낮음 (별도 DB 컨테이너 없음, 메모리 오버헤드 최소) | 신규 설치 기본값, 단일 서버 배포, 설정 간소화 및 최소 자원 소모 환경 |
| **번들 PostgreSQL** | 낮음 (Compose `postgres` 프로필로 `postgres:17.11-alpine` 자동 구동) | `backup.sh`: `pg_dump --format=custom` 압축 아카이브 | 다중 인스턴스 확장 가능 (`COLLAB_REPLICAS` 증가 지원) | 중간 (수백 MB 수준의 메모리 점유) | 복수 협업 인스턴스 확장이 필요하고 표준 관계형 데이터베이스를 선호하는 단일 호스트 환경 |
| **번들 MongoDB** | 중간 (Compose `mongodb` 프로필로 `mongo:8.0.34` 및 `mongo-users` 구동) | `backup.sh`: `mongodump` 압축 아카이브 | 다중 인스턴스 확장 가능 (`COLLAB_REPLICAS` 증가 지원) | 높음 (WiredTiger 캐시 기본 2GB + 컨테이너 메모리) | 1.0.x 기존 설치를 데이터 마이그레이션 없이 그대로 유지하며 업그레이드하는 환경 |
| **외부 PostgreSQL** | 운영자 관리 (별도 전용 DB 인프라 운영 및 모니터링) | 운영자 자체 백업 도구 (`pg_dump` 등). gachipad 로컬 백업 스크립트는 로컬 아카이브를 만들지 않음 | 다중 호스트 및 다중 인스턴스 확장 가능 | gachipad 호스트 리소스 사용 없음 (외부 서버 리소스 활용) | 고가용성 PostgreSQL 클러스터 및 자체 백업 체계가 이미 갖춰진 엔터프라이즈 환경 |
| **외부 MySQL/MariaDB** | 운영자 관리 (번들 서비스 없음, 외부 연결 전용) | 운영자 자체 백업 도구 (`mysqldump`, logical backup 등) | 다중 호스트 및 다중 인스턴스 확장 가능 | gachipad 호스트 리소스 사용 없음 | 기존에 운영 중인 중앙 MySQL 또는 MariaDB 인프라를 연동하고자 하는 환경 |
| **외부 MongoDB** | 운영자 관리 (외부 MongoDB Replica Set 인프라 관리) | 운영자 자체 백업 도구 (`mongodump` 등) | 다중 호스트 및 다중 인스턴스 확장 가능 | gachipad 호스트 리소스 사용 없음 | 별도의 고가용성 MongoDB 클러스터(Replica Set)를 이미 운영 중인 환경 |

### 9.2 설치 시 데이터베이스 지정 (install.sh)

`install.sh` 실행 시 `--db` 옵션이나 `DATABASE_URL`을 지정하여 백엔드를 선택할 수 있습니다.
```sh
./install.sh [--db sqlite|postgres|mongodb|external] [--database-url URL]
```

- **대화형 환경(TTY) 감지**:
  - 터미널에서 대화형으로 설치를 실행하면 로컬 포트(5432, 3306, 27017), 실행 중인 DB 컨테이너, 설치된 클라이언트 도구(`psql`, `mysql`/`mariadb`, `mongosh`), 사용 가능한 메모리를 자동으로 검사하여 한 줄 요약으로 출력합니다(어떠한 자격 증명도 임의로 대입하지 않습니다).
  - 설치 스크립트는 설정 및 메모리 비용이 가장 낮고 별도 자격 증명이 필요 없는 SQLite를 기본값으로 추천하며, 프롬프트(`Database [sqlite/postgres/mongodb/external] (default sqlite):`)를 통해 원하는 백엔드를 선택받습니다.
- **비대화형 실행**:
  - `--db` 플래그를 생략하면 자동으로 SQLite(`GACHIPAD_DB=sqlite`)가 선택됩니다.
- **외부 데이터베이스(`external`) 연결**:
  - `DATABASE_URL` 플래그 또는 환경 변수가 제공되면 `--db` 설정보다 항상 우선합니다.
  - 지원되는 URL 스킴: `sqlite:`, `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `mongodb://`, `mongodb+srv://`.
  - 대화형 실행 시 `external`을 선택하고 URL을 전달하지 않으면 숨김 입력 프롬프트(`DATABASE_URL (hidden):`)로 안전하게 입력받습니다. 비대화형 환경에서 URL 없이 `external`을 지정하면 `GACHIPAD_DB=external requires DATABASE_URL` 오류와 함께 종료됩니다.
  - 입력된 URL은 `.env` 파일에 작은따옴표 이스케이프(`'...'`) 형태로 저장되어 특수 문자(`$`, `#`, 공백 등)가 원본 그대로 보존되며 설치 과정 중 화면에 노출되지 않습니다.
- **백엔드 변경 보호 가드**:
  - 설치 스크립트는 `.env`를 갱신하기 전에 기존 볼륨을 검사합니다. 비어있지 않은 기존 데이터 볼륨(예: `gachipad_postgres-data`, `gachipad_mongo-data`, `gachipad_gachipad-data`)이나 기존 백엔드 마커(`state/database-kind`)가 감지되면, 임의의 백엔드 전환을 방지하기 위해 다음 메시지를 출력하고 즉시 거부합니다.
    `install.sh: database backend change refused (<old> -> <new>); use ./migrate-db.sh to copy data and switch backends.`

### 9.3 데이터베이스 비밀번호 변경 및 비밀값 갱신

데이터베이스 접속 비밀번호나 인증 정보를 변경한 경우 반드시 비밀값 생성 스크립트를 실행하여 `.env`와 파생 설정을 갱신해야 합니다.
```sh
./generate-secrets.sh .env
```
- **PostgreSQL 주의사항**:
  - `POSTGRES_PASSWORD` 환경 변수는 신규 볼륨이 처음 생성될 때 초기 비밀번호를 시딩하는 용도로만 사용됩니다.
  - 이미 데이터가 생성된 PostgreSQL 볼륨에서는 `.env`의 `POSTGRES_PASSWORD`를 변경하더라도 내부 데이터베이스 롤(`gachipad_app`)의 실제 비밀번호가 자동으로 회전되지 않습니다.
  - 따라서 비밀번호 변경 시 `psql`을 통해 PostgreSQL 컨테이너 내부에서 사용자 비밀번호를 직접 변경(`ALTER USER gachipad_app WITH PASSWORD '...';`)한 뒤, `.env`를 동일하게 수정하고 `./generate-secrets.sh .env`를 실행해야 합니다.

### 9.4 백엔드별 백업 (backup.sh)

```sh
./backup.sh [저장디렉터리]
```
- 기본 저장 디렉터리는 `./backups`입니다.
- 백업 파일은 `0600`, 새로 생성되는 디렉터리는 `0700` 권한으로 안전하게 작성됩니다.
- 백엔드별 백업 동작:
  - **SQLite**: 실행 중인 `api` 컨테이너 내에서 `node:sqlite`를 통해 데이터 볼륨(`/data`) 내부 임시 경로에 온라인 `VACUUM INTO` 스냅샷을 생성합니다. 라이브 WAL 파일에 잠금을 걸지 않고 원자적으로 일관된 스냅샷을 얻은 뒤 gzip으로 스트리밍 압축합니다. 임시 스냅샷 디렉터리는 작업 완료 후 즉시 제거됩니다.
  - **PostgreSQL**: `postgres` 컨테이너 내부에서 `pg_dump --format=custom`을 실행하고 gzip으로 압축하여 저장합니다.
  - **MongoDB**: `mongo` 컨테이너 내부에서 `mongodump --archive --gzip`을 실행하여 저장합니다.
  - **외부 데이터베이스**: 외부 데이터베이스는 로컬 백업 아카이브를 생성하지 않으며, `GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1` 환경 변수가 설정되어 있지 않으면 0이 아닌 종료 코드로 다음 안내를 출력합니다.
    `backup: DATABASE_URL uses an external database; no local backup was made. Back up the external server with its own tools before updates or restores.`
    운영자는 업데이트나 점검 전에 반드시 해당 외부 데이터베이스 서버의 자체 백업 도구로 백업을 완료해야 합니다.
- Valkey(참여 코드, 접속자 상태, 임시 락, 카운터)는 휘발성 데이터이므로 백업 대상에서 제외됩니다.

### 9.5 백엔드별 복원 (restore.sh)

```sh
./restore.sh <아카이브.gz> [--yes]
```
- 복원 스크립트는 기존 데이터베이스 내용을 아카이브의 내용으로 완전히 교체합니다.
- 백엔드별 복원 동작:
  - **SQLite**:
    1. 압축 아카이브에서 헤더를 검사하여 유효한 `SQLite format 3` 백업인지 확인하고 `PRAGMA integrity_check`를 수행합니다.
    2. 데이터 볼륨의 여유 공간을 검사합니다(압축 해제 크기 + 20% 또는 최소 64 MiB 이상의 여유 공간 필요).
    3. 복원 전 현재 데이터베이스의 안전 백업(`safety backup`)을 먼저 생성합니다.
    4. 쓰기 작업(API, Collab)을 중지합니다.
    5. 대상 데이터베이스 파일 옆에 임시 복원 파일(`<db>.restore`)을 생성하고 검증한 뒤, 기존 `-wal` 및 `-shm` 파일을 삭제하고 원자적으로 새 파일로 교체(`rename`)합니다.
  - **PostgreSQL**:
    1. `pg_restore --list`를 통해 전체 스트림을 검사하여 TOC(목차) 및 무결성을 사전 검증합니다.
    2. 복원 전 라이브 데이터베이스의 안전 백업을 먼저 생성합니다.
    3. 쓰기 작업을 중지합니다.
    4. 고유한 임시 데이터베이스(`gp_restore_<timestamp>_<pid>`)를 생성하고 `pg_restore --single-transaction`으로 데이터를 복원합니다.
    5. 복원이 성공하면 `template1`에 연결하여 단일 트랜잭션 내에서 라이브 데이터베이스와 임시 데이터베이스의 이름을 원자적으로 스왑합니다(`ALTER DATABASE live RENAME TO old; ALTER DATABASE stage RENAME TO live; COMMIT;`).
    6. 스왑 트랜잭션이 성공적으로 커밋된 후에만 이전 데이터베이스(`old`)를 삭제합니다. 복원이나 스왑 중 오류가 발생하면 라이브 데이터베이스는 아무런 변경 없이 그대로 유지됩니다.
  - **MongoDB**:
    1. `gzip -t` 및 `mongorestore --dryRun`으로 사전 검증을 수행합니다.
    2. 현재 데이터의 안전 백업을 생성합니다.
    3. 쓰기 작업을 중지하고 `mongorestore --drop`을 실행하여 데이터를 복원합니다.
  - **외부 데이터베이스**:
    - 로컬 아카이브를 통한 복원을 거부합니다. 외부 데이터베이스는 해당 외부 서버의 자체 관리 도구를 사용하여 복원해야 합니다.

### 9.6 데이터베이스 오프라인 마이그레이션 (migrate-db.sh)

`migrate-db.sh`는 현재 운영 중인 백엔드에서 다른 백엔드로 데이터를 안전하게 오프라인 복사하고 전환하는 도구입니다.

```sh
./migrate-db.sh --to sqlite|postgres|mongodb|external [--window-minutes N] [--yes]
```

#### 주요 플래그 및 환경 변수
- `--to sqlite|postgres|mongodb|external`: 대상 백엔드 (필수).
- `--window-minutes N`: 복사 시간 창 (분 단위 15~1440, 기본값 15 또는 `GACHIPAD_COPY_WINDOW_MINUTES`).
- `--yes`: 대화형 확인 프롬프트 생략 (비대화형 실행 시 필수).
- `DATABASE_URL`: 대상이 `external`인 경우 연결 URL (보안을 위해 명령행 인자가 아닌 환경 변수 또는 TTY 숨김 프롬프트로 전달). 번들 대상을 선택할 때는 `unset DATABASE_URL`로 환경 변수를 해제해야 합니다.
- `GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1`: 소스가 외부 데이터베이스인 경우, 외부 서버 백업이 완료되었음을 확인하는 환경 변수.

#### 마이그레이션 단계별 동작 과정 (다운타임 안내)
1. **사전 검사 및 락 획득**:
   - 설치 락(`state/install.lock`)을 획득하고, 미완료 트랜잭션(`state/transaction`) 유무를 확인합니다.
   - 필요한 호스트 도구(`tee -p`, `curl`, `gzip` 등)와 버전 일치 여부(`VERSION` == `GACHIPAD_VERSION`)를 검증합니다.
2. **동일 백엔드 검증**:
   - 소스와 대상이 동일한 번들 백엔드이거나 동일한 외부 URL인 경우 즉시 거부합니다.
3. **스테이징 환경 구성**:
   - 비공개 임시 디렉터리(`.env.migrate-db.XXXXXX`)를 생성하고, 현재 `.env`와 마커 파일(`state/database-kind`)을 백업합니다.
   - 대상 백엔드에 필요한 비밀값과 Compose 프로필을 스테이징 디렉터리 내부에서 미리 생성합니다(라이브 `.env`는 변경되지 않음).
4. **프리플라이트 점검 (Preflight, 소스 다운타임 전 실행)**:
   - 번들 대상 볼륨이 이미 존재하는 경우 비어 있는지 확인하고(데이터가 있으면 거부), 새 볼륨인 경우 고유 마이그레이션 레이블을 부여하여 생성합니다.
   - API 컨테이너 내에서 이미지 버전 및 복사 도구 스크립트의 존재를 검증합니다.
   - 소스 스키마 버전과 크기를 측정하고, 로컬 디스크(`/data`), 백업 디스크(`backups`), 대상 볼륨 파일시스템의 여유 공간(소스 크기 + max(20%, 64 MiB))을 사전에 검증합니다.
   - 외부 대상인 경우 실제 접속 및 테이블/컬렉션이 완전히 비어 있는지 검사합니다.
5. **서비스 쓰기 정지 (다운타임 시작)**:
   - 프리플라이트 통과 후 Caddy, API, Collab 컨테이너를 정상 중지(`stop_writes`)하여 진행 중인 문서 변경 사항을 안전하게 플러시합니다. **이 시점부터 복사 및 검증이 완료될 때까지 서비스 다운타임이 발생합니다.**
6. **SQLite 소스 체크포인트**:
   - 소스가 SQLite인 경우, 남아 있는 WAL 변경 사항을 메인 데이터베이스 파일로 안전하게 병합하기 위해 `PRAGMA wal_checkpoint(TRUNCATE)`를 실행하고 `-wal`/`-shm` 파일이 완전히 제거되었는지 확인합니다.
7. **대상 서비스 구동 및 소스 정지 백업**:
   - 번들 대상 서비스(PostgreSQL 또는 MongoDB)를 기동합니다.
   - 쓰기가 정지된 소스 데이터베이스에 대해 안전 백업(`database_backup`)을 수행합니다.
8. **오프라인 데이터 복사 (copy-db)**:
   - API 컨테이너 내에서 `copy-db` CLI를 실행하여 데이터를 추출하고 대상에 삽입합니다.
   - 진단 데이터 및 시간 창(`WINDOW`) 내에 만료 예정인 레코드는 건너뜁니다.
   - 복사는 반드시 마감 시간(`WINDOW - 5`분) 이내에 완료되어야 합니다.
   - 복사 완료 후 소스와 대상 간 SHA-256 레코드 다이제스트 일치 여부를 검증합니다.
9. **설정 적용 및 서비스 재개 (다운타임 종료)**:
   - 복사 검증이 성공하면 스테이징의 `.env`를 원자적으로 교체하고 `state/database-kind` 마커를 갱신합니다.
   - 대상 데이터베이스와 API, Collab을 가동하고 헬스체크 통과를 확인한 후 Caddy 인그레스를 다시 열어 서비스를 재개합니다.
   - 스테이징 스냅샷 및 트랜잭션 마커를 정리합니다.
   - **소스 데이터 볼륨은 자동으로 삭제되지 않고 보존됩니다.**

#### 소스 불변성 및 쓰기 정지 필수 요건
- 복사 도구는 단일 파일 핸들과 inode를 통해 SQLite 소스 파일을 검증합니다.
- 복사가 진행되는 동안 SQLite 소스 파일의 경로를 이동하거나 이름을 바꾸거나 심볼릭 링크를 교체해서는 안 됩니다. 경로가 변경되면 복사는 즉시 실패(`exit 1`)합니다.
- 복사 도중 API와 Collab 등 모든 쓰기 프로세스가 반드시 정지 상태를 유지해야 합니다.

#### 거부(Refusal) 및 실패(Failure) 메시지와 운영자 조치 사항

| 메시지 | 원인 | 운영자 조치 |
|---|---|---|
| `migrate-db: destination was not modified: refused (see the Result line above); use an empty destination.` | 대상 볼륨이나 데이터베이스에 기존 데이터가 이미 존재함 | 대상 데이터베이스나 볼륨을 완전히 비우거나 새로운 빈 대상을 지정하여 재시도하십시오. 기존 데이터를 확인 없이 임의로 삭제하지 마십시오. |
| `migrate-db: source refused (see the Result line above); nothing was copied. Fix the source and retry; do not delete -wal/-shm files, which can hold committed data.` | 소스 SQLite에 잔여 WAL 파일이 있거나, MongoDB 소스가 Primary가 아니거나 복제 지연이 발생함 | 소스 데이터베이스 상태를 확인하십시오. SQLite의 경우 커밋된 데이터가 유실될 수 있으므로 `-wal`/`-shm` 파일을 절대로 임의 삭제하지 마십시오. |
| `migrate-db: destination was not modified; nothing was copied. Fix the cause and retry.` | 대상에 쓰기 작업이 시작되기 전에 연결 실패, 타임아웃 또는 스키마 불일치로 실패함 | 소스와 설정이 안전하게 이전 상태로 복구되었으므로, 오류 로그(`state/migrate-db.log`)를 확인하여 원인을 수정한 뒤 재시도하십시오. |
| `migrate-db: destination may hold a partial copy; inspect and clear it before retrying. Existing destination volumes are kept.` | 데이터 복사 도중 네트워크 단절, 프로세스 종료 등으로 인해 대상에 일부 데이터가 복사됨 | 대상 데이터베이스를 수동으로 점검하고 복사된 잔여 데이터를 완전히 비운 뒤 재시도하십시오. 기존 소스 데이터는 안전하게 유지됩니다. |
| `migrate-db: destination volume identity could not be verified; retained for manual inspection.` | 새로 생성한 대상 볼륨의 고유 식별자가 일치하지 않아 자동 삭제되지 않음 | 안전을 위해 보존된 볼륨이므로 `docker volume ls`로 상태를 수동 점검한 후 불필요 시 수동 삭제하십시오. |
| `migrate-db: new backend may have accepted writes; destination retained. Reconcile those writes before retrying or removing any data.` | 인그레스가 열린 후 헬스체크 실패 등으로 롤백되었으며, 새 백엔드에 사용자의 쓰기가 유입되었을 가능성이 있음 | 새 백엔드에 저장된 데이터를 수동으로 대조하고 조정한 후 대상을 정리하십시오. |
| `migrate-db: automatic recovery incomplete; configuration snapshots kept in <STAGE>.` | 자동 복구 과정에서 오류가 발생하여 원본 설정 복구가 불완전하게 끝남 (종료 코드 3) | 출력된 수동 복구 지침에 따라 `<STAGE>/original.env`를 복원하고 이전 서비스를 수동으로 재시작하십시오. |

#### 복사 시간 창(--window-minutes) 튜닝 및 처리량

- 기본 시간 창은 15분이며, 마감 시간은 `15 - 5 = 10분`, 만료 마진은 `15분`입니다.
- **실측 처리량 (개발 환경 기준)**:
  - MongoDB -> PostgreSQL: 약 40 MB/s (10분 기준 약 12 GB 업로드 데이터 또는 약 130만 개 레코드 처리 가능)
  - MongoDB -> SQLite: 약 85 ~ 106 MB/s (10분 기준 약 25 GB 업로드 데이터 또는 약 220만 개 레코드 처리 가능)
  - 레코드 수가 많고 업로드 크기가 작은 데이터셋의 경우 처리 속도가 약 4 ~ 7 MB/s 수준으로 낮아질 수 있습니다.
- **시간 창 계산 공식**:
  `최소 윈도우(분) = 데이터 크기(MB) / 처리량(MB/s) / 60 * 2 + 5`
  네트워크 지연, 디스크 속도 및 대량의 레코드 수를 고려하여 최소 계산값의 2배 이상을 설정하는 것을 권장합니다(최대 1440분 = 24시간).

#### 1.0.1 업데이터 환경에서의 migrate-db.sh 1회 수동 추출

1.0.1 버전의 업데이터는 파일 배포 화이트리스트가 고정되어 있어 신규 스크립트인 `migrate-db.sh`를 자동으로 배포하지 못합니다. 1.0.1에서 1.1.0으로 업그레이드한 환경에서는 다음 명령어를 통해 1.1.0 번들 아카이브로부터 스크립트를 1회 수동 추출하여 배치해야 합니다.

```sh
sha256sum -c gachipad-deploy-1.1.0.tar.gz.sha256 && \
bundle_root="$(tar -tzf gachipad-deploy-1.1.0.tar.gz | cut -d / -f 1 | sort -u)" && \
tar -xOf gachipad-deploy-1.1.0.tar.gz "$bundle_root/migrate-db.sh" >migrate-db.sh.new && \
chmod 700 migrate-db.sh.new && mv migrate-db.sh.new migrate-db.sh && ./migrate-db.sh --help
```

#### 마이그레이션 성공 후 소스 데이터 수동 정리

마이그레이션이 완료된 후 새 백엔드에서 공유와 업로드 데이터가 정상 동작함을 확인했다면, 디스크 공간 확보를 위해 이전 소스 데이터 볼륨을 수동으로 삭제할 수 있습니다(사전 백업 아카이브는 계속 보관하십시오).

- **구 MongoDB 소스 정리**:
  ```sh
  docker compose --profile mongodb rm -sfv mongo-users mongo
  docker volume rm <프로젝트명>_mongo-data
  ```
- **구 PostgreSQL 소스 정리**:
  ```sh
  docker compose --profile postgres rm -sf postgres
  docker volume rm <프로젝트명>_postgres-data
  ```
- **구 SQLite 소스 정리**:
  API 및 Collab 컨테이너가 공유 데이터 볼륨 마운트를 해제해야 하므로 일시 중지 후 정리합니다.
  ```sh
  docker compose stop caddy api collab && docker compose rm -f api collab
  docker volume rm <프로젝트명>_gachipad-data
  docker compose up -d --pull never
  ```
- **구 외부 데이터베이스 정리**:
  해당 외부 데이터베이스 서버의 자체 관리 도구를 사용하여 수동으로 데이터베이스를 정리하십시오.

### 9.7 새 버전으로 업그레이드
인터넷이 되는 서버는 `./update.sh`로 업데이트합니다(15.4). 인터넷이 없는 서버는 새 번들로 업그레이드합니다.
```sh
./upgrade.sh ../gachipad-<새버전>.tar.gz
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
| 브라우저 (49명이 접속해 움직이는 공유. 49개 커서가 모두 화면 안에 있는 경우 포함) | 50 ms를 넘는 긴 작업 없음, 키 입력 → 다음 프레임(대용 지표, 11.3) p95 < 50 ms, 60 fps 유지(오차 5 fps: 55 fps 이상) |
| 실습 교사 화면 (학생 50명이 입력 중) | 50 ms를 넘는 긴 작업 없음, 60 fps 유지(55 fps 이상) |
| 서버 자원, 한 공유 50명 | collab ≤ 0.5코어·512 MiB, api ≤ 0.25코어·256 MiB, MongoDB ≤ 0.5코어·1 GiB, Valkey ≤ 0.1코어·64 MiB |
| 서버 자원, 동시 사용자 약 200명 | collab ≤ 1코어·1 GiB, api ≤ 0.5코어·512 MiB, MongoDB ≤ 1코어·2 GiB, Valkey ≤ 0.25코어·128 MiB |

자원 예산은 실측 평균의 두 배 이상이 되도록 잡았습니다(11.4). 서버 자원은 CPU는 실행 중 평균(`docker stats`, 코어 하나가 100%), 메모리는 최댓값으로 비교하고, 컨테이너가 여럿인 서비스는 합계를 씁니다. Node 프로세스(collab, api)는 하나가 코어 하나까지만 쓰므로, collab이 1코어에 가까워지면 복제본을 늘립니다(6장, 11.6).

### 11.2 시나리오와 실행 방법

`scripts/load`는 실제 클라이언트와 같은 프로토콜(API로 세션·토큰 발급, Hocuspocus 웹소켓, Yjs, awareness)로 접속하는 가상 사용자를 워커 스레드 여러 개에서 돌립니다. 이름 있는 시나리오는 다음과 같습니다.

| 시나리오 | 내용 |
|---|---|
| `single-share-50` | 공유 1개: 작성자 10명(초당 5자, 입력마다 커서 이동) + 보기 전용 40명(초당 5번 커서 이동), 60초 |
| `lab-50` | 실습 1개: 학생 50명이 각자 사본에 초당 3자, 교사 탭 하나가 소켓 하나로 50개 사본을 모두 구독, 60초 |
| `reconnect-storm` | `single-share-50`을 40초 돌리다 15초에 모든 소켓을 한꺼번에 끊음. `--storm restart --restart-cmd "<명령>"`이면 그 명령(예: collab 재시작)을 대신 실행 |
| `mixed-200` | `single-share-50` + `lab-50` + 작은 공유 20개(작성자 2명 + 보기 3명): 연결 250개, 약 200명 |

결과에는 그룹별 지연 백분위수(편집, 커서), 전달 건수, 수렴 검사(복제본 해시, 빠지거나 중복된 입력, 커서 누락), 오류, 서버 지표(`/metrics`), 서비스별 `docker stats`, 호스트 CPU가 들어갑니다. 지연·수렴·오류·재접속 목표를 하나라도 놓치면 종료 코드가 1입니다. `--docker-project`를 주면 11.1의 서버 자원 예산(CPU 평균, 메모리 최댓값)도 같은 방식으로 검사하며, 샘플이 없는 서비스는 데이터 없음으로 실패 처리합니다. 예산은 클라이언트 100개 이하는 "한 공유 50명", 300개 이하는 "약 200명" 열을 쓰고 그보다 크면 검사하지 않습니다. `--docker-project` 없이 돌리면 자원은 검사하지 않으므로, 그때의 종료 코드는 프로토콜·지연 합격 여부일 뿐입니다(실행 끝에 한 줄로 알려 줍니다). collab 복제본이 둘 이상이면 컨테이너별 값은 그대로 두고 서비스 값은 같은 시각의 합계로 내며, 여러 프로세스의 카운터가 섞이는 `/metrics/collab` 기반 값(웹소켓 메시지·CPU 비율, 이벤트 루프 지연, RSS)은 지원하지 않아 `-`로 표시합니다. 결과는 `.box-out/perf/<시나리오>-<라벨>-<시각>.json`에 쌓이고 `pnpm load:report`가 `.box-out/perf/report.md`로 요약합니다.

운영 구성(`deploy/docker-compose.yml`) 그대로 측정하려면 기존 스택과 겹치지 않는 임시 스택을 띄웁니다(프로젝트 이름, env 디렉터리, 이미지 태그, 포트 8850, 서브넷이 따로이고, 한 호스트에서 모든 가상 사용자가 접속하므로 속도 제한과 할당량을 올려 둡니다).

```sh
PERF_DIR=/srv/gachipad-perf scripts/load/perf-stack.sh up
pnpm load -- --url http://localhost:8850 --scenario single-share-50 --docker-project gachipad-perf --label before
pnpm load -- --url http://localhost:8850 --scenario reconnect-storm --docker-project gachipad-perf \
  --storm restart --restart-cmd "PERF_DIR=/srv/gachipad-perf scripts/load/perf-stack.sh restart-collab"
pnpm load:report
PERF_DIR=/srv/gachipad-perf scripts/load/perf-stack.sh down
```

`PERF_COLLAB_ENV="COLLAB_BROADCAST_WINDOW_MS=0"`처럼 collab 환경 변수를 바꿔 `up`하면 같은 스택에서 설정끼리 비교할 수 있습니다. 운영 중인 서버에 직접 걸 때는 속도 제한(`RATE_LIMIT_*`)에 걸리지 않도록 먼저 올려 두십시오.

### 11.3 브라우저 측정

`pnpm --filter @gachipad/web test:perf`는 실제 Chromium 한 개를 열고, 같은 공유에 가상 참여자 49명(`apps/web/perf/sim-clients.ts`: 작성자 9명, 보기 40명)을 붙인 채 입력하면서 단계별로 측정합니다. 첫 번째 테스트: 혼자 / 49명이 가만히 있음 / 40명이 커서를 움직임 / 9명 입력 + 40명 이동 / 같은 상황에서 보기만 함. 여기서 작성자는 글 끝에 계속 이어 쓰고 보기 사용자는 글 전체에서 커서를 옮기므로, 49명이 접속했다는 것(참여자 목록의 "+46")만 확인하고 그 커서가 모두 화면 안에 있는지는 확인하지 않습니다. 두 번째 테스트(화면 안 49명)는 한 화면에 들어가는 24줄짜리 고정 코드에서, 작성자 9명이 각자 자기 줄을 고쳐 쓰고 보기 사용자 40명이 줄 안에서 커서를 옮기며 그중 10명은 선택 영역을 잡고 있습니다. 브라우저는 마지막 빈 줄에 짧은 줄을 쳤다 지웁니다. 단계 동안 2초마다 편집기 스크롤 영역과 겹치는 원격 커서·선택 영역 수를 세어 기록하고, 커서가 49개가 아니면(선택은 작성자가 그 줄을 비울 때 잠깐 접히므로 5개 미만이면) 실패합니다. 세 번째 테스트는 학생 50명이 입력하는 실습의 교사 화면입니다. 단계마다 긴 작업(`longtask`), 긴 애니메이션 프레임과 그 스크립트, 키 입력 → 다음 프레임 시간, 프레임 간격, Chromium 성능 지표(스크립트·레이아웃·스타일 시간, 메인 스레드 CPU 시간, 스타일·레이아웃 계산 횟수)를 `.box-out/perf/browser-*.json`에 남깁니다. "키 입력 → 다음 프레임"은 keydown 뒤 다음 애니메이션 프레임에서 큐에 넣은 작업이 도는 시각까지의 시간으로, 어떤 입력이 편집기에 반영돼 글자가 화면에 나타난 시각을 재는 것이 아니라 메인 스레드가 키 입력에 얼마나 늦게 반응하는지 보는 대용 지표입니다(예전 결과 파일에는 `inputToPaintMs`라는 이름으로 남아 있습니다). IME 조합은 이 지표로 재지 않습니다. 모든 단계에 긴 작업 50 ms 이하, 이 지표 p95 50 ms 미만, 55 fps 이상(60 fps에 5 fps 오차)을 요구합니다. VM이 다른 작업으로 붐비면(부하 평균 4.5–7) 같은 단계가 50–55 fps, 긴 작업 1–8개(52–87 ms), 이 지표 p95 50–79 ms까지 밀려 실패할 수 있으므로, 부하 평균이 2 아래로 내려간 뒤 다시 돌립니다. 개발 서버의 React 개발 빌드는 수치를 왜곡하므로 운영 빌드(`E2E_PERF_URL`, 기본값은 위 임시 스택 `http://localhost:8850`)에 대고 돌립니다. `E2E_PERF_SMOOTH=off`는 부드러운 타이핑을 끄고 잽니다.

### 11.4 측정 결과

측정 환경: VM 한 대(4 vCPU, 8 GB RAM)에서 운영 Compose 스택(11.2의 임시 스택), 부하 생성기(1–1.7코어를 씀), 브라우저를 모두 같이 돌렸습니다. 네트워크는 루프백이라 실제 LAN 왕복 시간(보통 1–5 ms)은 빠져 있고, 같은 VM을 다른 작업이 함께 쓰는 동안(부하 평균 최대 41) 잰 수치도 섞여 있습니다. 그래서 절댓값은 비관적이고 흔들리며, 변경 전후는 번갈아 연달아 재서 비교했습니다. 원본은 `.box-out/perf/*.json`, 요약은 `.box-out/perf/report.md`입니다.

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

모든 실행에서 편집 유실·중복 0건, 모든 복제본 수렴, 오류 0건입니다. "후"의 mixed-200 첫 줄은 다른 작업이 VM을 쓰던 때에 쟀고, 바로 이어 다시 잰 실행에서는 30 ms 창이 적용되지 않는 실습·소그룹 공유까지 두 배 느려졌습니다(창과 무관한 잡음). 번갈아 잰 비교 세 쌍 중 VM이 붐빈 두 쌍(위 "VM 포화/혼잡" 줄)에서는 "후"가 빨랐고, 나머지 한 쌍도 창과 무관한 그룹까지 함께 느려져 잡음과 구분되지 않았습니다. 50명 공유의 메시지가 62% 줄었고 collab·Caddy CPU와 collab 프로세스 RSS(`/metrics`의 241 → 170 MiB, mixed-200 A/B 한 쌍이며 11.5의 `docker stats` 메모리와는 다른 지표)가 함께 줄었습니다. 커서는 그 대가로 최대 30 ms 늦게 도착하지만 p95 33–44 ms(VM이 붐빌 때도 98 ms)로 목표 100 ms 안입니다.

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

**브라우저 (참여자 49명 접속, 두 번 잰 평균; 메인 스레드 CPU ms/s, 스타일·레이아웃 계산 횟수/s)**

이 표는 49명이 접속해 있다는 것만 확인했고, 그 커서가 모두 화면 안에 있었는지는 검증하지 않았습니다(작성자는 글 끝에 이어 쓰고 보기 사용자는 글 전체에서 움직여서, 글이 길어진 뒤에는 일부가 화면 밖이었을 수 있습니다). 화면 안에 49개가 모두 있는 경우는 이 표 아래의 별도 표입니다.

| 단계 | 전: CPU / 스타일 / 레이아웃 | 후: CPU / 스타일 / 레이아웃 | 키 입력 → 다음 프레임(대용) p95 전 → 후 | 50 ms 넘는 긴 작업 전 → 후 |
|---|---|---|---|---|
| 혼자 입력 (대조군) | 107 / 80 / 26 | 105 / 80 / 26 | 20.0 → 20.3 ms | 0 → 0 |
| 40명이 커서 이동 + 나 입력 | 377 / 304 / 53 | 259 / 106 / 37 | 23.1 → 20.5 ms | 0 → 0 |
| 9명 입력 + 40명 이동 + 나 입력 | 692 / 629 / 144 | 551 / 153 / 68 | 29.9 → 26.6 ms | 0 → 0 |
| 같은 상황, 보기만 | 502 / 377 / 263 | 356 / 137 / 42 | – | 1 → 0 |
| 실습 교사 화면, 학생 50명 입력 | 140 (한 번) | 120 | – | 0 → 0 |

모든 단계가 60 fps(최저 57.8 → 59.6)였습니다. 줄어든 것은 원격 커서 이름표 애니메이션을 다시 시작할 때마다 일으키던 강제 리플로(커서마다 `offsetWidth` 읽기), 두 레이어가 따로 하던 커서 위치 계산, 커서가 움직일 때마다 참여자 목록·편집기 컨텍스트·따라가기·실습 타일이 다시 렌더링되던 일입니다. 부드러운 타이핑은 같은 49명 상황에서 메인 스레드 CPU를 약 15%(초당 478 → 551 ms, 혼자 입력할 때 85 → 105 ms) 더 쓰지만 스타일·레이아웃 계산 횟수는 그대로이고 긴 작업도 생기지 않았으며, 키 입력 → 다음 프레임 p95(22 → 27 ms)는 50 ms 목표 안입니다(편집기가 글자를 화면에 그린 시각이 아니라 메인 스레드의 반응 시간을 보는 대용 지표입니다, 11.3). VM이 다른 작업으로 붐빌 때는 켜고 끄는 것과 무관하게(끈 상태에서도) 50 ms 넘는 작업이 몇 개 생겼습니다. 헤드리스 Chromium의 소프트웨어 렌더링이라 GPU가 있는 실제 PC에서는 더 가벼울 것으로 보이지만 측정하지는 않았습니다.

**브라우저, 49개 커서가 모두 화면 안 (24줄 고정 코드, 작성자 9명이 자기 줄을 고쳐 쓰고 보기 40명이 줄 안에서 이동, 그중 10명은 선택 영역을 잡음; VM 부하 평균 1–4에서 두 번 잰 평균, 괄호는 각 실행)**

| 단계 | 화면 안 커서 / 선택 | 메인 스레드 CPU ms/s | 스타일 / 레이아웃 계산 횟수/s | 키 입력 → 다음 프레임(대용) p95 | 50 ms 넘는 긴 작업 | fps |
|---|---|---|---|---|---|---|
| 9명 입력 + 40명 이동 + 나 입력 | 49 / 10 (모든 표본, 단계당 8개) | 461 (472, 449) | 155 / 90 | 39.0, 30.7 ms | 0, 0 | 60.0, 60.1 |
| 같은 상황, 보기만 | 49 / 10 (모든 표본) | 390 (414, 367) | 140 / 69 | – | 0, 0 | 60.0, 60.2 |

위 표와는 부하 모양이 달라(작성자가 자기 줄만 고치고, 브라우저는 마지막 줄에 짧은 줄을 쳤다 지움) CPU를 직접 비교하지 않습니다. 이 두 번은 VM 부하 평균이 1–4일 때 잰 것입니다. 부하 평균이 4.5–7이던 때에는 같은 단계가 50–55 fps, 이 지표 p95 79 ms, 60 ms 안팎의 긴 작업 몇 개로 밀려 목표를 놓쳤습니다(커서 49개와 선택 10개는 그때도 화면 안이었습니다).

### 11.5 권장 하드웨어

| 규모 | 최소(추정) | 권장 | 메모 |
|---|---|---|---|
| 한 공유 50명 (동시 사용자 약 50명) | 2 vCPU, 4 GB RAM, SSD 20 GB | 4 vCPU, 8 GB RAM | 4 GB에서는 `MONGO_CACHE_GB=1` |
| 동시 사용자 약 200명 (수업 + 실습 + 소그룹) | 4 vCPU, 8 GB RAM, SSD 40 GB | 8 vCPU, 16 GB RAM | collab 하나로 충분. 400명 이상(추정)이거나 collab CPU가 계속 0.7코어를 넘으면 `COLLAB_REPLICAS=2` |

근거: 한 공유 50명에서 서버 전체가 평균 약 0.4코어(collab 0.18, Caddy 0.09, MongoDB 0.08–0.13, 순간 최대 MongoDB 0.4), 메모리 약 0.7 GB(collab 120 MiB, api 110 MiB, MongoDB 190–340 MiB, Caddy 40 MiB, Valkey 7 MiB)를 썼습니다. 약 200명 혼합에서는 평균 약 0.8코어(collab 0.45, Caddy 0.17, MongoDB 0.13–0.18, 순간 최대 1.3코어), 메모리 약 0.9 GB입니다. 최소 사양은 CPU 여유 두 배 이상과 MongoDB 캐시·OS 몫의 메모리를 남기는 크기이고, 권장 사양은 수업 여러 개가 겹치거나 재접속 폭주가 오는 순간까지 감당하는 크기입니다. 수치가 4 vCPU·8 GB 공유 VM 한 대에서 실행당 1분 안팎으로 잰 것이고 부하 생성기가 같은 CPU를 나눠 썼으므로, 위 최소 사양(2 vCPU·4 GB)과 400명 이상에서 복제본을 늘리라는 기준은 이 측정에서 추정한 값이지 그 사양이나 그 규모에서 직접 잰 값이 아닙니다. 실제 서버에서는 부하 생성기가 빠지므로 여유가 더 있을 것으로 보입니다. 메모리 상한(`mem_limit`)은 Compose에 넣지 않았습니다. 실측이 예산에 한참 못 미치고, 상한을 잘못 잡으면 순간 부하에 컨테이너가 OOM으로 죽는 편이 더 위험하기 때문입니다. 위 11.1의 예산을 감시 기준으로 쓰십시오.

### 11.6 감시 지표와 조치 기준

`/metrics/collab`(10.2)에서 다음을 보십시오.

| 지표 | 정상 | 조치 |
|---|---|---|
| `gachipad_collab_nodejs_eventloop_lag_p99_seconds` | 0.01–0.03 (10 ms 해상도로 재므로 유휴 시에도 0.01 안팎) | 5분 넘게 0.05 초과: collab이 포화. 복제본 추가 |
| `rate(gachipad_collab_ws_messages_sent_total[1m])`, `rate(gachipad_collab_ws_bytes_sent_total[1m])` | 50명 공유 하나에 약 5,000건/s, 4.5 MB/s | 사용자 수에 비해 급증하면 커서 폭주를 의심 |
| `gachipad_collab_slow_client_closes_total` | 거의 증가하지 않음 | 계속 증가: 수신이 느린 클라이언트(버퍼 4 MB 초과, 4408 종료 후 재접속). 네트워크 확인 |
| `gachipad_collab_awareness_dropped_total` | 0 | 증가: 연결당 초당 30회를 넘는 커서 갱신을 버리는 중(비정상 클라이언트) |
| `gachipad_collab_flush_errors_total`, `gachipad_collab_flush_seconds` | 오류 0, p99 < 0.1 s | 오류 증가: MongoDB 쓰기 실패. 편집은 메모리에 남아 재시도되지만 MongoDB를 바로 점검 |
| 컨테이너 CPU(`docker stats`) | collab이 1코어의 70% 미만 | 계속 넘으면 `COLLAB_REPLICAS` 증가 |

설정으로 바꿀 수 있는 것: 연결이 8개 이상인 문서는 커서만 바뀐 변경을 30 ms 창으로 묶어 보냅니다(편집은 즉시 나감, ARCHITECTURE.md §4). `COLLAB_BROADCAST_WINDOW_MS`로 창을 바꿀 수 있고(0–200 정수, 0이면 끔) 비교 측정 외에는 기본값을 권장합니다. `deploy/.env`(또는 셸 환경)에 적으면 Compose가 collab 컨테이너로 넘기고(`deploy/docker-compose.yml`), 적지 않으면 기본값 30입니다. 값을 바꾼 뒤 `docker compose up -d collab`으로 collab을 다시 만들어야 적용되며 `docker compose exec collab printenv COLLAB_BROADCAST_WINDOW_MS`로 확인합니다. 창이 길수록 메시지는 줄지만 다른 사람의 커서가 최대 창 길이만큼 늦게 보이고, 편집 지연은 그대로이며, 창을 쓰는 문서 크기(연결 8개 이상)는 바뀌지 않습니다.

---

## 12. CLI 도구 (gachipad CLI)

터미널 환경에서 코드를 즉시 공유하고 내려받을 수 있는 CLI 도구(`packages/cli`)를 제공합니다. `codesh` 명령어는 호환성을 위한 비권장 별칭으로 유지됩니다.

### 12.1 연결 설정
CLI는 다음 순서로 대상 서버 URL을 찾습니다.
1. 명령행 플래그: `--url <URL>`
2. 환경 변수: `GACHIPAD_URL` (구버전 호환: `CODESH_URL`)
3. 설정 파일: Windows는 `%APPDATA%\gachipad\gachipad.json`, Linux/macOS는 `~/.config/gachipad.json`(`XDG_CONFIG_HOME`가 있으면 그 아래)의 `"url"` 필드 (구버전 호환: `%APPDATA%\codesh\codesh.json`, `~/.config/codesh.json`)

Windows에서 저장소를 내려받은 뒤 Node.js 22 이상과 Corepack을 준비하고 다음 명령으로 CLI를 빌드해 전역 링크를 등록할 수 있습니다.
```powershell
corepack pnpm install --filter @gachipad/cli...
corepack pnpm --filter @gachipad/cli build
corepack pnpm --filter @gachipad/cli link --global
$env:GACHIPAD_URL = "http://192.168.1.20"
gachipad push .\sample-project --no-qr
gachipad open 123456
gachipad pull 123456 -o .\received
```
폴더 공유는 폴더 이름을 포함한 상대 경로로 보관하고, 경로 구분자는 공유 안에서 `/`로 정규화됩니다. 내려받은 텍스트 파일의 줄바꿈 바이트는 변경하지 않습니다. `gachipad open`은 Windows 기본 브라우저를 열며, QR 출력은 ANSI 색상 코드 없이 표시합니다. `Ctrl+C`는 실행 중인 CLI를 종료합니다.

### 12.2 주요 명령어
- **코드 및 파일 공유 (`gachipad push`)**:
  ```sh
  gachipad push main.py utils.py --title "서버 로직"
  gachipad push - --name snippet.py < snippet.py      # 표준 입력(stdin) 전달
  gachipad push README.md --view-only                 # 보기 전용으로 공유
  ```
  성공 시 터미널에 아스키 QR 코드(생략 시 `--no-qr`), 접속 URL, 6자리 참여 코드가 출력됩니다.
- **브라우저에서 열기 (`gachipad open`)**:
  ```sh
  gachipad open 123456          # 6자리 코드로 열기
  gachipad open abcd1234        # 8자리 공유 ID로 열기
  gachipad open 123456 --print  # 브라우저를 띄우지 않고 URL만 출력
  ```
- **코드 및 아카이브 다운로드 (`gachipad pull`)**:
  ```sh
  gachipad pull 123456 -o ./project              # 디렉터리에 파일들로 풀기
  gachipad pull 123456 --zip -o archive.zip      # ZIP 파일로 저장
  gachipad pull 123456 --pin 1234                # PIN 잠금 해제 후 다운로드
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
- **웹소켓 4429 종료 (Document update rate exceeded)**:
  - 클라이언트가 비정상적으로 빠른 속도로 문서 업데이트를 전송하는 경우 발생합니다. Collab 서버는 웹소켓 연결당 토큰 버킷(버스트 200회, 초당 50회 지속 리필)을 적용하며, 한도를 초과하면 4429 코드로 연결을 닫습니다. 일반적인 타이핑이나 단일 대용량 붙여넣기(1회 업데이트로 처리)는 한도를 초과하지 않습니다.
- **403 `forbidden` (CSRF / Origin 불일치)**:
  - API 상태 변경 요청에 `X-Gachipad: 1` 헤더가 누락되었거나 허용되지 않은 출처에서 전송된 경우 차단됩니다. API 연동 스크립트 작성 시 해당 헤더를 추가하십시오.

### 13.3 진단 (Diagnostics) 데이터와 심볼리케이션
gachipad는 운영 및 버그 재현을 위해 개인정보가 철저히 배제된 내부 진단 링 버퍼를 제공합니다.

- **수집 항목**:
  - 표준화된 오류 범주(safe error categories) 및 프레임워크/라이브러리 소스 위치.
  - 화이트리스트 기반의 허용된 errno 문자열 및 숫자 오류 코드.
  - 연결, 동기화, 오프라인 상태 변화 및 성능 지표(느린 플러시, 롱 태스크 등).
  - 대략적인 문서 크기, 파일 수, 접속자 수 버킷(정확한 수치나 파일명은 제외).
  - 프로세스별 `bootId` 및 최근 최대 50건의 페이로드 없는 브레드크럼(breadcrumbs).
- **엄격한 프라이버시 스크러빙 (제외 항목)**:
  - 문서 본문 내용, 파일 이름, 상대 경로, 사용자 입력 데이터.
  - PIN 번호 및 해시값, 6자리 참여 코드, 편집 키, 세션 쿠키, 관리자 토큰.
  - 전체 요청/응답 본문, 쿼리 파라미터가 포함된 전체 URL.
- **제한 및 보관 상한 (Caps)**:
  - 브라우저 클라이언트 및 각 서버 프로세스 링 버퍼: **최대 500개 이벤트 그룹 및 262,144바이트(256 KB UTF-8)**, 보관 주기 **14일**. 지문(fingerprint) 기반으로 동일 이벤트는 새 엔트리를 만들지 않고 횟수, 첫/마지막 시각, 최대 지연시간만 갱신.
  - MongoDB 미러 스토리지: **16개 고정 문서 슬롯**(API 8개, Collab 8개), 슬롯당 스냅샷 직렬화 상한 **393,216바이트**(전체 최대 6 MiB). 주기적(5초) 비동기 플러시.
- **자동 전송 없음**: 진단 데이터는 어떠한 외부 서버로도 자동 전송되지 않습니다.
  - 사용자는 에디터 **설정 → 진단 → 내보내기**에서 브라우저 로컬 진단 JSON 파일을 수집합니다.
  - 운영자는 관리 콘솔 **진단 → 내보내기**(`GET /api/admin/diagnostics/export`)에서 서버 진단 번들을 수집합니다.
- **클라이언트 스택 심볼리케이션 (Symbolication)**:
  - 배포 빌드 이미지의 용량 절감 및 보안을 위해 런타임 웹 이미지에는 소스 맵이 포함되지 않습니다. 대신 릴리스 시점에 `gachipad-web-sourcemaps-<버전>.tar.gz` 파일이 GitHub 릴리스 자산으로 분리되어 배포됩니다.
  - 운영자는 클라이언트 진단 JSON 파일을 전달받은 후, 소스 맵 아카이브를 풀어 저장소에 포함된 `scripts/symbolicate.mjs`를 실행하여 원본 코드 위치를 복원할 수 있습니다:
    ```sh
    tar xzf gachipad-web-sourcemaps-<버전>.tar.gz -C /tmp/sourcemaps
    node scripts/symbolicate.mjs /path/to/client-diagnostics.json /tmp/sourcemaps
    ```

### 13.4 참여자 권한 제어와 전송 거부 텍스트 보관
- **소유자 통제 권한 스위치**:
  - `allowParticipantRename`: 참여자의 공유 제목 변경 허용 여부.
  - `allowParticipantFiles`: 참여자의 파일 추가, 이름 변경, 삭제 허용 여부.
  - `allowParticipantLanguage`: 참여자의 기존 파일 언어 변경 허용 여부.
- **기본값 및 무중단 호환성**:
  - 모든 스위치는 신규 생성 및 기존 공유 모두 기본값이 `false`입니다.
  - 기존 데이터베이스 레코드에 해당 필드가 없더라도 기본 `false`로 자동 해석되므로 데이터 마이그레이션이 필요 없습니다.
- **서버 측 강제 검증**:
  - Collab 서버의 업데이트 가드가 수신된 Yjs 바이너리 업데이트를 분석하여, 권한이 부여되지 않은 제목, 파일 구조, 언어 변경을 포함한 업데이트를 사전에 거부(`permission_refused`)하고 브로드캐스트하지 않습니다.
- **전송 거부된 로컬 텍스트 보관**:
  - 권한 변경이나 잠금으로 인해 참여자의 편집이 거부되면 해당 탭의 문서는 서버 상태로 재동기화됩니다.
  - 이때 클라이언트는 작성 중이던 로컬 텍스트(메인 및 고아 파일 포함)를 탭 메모리에 보관하고 복구 대화상자를 표시합니다.
  - 사용자는 "보내지 못한 텍스트 복사" 버튼으로 작성 내용을 복사할 수 있으며, 탭을 닫거나 "사본 버리기"를 누르기 전까지 안전하게 보존됩니다.


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
| `MONGO_APP_PASSWORD` | 생성됨 | 앱 DB 사용자 `gachipad_app`의 비밀번호 |

`*_PER_IP` 값은 주소 하나의 한도이며, IPv6 /64 전체에는 그 16배가 적용됩니다.

Valkey는 `noeviction`으로 참여 코드, 문서 잠금, 승인과 PIN/속도 제한 카운터를 보존합니다. `maxmemory`의 90%부터 새 저장·프로필·SSE 입장을 503으로 거절하며, OOM 시 필수 쓰기는 실패 처리합니다. 읽기 경로의 전역 속도 제한은 크기가 제한된 보수적 프로세스 내 카운터로 전환하고 `/healthz`도 유지합니다. 기존 협업의 잠금 갱신과 잠깐의 캐시 지연을 위한 여유 공간이 필요하므로 사용량 경고는 90%보다 먼저 설정하십시오. TTL이 있는 코드나 보안 카운터를 임의 축출하는 정책으로 바꾸지 마십시오.

GridFS 전역 바이트 예약은 Mongo의 `storage_quotas`에 보관됩니다. 기존 볼륨에서는 `uploads.files.length` 합계로 처음 초기화합니다. 업로더가 중단되거나 청크 정리가 실패하면 보수적으로 공간이 예약된 채 남을 수 있습니다. 업로드 거절(503)이 실제 사용량보다 이르게 나오면 원장을 다시 계산합니다. 원장 문서를 지우면 다음 업로드가 `uploads.files` 합계로 다시 만듭니다. 실행 중 원장을 지우면 진행 중 업로드 예약을 잃으므로 API·Collab을 멈춘 상태에서만 합니다.

```sh
./backup.sh
docker compose stop api collab
docker compose exec -T mongo sh -c 'mongosh --quiet -u gachipad -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin gachipad --eval "db.storage_quotas.deleteOne({ _id: \"uploads\" })"'
docker compose start api collab
```

(이 일회성 명령은 컨테이너 안에서만 비밀번호를 인자로 넘깁니다.) 콘텐츠 한도는 WiredTiger, 인덱스 및 파일시스템 오버헤드를 포함하지 않습니다.

### 14.1 MongoDB 최소 권한 사용자

API와 Collab은 `gachipad` DB의 `readWrite` 역할만 가진 `gachipad_app` 사용자로 접속합니다. root 사용자 `gachipad`(`MONGO_PASSWORD`)는 일회성 서비스 `mongo-users`, `backup.sh`, `restore.sh`만 사용합니다. `mongo-users`는 `docker compose up` 때마다 root로 인증해 `gachipad_app`을 만들거나 비밀번호(`MONGO_APP_PASSWORD`)와 역할을 다시 맞추고 종료하며, API와 Collab은 그 성공 후에 시작합니다.

이 사용자가 없던 이전 버전의 설치도 따로 전환할 필요가 없습니다. 이전 버전의 `upgrade.sh`로 이 버전 번들을 적용하면 새 `.env.example`의 `MONGO_APP_PASSWORD`가 추가되고 새 `generate-secrets.sh`가 값을 채운 뒤, 시작할 때 `mongo-users`가 기존 볼륨에 사용자를 만듭니다. 저장소에서 직접 `docker compose up`하는 설치는 먼저 `./generate-secrets.sh`를 한 번 실행하십시오(값이 없으면 Compose가 이를 안내하며 시작하지 않습니다).

`mongo-users`가 실패하면(예: `.env`의 `MONGO_PASSWORD`가 볼륨의 root 비밀번호와 다름) API와 Collab은 시작하지 않습니다. `docker compose logs mongo-users`로 원인을 확인하십시오. root 비밀번호를 바꾸려면 먼저 `mongosh`로 볼륨의 비밀번호를 바꾼 뒤 `.env`를 같은 값으로 고칩니다.

---

## 15. 업데이트

새 릴리스가 나오면 관리 콘솔의 **업데이트** 탭에 표시되고, 운영자가 서버에서 `./update.sh` 한 줄로 적용합니다. 원하면 정한 시간에 자동으로 적용하게 할 수 있습니다. 사용하는 서비스(GitHub 릴리스, GHCR 공개 패키지, 공개 저장소의 GitHub Actions, 인증 없는 GitHub API)는 모두 무료입니다(15.10).

### 15.1 업데이트 확인: 무엇이 언제 밖으로 나가나
- `UPDATE_CHECK=on`(기본값)이면 API 서버가 시작하고 3~5분 뒤, 그 뒤로 약 12시간(±30분)마다 한 번 확인합니다. API 인스턴스가 여러 개여도 Valkey 잠금으로 배포 전체에서 한 번만 요청합니다. 시작과 요청 처리를 막지 않는 백그라운드 작업입니다.
- 보내는 것: `GET https://api.github.com/repos/<UPDATE_REPO>/releases/latest` 하나(`UPDATE_CHANNEL=prerelease`이면 `/releases?per_page=20`). 헤더는 `User-Agent: gachipad/<현재 버전>`, `Accept`, `X-GitHub-Api-Version`, 그리고 이전 응답의 `If-None-Match`(ETag)뿐입니다. 인증 정보, 쿠키, 설치 식별자, 사용 통계는 보내지 않습니다. GitHub는 요청을 보낸 서버의 공인 IP를 볼 수 있습니다.
- 인터넷이 없으면 5초 안에 실패하고 콘솔에 "인터넷에 연결되지 않아 확인할 수 없어요"가 표시됩니다. 서비스 동작에는 영향이 없습니다.
- 인증 없는 GitHub API는 IP당 시간당 60회까지 허용합니다. gachipad는 12시간에 한 번(관리 콘솔의 "지금 확인"은 배포 전체에서 1분에 한 번) 요청하고, 한도에 걸리면 GitHub가 알려 준 재설정 시각까지 다시 묻지 않습니다. 같은 공인 IP를 쓰는 다른 프로그램이 한도를 다 쓴 경우에도 같은 방식으로 기다립니다.
- 결과(현재·최신 버전, 출시일, 릴리스 노트, 확인 시각, 상태)는 Valkey `update:state`에 보관합니다. 릴리스 노트는 최대 4000자의 일반 텍스트로만 저장하고 표시하며 HTML이나 Markdown으로 렌더링하지 않습니다.

### 15.2 업데이트 확인 끄기
`.env`에 `UPDATE_CHECK=off`를 쓰고 `docker compose up -d`로 API를 다시 만듭니다. 이후 API는 외부로 어떤 요청도 보내지 않으며 콘솔에는 "업데이트 확인이 꺼져 있어요"가 표시됩니다. `update.sh`는 운영자가 직접 실행할 때만 GitHub에 접속하므로 이 설정과 상관없습니다.

### 15.3 관리 콘솔
관리 콘솔(관리자 토큰 필요)의 **업데이트** 탭에서 설치된 버전과 최신 릴리스, 출시일, 릴리스 노트, 릴리스 페이지 링크(새 탭), "지금 확인" 버튼, 서버에서 실행할 명령, 자동 업데이트 상태와 마지막 실행 결과를 봅니다. 새 버전이 있으면 탭 이름 옆에 "새 버전" 배지가 붙습니다. 관리자가 아닌 사용자에게는 업데이트 관련 정보가 보이지 않으며, 공개된 것은 `GET /api/version`의 현재 버전 번호뿐입니다.

API는 `/api/admin/update`(조회)와 `/api/admin/update/check`(즉시 확인, 1분에 한 번)를 제공합니다. 자동 업데이트 상태는 `update.sh`가 쓰는 `state/update.json`을 API 컨테이너에 읽기 전용으로 연결(`./state:/gachipad-state:ro`)해서 보여 줍니다. 어떤 컨테이너도 Docker 소켓에 접근하지 않으므로 콘솔에서 업데이트를 실행할 수는 없습니다.

열려 있는 브라우저 탭은 서버의 `/api/version`이 자기 빌드와 다르면 "새 버전이 있어요 · 새로고침" 알림을 띄웁니다(탭을 열 때, 다시 볼 때, 30분마다, 실시간 연결이 다시 붙을 때 확인). 새로고침을 누른 탭만 다시 불러오며, 다른 탭은 그대로 유지됩니다. 승인한 탭도 열려 있는 문서의 미전송 변경을 서버가 확인할 때까지 기다리고, 5초 안에 확인되지 않으면 새로고침하지 않습니다. 연결을 복구한 뒤 다시 시도하십시오. "나중에"를 누르면 다음 버전이 나올 때까지 숨깁니다. 다른 탭의 승인으로 서비스 워커가 교체되거나 이전 lazy chunk 로드가 실패하면 다시 알립니다. 탭별 새로고침 승인은 30초 뒤 만료됩니다.

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
1. 설치 단위 공통 잠금을 취득한 뒤 현재 버전을 읽고 대상 릴리스를 고릅니다. `stable`은 draft와 prerelease 플래그 또는 접미사가 있는 버전을 제외합니다. JSON 파싱에는 호스트의 Node, Python3, jq 순으로 사용하고, 없으면 **현재 설치된 API 이미지의 Node**를 일회성 컨테이너로 사용합니다(`--pull never`). 이미지가 없으면 파서 오류와 복구 방법을 표시하며, 오프라인 번들은 먼저 load한 후보 API 이미지를 사용합니다.
2. 릴리스의 `SHA256SUMS`와 배포 파일 `gachipad-deploy-<버전>.tar.gz`를 받고 외부·내부 체크섬을 확인합니다. 새 파일·설정은 임시 폴더에서 준비합니다. MongoDB 이미지가 달라지면(주 버전뿐 아니라 모든 이미지 변경) 지원되는 별도 마이그레이션 경로가 필요하므로 백업·서비스 중지 전에 거절합니다.
3. 설치 파일을 바꾸지 않은 채 새 이미지를 모두 pull하고 `IMAGES`의 digest와 비교합니다. 다운로드·검증 중에는 기존 서버가 계속 쓰기를 받습니다. 실패하면 서비스는 그대로 유지됩니다.
4. 마지막 DB 백업 크기의 2배 이상 여유 공간이 있는지 확인합니다(첫 백업 전에는 비교 기준이 없습니다). 현재 파일·`.env`·문서·TLS 설정을 API에 마운트되지 않는 `rollback/`에 보관하고 `state/transaction`에 대상·단계·백업 경로를 기록한 뒤 maintenance에 들어갑니다. 기존 스냅샷은 `rollback.previous.<시각>.<PID>/`로 보존합니다. Caddy를 먼저 멈추고 API·Collab을 정지합니다. Collab의 SIGTERM flush 및 API·Collab의 정상 종료를 기다린 뒤 `backup.sh`로 백업하고 gzip 무결성을 확인하므로 다운로드 중 받은 쓰기와 종료 직전 편집도 백업에 들어갑니다.
5. 파일·설정을 교체하고 새 앱을 기동합니다. Caddy는 정지한 채 컨테이너 내부 `/healthz`·`/readyz`의 2xx 응답을 확인합니다(`UPDATE_HEALTH_TIMEOUT`, 기본 180초; 각 요청도 남은 시간으로 제한). 검증 후 ingress를 엽니다.
6. 검증 전 파일 복사·rename 오류나 HUP/INT/TERM, 기동 실패는 자동 복구로 이어집니다(15.7). 앱 검증을 통과한 뒤 ingress 활성화가 실패하면 이미 승인된 쓰기를 보존하기 위해 현재 파일·DB를 유지하고 쓰기를 닫은 채 `failed`로 기록합니다. 로그를 확인한 뒤 `docker compose up -d`로 재개합니다. SIGKILL·전원 차단처럼 trap이 실행되지 못한 경우에는 `state/transaction`, `state/update.json`, `rollback/`을 확인하고 수동 복구합니다. 미완료 transaction이 있으면 버전이 같더라도 다음 업데이트를 거절하며 스냅샷을 덮어쓰지 않습니다.

모든 실행은 `state/update.log`(1 MiB에서 교체, 이전 파일 3개 보관)에 남고, 결과는 `state/update.json`에 기록되어 콘솔에 표시됩니다. 비밀값은 명령행 인자로 전달하지 않으며, GHCR 공개 이미지는 로그인 없이 받습니다. 복구가 끝난 뒤 상태 파일 기록이 실패해도 서비스는 유지되며 잠금은 해제됩니다. `rollback/`과 `rollback.previous.*`에는 `.env`·TLS 개인 키가 있으므로 설치 폴더 접근 권한을 제한하고 보관 정책에 따라 정리하십시오. 구버전의 `state/rollback/`도 다음 업데이트에서 `rollback.legacy.*`로 옮깁니다. 이전 버전의 이미지는 되돌리기를 위해 남겨 두므로 여유 공간이 부족하면 확인 후 `docker image prune`으로 정리하십시오.

### 15.5 오프라인 업데이트 (인터넷이 없는 서버)
인터넷이 되는 컴퓨터에서 [릴리스 페이지](https://github.com/kim0040/gachipad/releases)의 번들(`gachipad-<버전>-linux-amd64.tar.gz` 또는 `-linux-arm64.tar.gz`)과 릴리스의 `SHA256SUMS` 파일을 받아 서버의 설치 폴더 옆에 복사한 뒤 실행합니다.
```sh
./upgrade.sh ../gachipad-<버전>-linux-amd64.tar.gz
./update.sh --bundle ../gachipad-<버전>-linux-amd64.tar.gz    # 같은 잠금·검증·복구 경로
```
`upgrade.sh`와 `update.sh --bundle`은 같은 업데이트 엔진을 사용합니다. 번들 옆의 `<번들>.sha256` 또는 릴리스 `SHA256SUMS`를 확인하고 내부 체크섬으로 `images.tar`를 검증합니다. 이미지를 먼저 load한 뒤 온라인과 같은 maintenance·백업·자동 복구를 수행합니다. Docker load는 registry digest를 보존하지 않으므로 오프라인 무결성 검증은 아카이브·내용 체크섬을 사용합니다. 주 버전 변경에는 `--allow-major`가 필요합니다. 추출된 `images.tar`는 후보 폴더에 다시 복사하지 않습니다. 임시 공간이 작으면 `TMPDIR=/충분한/공간 ./upgrade.sh ...`로 번들 추출 위치를 지정하십시오.

`update.sh`가 없던 구버전의 `upgrade.sh`는 복사할 파일 목록이 고정되어 있습니다. 이 버전으로 처음 전환한 뒤에는 체크섬을 검증한 **방금 설치한 동일 버전** 번들을 별도 폴더에 추출하여 `update.sh`를 설치 폴더에 복사하고 실행 권한을 주십시오. 이후부터 온라인·오프라인 업데이트를 같은 엔진으로 실행할 수 있습니다. 새 `generate-secrets.sh`는 Docker가 상태 마운트를 root 소유로 만들기 전에 운영자 소유의 `state/`를 준비합니다.

### 15.6 자동 업데이트 (선택, 기본 꺼짐)
```sh
sudo ./update.sh --enable-auto --at 04:00 --policy patch     # 켜기
sudo ./update.sh --enable-auto --dry-run                     # 무엇을 설치할지 보기만
sudo ./update.sh --disable-auto                              # 끄기
```
- systemd 서비스는 `KillMode=mixed`, `TimeoutStopSec=30min`으로 복구 중 자식 프로세스를 보존하며, Docker보다 뒤에 시작하여 종료 시 Docker보다 먼저 멈춥니다. 복구 중 추가 HUP/INT/TERM은 무시합니다. 대형 DB에서 복구가 30분을 넘으면 서비스 override로 stop timeout을 늘리십시오.
- systemd가 있으면 `/etc/systemd/system/gachipad-update.service`와 `.timer`(매일 `--at` 시각, 최대 15분 무작위 지연, 꺼져 있던 동안 놓친 실행은 켜질 때 한 번)를 설치하고, 없으면 현재 사용자의 crontab에 한 줄을 추가합니다. 한 호스트에 설치 하나를 기준으로 합니다.
- 자동 업데이트 설치 경로는 영문자·숫자·`/ . _ -`만 허용합니다. 공백·작은따옴표·`%` 등이 있는 경로는 systemd/cron 파일을 쓰기 전에 거절합니다.
- 타이머는 `./update.sh --auto`를 실행합니다. 정책에 맞는 릴리스만 적용하며, 주 버전이 바뀌는 업데이트는 정책과 상관없이 자동으로 적용하지 않습니다.
  - `patch`(기본값): 같은 `x.y`의 버그 수정 릴리스만(1.2.0 → 1.2.3).
  - `minor`: 같은 주 버전의 기능 릴리스까지(1.2.0 → 1.5.1).
- 업데이트 순서와 되돌리기는 수동 업데이트와 같고, 결과는 콘솔의 "자동 업데이트"에 표시됩니다. 사용자가 적은 시간대를 고르십시오. 재시작하는 동안 실시간 편집은 잠시 끊겼다가 자동으로 다시 연결됩니다.

### 15.7 되돌리기 (롤백)
- 자동: ingress와 실패한 API·Collab을 먼저 멈추고 이전 파일을 복구합니다. 새 앱 기동을 시도했다면 **DB 인프라만 먼저 시작하여 백업을 복원한 뒤** 이전 앱을 기동합니다. 복원은 호스트 `gzip -t`와 Mongo `mongorestore --dryRun`을 모두 통과하고 현재 DB의 안전 백업을 `backups/`에 추가한 뒤에만 DB를 삭제합니다. 안전 백업이 실패하면 삭제하지 않습니다. 새 릴리스가 추가한 collection도 지우고 백업의 DB를 되살립니다. 파일 교체 중 실패처럼 새 앱이 DB에 접근하기 전이면 DB 복원은 생략합니다. 이전 앱의 health/readiness 검증 후에만 ingress를 엽니다. 성공한 복구는 `rolled-back`, 복구 실패는 `failed`와 복구 지침으로 기록되며 종료 코드는 1입니다.
- 수동: API·Collab·Caddy를 먼저 멈추고 `rollback/`의 파일을 설치 폴더로 복사합니다(`.env`, `docs`, `tls` 포함). 앱을 먼저 기동하지 말고 `./restore.sh backups/<업데이트 직전 백업> --yes`를 실행합니다. 이 명령은 비정상 종료·OOM 상태의 API·Collab도 정지시키고 공통 잠금 아래 백업 검증·현재 DB 안전 백업 → DB 복원 → 앱 검증 → ingress 개방 순서로 동작합니다. 복구와 실제 readiness를 확인한 뒤에만 `state/transaction`을 제거하고 업데이트를 재시도하십시오.
- 온라인·오프라인 업데이트, 자동 타이머, backup/restore는 같은 설치 잠금을 사용합니다. `flock`이 없으면 atomic mkdir(`state/install.lock.d`)로 잠급니다. `flock` 획득 후 `owner` PID가 죽었거나 이전 부팅의 잠금임을 확인하면 자동 회수합니다. `flock` 없는 mkdir fallback에서 SIGKILL 뒤 남은 잠금은 `owner` PID와 실제 프로세스를 확인한 뒤에만 제거합니다. 복구가 실패하면 ingress를 닫은 채 `rollback/`, `state/transaction`, 백업과 로그를 보존합니다.

현재 한계: commit 직후 신호가 오면 서비스가 정상이어도 콘솔의 마지막 상태가 maintenance로 남을 수 있으므로 실제 readiness와 로그를 확인하십시오. `+build` 메타데이터가 붙은 릴리스 태그는 다운로드 대상에서 메타데이터가 빠져 안전하게 실패할 수 있으므로 배포 태그에 사용하지 마십시오. Valkey의 조인 코드·grant·ban 등은 롤백하지 않으므로 키 형식 변경은 이전 앱과 호환되어야 합니다.

### 15.8 릴리스 확인과 출처 증명
릴리스의 모든 파일과 GHCR 이미지에는 GitHub의 빌드 출처 증명이 붙습니다. GitHub CLI로 확인할 수 있습니다(인터넷 필요).
```sh
gh attestation verify gachipad-<버전>-linux-amd64.tar.gz --repo kim0040/gachipad
gh attestation verify oci://ghcr.io/kim0040/gachipad-api:<버전> --repo kim0040/gachipad
```
`SHA256SUMS`와 `.sha256`은 손상과 바뀐 파일을 찾아내지만 서명은 아닙니다. HTTPS로 GitHub에서 직접 받거나 출처 증명을 확인하십시오.

### 15.9 프록시
서버가 프록시를 거쳐야 인터넷에 나갈 수 있으면 `.env`에 `HTTPS_PROXY=http://프록시:포트`를 씁니다. Compose가 이 값과 `NODE_USE_ENV_PROXY=1`을 API 컨테이너에 전달합니다(Node 22의 `fetch`는 이 설정이 있어야 `HTTPS_PROXY`를 사용합니다). OIDC 로그인처럼 API가 내부 서버에 접속하는 경우가 있으면 그 호스트를 `NO_PROXY`에 넣으십시오. `update.sh`는 `curl`을 사용하므로 실행하는 셸의 `HTTPS_PROXY`를 따릅니다. 이미지 다운로드는 Docker 데몬의 프록시 설정을 따릅니다.

### 15.10 비용
- GitHub 릴리스(파일 보관과 다운로드), GHCR의 공개 패키지(저장과 전송), 공개 저장소의 GitHub Actions 실행과 빌드 출처 증명, 인증 없는 GitHub REST API는 모두 무료입니다. 인증 없는 API는 IP당 시간당 60회로 제한되며 gachipad의 확인 주기(12시간)는 이 한도보다 훨씬 적습니다.
- 유료 서비스나 계정, 토큰이 필요하지 않습니다. 자동 업데이트도 서버 자신의 systemd 타이머 또는 cron으로 동작합니다.

### 15.11 소스에서 설치한 경우
저장소에서 직접 실행하는 설치(`deploy/`에서 `docker compose`)는 `update.sh`가 저장소 파일을 덮어쓰지 않도록 거절합니다. 다음 중 하나를 사용합니다.
```sh
git pull && docker compose build && docker compose up -d     # 소스에서 다시 빌드
docker compose pull && docker compose up -d                  # .env의 GACHIPAD_VERSION 릴리스 이미지를 받아 실행
```

---

<a id="codesh에서-gachipad로-이름-변경-10x에서-업그레이드"></a>
<a id="16-codesh에서-gachipad로-이름-변경-10x에서-업그레이드"></a>
## 16. codesh에서 gachipad로 이름 변경 (1.0.x에서 업그레이드)

제품 이름이 codesh에서 gachipad로 변경되었어요. 기존 1.0.x 설치 환경을 최신 버전으로 업그레이드할 때 운영자가 알아두어야 할 사항을 안내해요.

### 16.1 일반 업그레이드 시 주의사항
기존 1.0.x 환경에서 `./update.sh` 또는 `./upgrade.sh`를 실행해 정상 업그레이드하는 경우, 운영자가 수동으로 데이터를 마이그레이션할 필요는 없어요.
- **데이터 및 볼륨 보존**: 기존 데이터 볼륨, MongoDB 데이터베이스 이름(`codesh`), 데이터베이스 애플리케이션 사용자(`codesh_app`), Docker Compose 프로젝트 이름(`codesh`), 기존 시크릿은 해당 설치에 고정(pinned)되어 그대로 유지돼요.
- **서비스 중단 없는 전환**: 데이터베이스나 볼륨 이름을 강제로 바꾸지 않으므로 데이터 유실이나 분실 위험 없이 안전하게 업그레이드돼요.

### 16.2 눈에 띄는 변경 사항
업그레이드 후 다음과 같은 항목들이 변경되어 나타나요:
- **`.env` 환경 변수**: `./update.sh`나 `./generate-secrets.sh` 실행 시 기존 `CODESH_*` 환경 변수는 `# migrated to GACHIPAD_*: CODESH_...` 형태로 주석 처리되고, 동일한 설정이 신규 `GACHIPAD_*` 키로 자동 마이그레이션돼요.
- **systemd 유닛 및 cron 태그**: 기존에 자동 업데이트가 켜져 있던 환경은 기존 이름(`codesh-update.service`, `codesh-update.timer` 또는 crontab의 `# codesh-update` 태그)이 그대로 유지되어 스케줄 연속성이 보장돼요. 신규 설치는 `gachipad-update` 유닛을 사용해요.
- **mDNS 로컬 주소**: 기존 `codesh.local` 주소가 레거시 별칭으로 계속 응답하며, 신규 기본 주소인 `gachipad.local`이 함께 응답해요. 기존 북마크나 바로가기를 그대로 사용할 수 있어요.
- **Prometheus 메트릭 이름**: `codesh_*` 접두사로 제공되던 모든 메트릭이 `gachipad_*` 접두사로 변경되었어요(예: `gachipad_http_request_duration_seconds`, `gachipad_collab_connections` 등). Prometheus 수집 설정, 대시보드(Grafana 등), 알림 규칙(alert rules)을 운영 중이라면 새 메트릭 이름으로 쿼리를 업데이트해야 해요.

### 16.3 운영자의 조치가 필요한 경우
다음 특정 환경에서는 업그레이드 전후 운영자의 수동 조치가 필요해요:
- **내부 레지스트리 미러 운영**: 인터넷이 분리된 내부 네트워크에서 자체 Docker 레지스트리 미러를 사용하는 경우, 대상 버전의 `gachipad-*` 이미지(`gachipad-web`, `gachipad-api`, `gachipad-collab`, `gachipad-mdns`)를 미러에 미리 올려 두어야 해요.
- **셸 환경 변수 `CODESH_REGISTRY`**: 레지스트리를 `.env`에 적지 않고 셸에서 `export CODESH_REGISTRY=...`로만 넘기던 경우, 1.0.x 업데이터가 새 버전을 준비할 때 Compose가 그 값을 보지 못해 기본 레지스트리에서 이미지를 받으려 해요(이미지를 받는 단계에서 멈추고, 실행 중인 서비스는 그대로예요). 업데이트 전에 `.env`에 `GACHIPAD_REGISTRY=...`를 적어 두세요.
- **소스 체크아웃 설치**: git 저장소를 직접 clone하여 운영하는 환경이라면, `git pull` 이후 `docker compose build && docker compose up -d`를 실행하기 전에 반드시 `./generate-secrets.sh .env`를 한 번 실행해야 해요. 이를 통해 신규 `GACHIPAD_*` 환경 변수와 필수 `MONGO_APP_PASSWORD`가 올바르게 생성돼요.
- **운영자 자체 TLS 인증서**: `tls/*.caddy`에 `tls internal`(Caddy 내장 로컬 CA)이 있으면 업그레이드할 때 `gachipad.local` 별칭이 자동으로 추가돼요. 하지만 자체 발급 인증서(`tls <cert> <key>`)를 사용하는 경우, `.env`의 `SITE_ALIASES=, gachipad.local`(쉼표 뒤 공백 포함)을 적용하기 전에 인증서의 SAN(Subject Alternative Name)에 `gachipad.local`이 포함되어 있는지 먼저 확인하고 갱신해야 해요.
- **신규 설치 거절 가드와 `GACHIPAD_NEW_INSTALL=1`**: 기존 설치 데이터를 덮어쓰거나 고아 볼륨으로 방치하는 사고를 방지하기 위해, `install.sh`는 현재 디렉터리에 `.env`가 없는데 기존 Docker 볼륨 `codesh_mongo-data`가 존재하면 설치를 거절해요. 기존 설치를 업그레이드하려면 기존 `.env`를 복사해 온 뒤 `./generate-secrets.sh .env`를 실행해야 해요. 이전 볼륨을 무시하고 해당 호스트에 완전히 새로운 별도 스택을 설치하려는 경우에만 `GACHIPAD_NEW_INSTALL=1 ./install.sh`를 지정해서 실행해요.

### 16.4 레거시 호환성 유지 정책
운영과 연동의 연속성을 위해 레거시 이름 호환성은 **2.0 릴리스까지** 계속 유지돼요:
- `codesh` CLI 명령: 폐기 경고(stderr: `codesh is deprecated; use gachipad`)를 출력하고 `gachipad` 명령으로 안전하게 전달돼요.
- 세션 쿠키: 클라이언트 요청에 `gachipad_sid`가 없으면 `codesh_sid`를 fallback으로 인식하며, 응답 시 `gachipad_sid`를 발급해요.
- CSRF 헤더: `X-Gachipad` 헤더 외에 기존 `X-Codesh` 헤더도 계속 허용해요.
- 백업 복원: `restore.sh`는 아카이브 내부 경로 구조를 자동 감지하여 codesh 형식 백업과 gachipad 형식 백업을 모두 투명하게 복원해요.


