#!/usr/bin/env bash
#
# bringup-test-network.sh
#
# Menghidupkan Hyperledger Fabric memakai fabric-samples "test-network",
# mendepoy chaincode procurement-ledger milik repo ini ke channel
# procurementchannel, lalu menulis blockchain/fabric-bridge/.env dengan
# path crypto-material yang benar.
#
# Jalankan di VPS Linux (Ubuntu 22.04+ / Debian 12+).
# Prasyarat: docker, docker compose plugin, git, curl, jq, node >= 20.6, npm.
#
# Pemakaian:
#   bash blockchain/fabric-bridge/scripts/bringup-test-network.sh
#
# Override opsional:
#   WORKDIR=$HOME/fabric              # lokasi fabric-samples
#   FABRIC_SAMPLES_REF=main           # branch/commit fabric-samples
#   CHANNEL_NAME=procurementchannel
#   CHAINCODE_NAME=procurement-ledger
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHAINCODE_SRC="$(cd "$BRIDGE_DIR/../chaincode" && pwd)"

FABRIC_SAMPLES_REF="${FABRIC_SAMPLES_REF:-main}"
CHANNEL_NAME="${CHANNEL_NAME:-procurementchannel}"
CHAINCODE_NAME="${CHAINCODE_NAME:-procurement-ledger}"
WORKDIR="${WORKDIR:-$HOME/fabric}"

SAMPLES_DIR="$WORKDIR/fabric-samples"
NETWORK_DIR="$SAMPLES_DIR/test-network"
CC_DEST="$SAMPLES_DIR/chaincode/$CHAINCODE_NAME"

ORG_DOMAIN="org1.example.com"
ORG_MSP_ID="Org1MSP"
PEER_HOST="peer0.$ORG_DOMAIN"
PEER_ENDPOINT="localhost:7051"
BRIDGE_PORT="8080"

ORG_DIR="$NETWORK_DIR/organizations/peerOrganizations/$ORG_DOMAIN"
ADMIN_MSP="$ORG_DIR/users/Admin@$ORG_DOMAIN/msp"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
log "1/9 Memeriksa prasyarat"
# ---------------------------------------------------------------------------
for cmd in git curl jq docker node npm; do
  command -v "$cmd" >/dev/null 2>&1 || fail "perintah '$cmd' tidak ditemukan."
done
docker compose version >/dev/null 2>&1 || fail "docker compose plugin tidak tersedia."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<20||(a===20&&b<6)){console.error("Node >= 20.6 dibutuhkan (untuk --env-file), terdeteksi "+process.versions.node);process.exit(1)}'
[ -d "$CHAINCODE_SRC" ] || fail "folder chaincode tidak ditemukan: $CHAINCODE_SRC"

# ---------------------------------------------------------------------------
log "2/9 Menyiapkan fabric-samples ($FABRIC_SAMPLES_REF) di $SAMPLES_DIR"
# ---------------------------------------------------------------------------
mkdir -p "$WORKDIR"
if [ -d "$SAMPLES_DIR/.git" ]; then
  git -C "$SAMPLES_DIR" fetch --depth 1 origin "$FABRIC_SAMPLES_REF"
  git -C "$SAMPLES_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$FABRIC_SAMPLES_REF" \
    https://github.com/hyperledger/fabric-samples.git "$SAMPLES_DIR"
fi

# ---------------------------------------------------------------------------
log "3/9 Mengunduh binary CLI + image Docker Fabric"
# ---------------------------------------------------------------------------
# Versi dibiarkan default agar selalu cocok dengan checkout fabric-samples.
( cd "$SAMPLES_DIR" && ./install-fabric.sh binary docker )

# ---------------------------------------------------------------------------
log "4/9 Menyalin chaincode dan build TypeScript"
# ---------------------------------------------------------------------------
rm -rf "$CC_DEST"
mkdir -p "$CC_DEST"
cp -R "$CHAINCODE_SRC/." "$CC_DEST/"
rm -rf "$CC_DEST/node_modules" "$CC_DEST/dist"
( cd "$CC_DEST" && npm install --silent && npm run build )
[ -f "$CC_DEST/dist/index.js" ] || fail "build chaincode gagal: dist/index.js tidak terbentuk"

# ---------------------------------------------------------------------------
log "5/9 Menghidupkan jaringan + channel '$CHANNEL_NAME'"
# ---------------------------------------------------------------------------
( cd "$NETWORK_DIR" && ./network.sh down >/dev/null 2>&1 || true )
( cd "$NETWORK_DIR" && ./network.sh up createChannel -c "$CHANNEL_NAME" -ca )

# ---------------------------------------------------------------------------
log "6/9 Mendepoy chaincode '$CHAINCODE_NAME'"
# ---------------------------------------------------------------------------
( cd "$NETWORK_DIR" && ./network.sh deployCC \
    -c "$CHANNEL_NAME" \
    -ccn "$CHAINCODE_NAME" \
    -ccp "../chaincode/$CHAINCODE_NAME" \
    -ccl typescript )

