#!/usr/bin/env bash
# Produces a self-contained, shareable TokenForecaster.app + zip.
#
#   apps/menubar/.build/TokenForecaster.app   ad-hoc signed, daemon bundled
#   apps/menubar/.build/TokenForecaster.zip   what you send to a colleague
#
# The daemon is bundled as a SINGLE esbuild file so it does not depend on the
# workspace's pnpm symlink farm. Requires only Node 22+ on the target machine.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
cd "${HERE}"

APP_NAME="TokenForecaster"
APP_DIR="${HERE}/.build/${APP_NAME}.app"
COMPANION_DIR="${APP_DIR}/Contents/Resources/companion"
ZIP_PATH="${HERE}/.build/${APP_NAME}.zip"

# ---------------------------------------------------------------- node side --
echo "==> building the workspace (pnpm)"
( cd "${ROOT}" && pnpm -w build )
# The root `build` script only covers packages/*; the daemon needs its own pass.
( cd "${ROOT}" && pnpm --filter @token-forecaster/companion build )

CLI_ENTRY="${ROOT}/apps/companion/dist/cli.js"
if [[ ! -f "${CLI_ENTRY}" ]]; then
  echo "error: ${CLI_ENTRY} missing after build" >&2
  exit 1
fi

find_esbuild() {
  local candidates=(
    "${ROOT}/node_modules/.bin/esbuild"
    "${ROOT}/apps/extension/node_modules/.bin/esbuild"
  )
  local c
  for c in "${candidates[@]}"; do
    [[ -x "${c}" ]] && { echo "${c}"; return 0; }
  done
  c="$(ls -d "${ROOT}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | head -n1 || true)"
  [[ -n "${c}" && -x "${c}" ]] && { echo "${c}"; return 0; }
  return 1
}

if ! ESBUILD="$(find_esbuild)"; then
  echo "error: esbuild not found in the workspace. Run 'pnpm install' first." >&2
  exit 1
fi
echo "==> esbuild: ${ESBUILD} ($("${ESBUILD}" --version))"

# ------------------------------------------------------------- the .app --
echo "==> building the menu bar app"
./build-app.sh

echo "==> bundling the companion daemon into Resources/companion"
rm -rf "${COMPANION_DIR}"
mkdir -p "${COMPANION_DIR}"
"${ESBUILD}" "${CLI_ENTRY}" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --external:node:\* \
  --log-level=warning \
  --outfile="${COMPANION_DIR}/cli.js"

# Node infers module type from the nearest package.json; be explicit.
cat > "${COMPANION_DIR}/package.json" <<'JSON'
{
  "name": "token-forecaster-companion-bundle",
  "private": true,
  "type": "module",
  "main": "cli.js"
}
JSON

# --------------------------------------------------------------- proof --
echo "==> verifying the bundle runs outside the repo"
NODE_BIN="$(command -v node)"
PROOF_DIR="$(mktemp -d /tmp/tf-dist-test.XXXXXX)"
( cd /tmp && "${NODE_BIN}" --no-warnings "${COMPANION_DIR}/cli.js" status --data-dir "${PROOF_DIR}" ) \
  || { echo "error: bundled daemon failed to run from /tmp" >&2; exit 1; }
rm -rf "${PROOF_DIR}"
echo "==> bundle OK"

# ------------------------------------------------------------ sign + zip --
echo "==> ad-hoc codesign (resources changed, so re-sign)"
codesign --force --deep --sign - "${APP_DIR}"
codesign --verify --deep --strict "${APP_DIR}" || {
  echo "error: codesign verification failed" >&2; exit 1; }

echo "==> zipping"
rm -f "${ZIP_PATH}"
ditto -c -k --keepParent "${APP_DIR}" "${ZIP_PATH}"

SIZE="$(du -h "${ZIP_PATH}" | cut -f1 | tr -d ' ')"
echo
echo "==> done"
echo "    ${ZIP_PATH}"
echo "    ${SIZE}"
