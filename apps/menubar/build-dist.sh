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
# The daemon resolves the launcher as ../bin/tf-claude relative to itself, so
# this path is not a preference -- it is what Resources/companion/cli.js will
# look for at runtime.
LAUNCHER_DIR="${APP_DIR}/Contents/Resources/bin"
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

STATUSLINE_ENTRY="${ROOT}/apps/companion/dist/statusline.js"
if [[ ! -f "${STATUSLINE_ENTRY}" ]]; then
  echo "error: ${STATUSLINE_ENTRY} missing after build" >&2
  exit 1
fi

LAUNCHER_SRC="${ROOT}/apps/companion/bin"
# tf_paths.py is imported by tf-claude at startup: a bundle without it has a
# launcher that exits before it ever reaches Claude Code.
for f in tf-claude tf_draft.py tf_paths.py; do
  if [[ ! -f "${LAUNCHER_SRC}/${f}" ]]; then
    echo "error: ${LAUNCHER_SRC}/${f} missing; the shipped app would write a dead claude() into every recipient's shell" >&2
    exit 1
  fi
done

find_esbuild() {
  # pnpm hoists nothing to the workspace root, so the extension's copy is the
  # one that actually exists; the .pnpm store is the fallback.
  local candidates=(
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

echo "==> bundling the status line into Resources/companion"
"${ESBUILD}" "${STATUSLINE_ENTRY}" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --external:node:\* \
  --log-level=warning \
  --outfile="${COMPANION_DIR}/statusline.js"

# The launchers are Python scripts the two CLIs are started through; without
# them the draft forecast -- the whole point of the app -- silently never
# fires, and for Codex there is no bar at all: it has no status-line hook, so
# tf-codex is the only thing that can paint one.
echo "==> copying the launchers into Resources/bin"
rm -rf "${LAUNCHER_DIR}"
mkdir -p "${LAUNCHER_DIR}"
cp "${LAUNCHER_SRC}/tf-claude" "${LAUNCHER_SRC}/tf-codex" \
   "${LAUNCHER_SRC}/tf_wrap.py" "${LAUNCHER_SRC}/tf_reserve.py" "${LAUNCHER_SRC}/tf_bar.py" \
   "${LAUNCHER_SRC}/tf_draft.py" "${LAUNCHER_SRC}/tf_paths.py" "${LAUNCHER_DIR}/"
chmod +x "${LAUNCHER_DIR}/tf-claude" "${LAUNCHER_DIR}/tf-codex"

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
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "error: node not found on PATH. Install Node 22+ and re-run." >&2
  exit 1
fi
PROOF_DIR="$(mktemp -d /tmp/tf-dist-test.XXXXXX)"
( cd /tmp && "${NODE_BIN}" --no-warnings "${COMPANION_DIR}/cli.js" status --data-dir "${PROOF_DIR}" ) \
  || { echo "error: bundled daemon failed to run from /tmp" >&2; exit 1; }
rm -rf "${PROOF_DIR}"

# The launcher path the daemon computes at runtime, asserted here rather than
# discovered by a colleague whose draft forecast quietly does nothing.
for program in tf-claude tf-codex; do
  RESOLVED_LAUNCHER="${COMPANION_DIR}/../bin/${program}"
  [[ -x "${RESOLVED_LAUNCHER}" ]] \
    || { echo "error: ${RESOLVED_LAUNCHER} is not executable; the daemon would write a dead alias" >&2; exit 1; }
done
# Imports, not just presence: the launchers pull in five modules beside them,
# and a missing one fails at the moment someone types `claude`, not here.
"${PYTHON_BIN:-python3}" -c "import sys; sys.path.insert(0, '${LAUNCHER_DIR}'); import tf_wrap, tf_reserve, tf_bar, tf_draft, tf_paths" \
  || { echo "error: the bundled launchers cannot import their own modules" >&2; exit 1; }
# tf-codex renders through the bundled status line, which lives one directory
# over from the launcher rather than in dist/ -- a layout only this build has.
"${PYTHON_BIN:-python3}" -c "import sys; sys.path.insert(0, '${LAUNCHER_DIR}'); import tf_bar; assert tf_bar.find_statusline(), 'tf-codex cannot find statusline.js in the bundle'" \
  || { echo "error: the bundled tf-codex would draw no bar" >&2; exit 1; }
[[ -f "${COMPANION_DIR}/statusline.js" ]] \
  || { echo "error: statusline.js missing from the bundle" >&2; exit 1; }
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