# ---------------------------------------------------------------------------
log "7/9 Menyusun $BRIDGE_DIR/.env"
# ---------------------------------------------------------------------------
# Nama berkas cert/key berbeda antara mode CA (cert.pem + <serial>_sk) dan
# cryptogen (<identity>-cert.pem + priv_sk). Jadi dicari lewat glob.
CERT_PATH="$(find "$ADMIN_MSP/signcerts" -maxdepth 1 -type f -name '*.pem' | head -n1 || true)"
KEY_PATH="$(find "$ADMIN_MSP/keystore" -maxdepth 1 -type f | head -n1 || true)"
TLS_CERT_PATH="$ORG_DIR/peers/$PEER_HOST/tls/ca.crt"

[ -n "$CERT_PATH" ] || fail "cert Admin tidak ditemukan di $ADMIN_MSP/signcerts"
[ -n "$KEY_PATH" ] || fail "private key Admin tidak ditemukan di $ADMIN_MSP/keystore"
[ -f "$TLS_CERT_PATH" ] || fail "TLS CA peer tidak ditemukan di $TLS_CERT_PATH"

EXISTING_TOKEN=""
if [ -f "$BRIDGE_DIR/.env" ]; then
  EXISTING_TOKEN="$(grep -E '^BRIDGE_TOKEN=' "$BRIDGE_DIR/.env" | head -n1 | cut -d= -f2- | tr -d '"' || true)"
fi
BRIDGE_TOKEN="${EXISTING_TOKEN:-$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')}"
[ -n "$BRIDGE_TOKEN" ] || fail "gagal membuat BRIDGE_TOKEN"

cat > "$BRIDGE_DIR/.env" <<EOF
# Dibuat otomatis oleh scripts/bringup-test-network.sh
BRIDGE_HOST="0.0.0.0"
BRIDGE_PORT=$BRIDGE_PORT
BRIDGE_TOKEN="$BRIDGE_TOKEN"

FABRIC_CHANNEL="$CHANNEL_NAME"
FABRIC_CHAINCODE="$CHAINCODE_NAME"
FABRIC_MSP_ID="$ORG_MSP_ID"
FABRIC_PEER_ENDPOINT="$PEER_ENDPOINT"
FABRIC_PEER_HOST_OVERRIDE="$PEER_HOST"
FABRIC_CERT_PATH="$CERT_PATH"
FABRIC_KEY_PATH="$KEY_PATH"
FABRIC_TLS_CERT_PATH="$TLS_CERT_PATH"
EOF
chmod 600 "$BRIDGE_DIR/.env"

# ---------------------------------------------------------------------------
log "8/9 Memasang dependency bridge"
# ---------------------------------------------------------------------------
( cd "$BRIDGE_DIR" && npm install --silent )

# ---------------------------------------------------------------------------
log "9/9 Verifikasi bridge"
# ---------------------------------------------------------------------------
node --env-file="$BRIDGE_DIR/.env" "$BRIDGE_DIR/src/server.js" >"$WORKDIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
HEALTH=""
for _ in $(seq 1 20); do
  HEALTH="$(curl -fsS "http://127.0.0.1:$BRIDGE_PORT/v1/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true

if [ -z "$HEALTH" ]; then
  printf '\033[1;31mBridge tidak menjawab. Log terakhir:\033[0m\n'
  tail -n 30 "$WORKDIR/bridge.log" >&2 || true
  exit 1
fi

printf '%s\n' "$HEALTH"
case "$HEALTH" in
  *'"status":"connected"'*) printf '\033[1;32mOK: bridge terhubung ke Fabric.\033[0m\n' ;;
  *) printf '\033[1;31mBridge jalan tapi belum terhubung ke Fabric. Log:\033[0m\n'; tail -n 30 "$WORKDIR/bridge.log" >&2 ;;
esac

echo
cat <<EOF
------------------------------------------------------------------
Selesai. Langkah berikutnya di VPS:

  cd "$BRIDGE_DIR"
  npm start          # menjalankan bridge di port $BRIDGE_PORT
  curl -s localhost:$BRIDGE_PORT/v1/health

Jalankan permanen (contoh systemd), atau:

  nohup npm start >$WORKDIR/bridge.log 2>&1 &

Lalu isi environment variable di Vercel:

  BLOCKCHAIN_PROVIDER=remote
  FABRIC_BRIDGE_URL=https://<domain-bridge-anda>
  FABRIC_BRIDGE_TOKEN=$BRIDGE_TOKEN

Catatan: bridge berjalan sebagai HTTP polos, jadi wajib di-proxy
Caddy/nginx untuk TLS sebelum dipanggil dari Vercel.
------------------------------------------------------------------
EOF
