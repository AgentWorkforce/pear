#!/usr/bin/env sh
set -eu

REPO="${PEAR_RELEASE_REPO:-AgentWorkforce/pear}"
BASE_URL="${PEAR_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
APP_NAME="Pear"

info() {
  printf '%s\n' "$*"
}

fail() {
  printf 'pear installer: %s\n' "$*" >&2
  exit 1
}

download() {
  url="$1"
  output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "$output" "$url"
    return
  fi

  fail "curl or wget is required"
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64)
      printf 'x64'
      ;;
    arm64 | aarch64)
      printf 'arm64'
      ;;
    *)
      fail "unsupported CPU architecture: $(uname -m)"
      ;;
  esac
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

os="$(uname -s)"
arch="$(detect_arch)"

case "$os" in
  Darwin)
    artifact="${APP_NAME}-mac-universal.zip"
    zip_path="${tmp_dir}/${artifact}"
    url="${BASE_URL}/${artifact}"

    info "Downloading ${url}"
    download "$url" "$zip_path"

    unzip -q "$zip_path" -d "$tmp_dir"
    app_path="$(find "$tmp_dir" -maxdepth 3 -name "${APP_NAME}.app" -type d | head -n 1)"
    [ -n "$app_path" ] || fail "downloaded archive did not contain ${APP_NAME}.app"

    install_dir="${PEAR_INSTALL_DIR:-/Applications}"
    if [ ! -w "$install_dir" ]; then
      install_dir="${HOME}/Applications"
      mkdir -p "$install_dir"
    fi

    target="${install_dir}/${APP_NAME}.app"
    rm -rf "$target"
    ditto "$app_path" "$target"

    info "Installed ${APP_NAME} to ${target}"
    if command -v open >/dev/null 2>&1; then
      open "$target"
    fi
    ;;

  Linux)
    if [ "$arch" != "x64" ]; then
      fail "Linux ${arch} packages are not published yet"
    fi

    artifact="${APP_NAME}-linux-${arch}.AppImage"
    install_dir="${PEAR_INSTALL_DIR:-${HOME}/.local/bin}"
    target="${install_dir}/pear"
    url="${BASE_URL}/${artifact}"

    mkdir -p "$install_dir"
    info "Downloading ${url}"
    download "$url" "${tmp_dir}/pear.AppImage"
    chmod +x "${tmp_dir}/pear.AppImage"
    mv "${tmp_dir}/pear.AppImage" "$target"

    desktop_dir="${HOME}/.local/share/applications"
    mkdir -p "$desktop_dir"
    cat > "${desktop_dir}/pear.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pear
Comment=Electron GUI for Agent Relay
Exec=${target}
Terminal=false
Categories=Development;
EOF

    info "Installed ${APP_NAME} to ${target}"
    info "Run it with: ${target}"
    ;;

  *)
    fail "unsupported operating system: ${os}. On Windows, run https://pear.agentrelay.com/install.ps1 in PowerShell."
    ;;
esac
