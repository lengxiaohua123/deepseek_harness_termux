#!/usr/bin/env bash
# setup-termux.sh — 在全新 Termux (Android) 上一键搭好 DeepSeek Harness web。
# 幂等：可安全重复运行。所有修复/补丁/构建方式都固化在 adapt/android-termux 分支。
#
# 新手机一条命令：
#   curl -fsSL https://raw.githubusercontent.com/lengxiaohua123/deepseek_harness_termux/adapt/android-termux/scripts/setup-termux.sh | bash
set -euo pipefail

REPO_URL="https://github.com/lengxiaohua123/deepseek_harness_termux.git"
BRANCH="adapt/android-termux"
INSTALL_DIR="${DSH_INSTALL_DIR:-$HOME/workspace/deepseekharness/deepseek-harness}"
PNPM_VERSION="11.7.0"            # 与 package.json 的 packageManager 一致
SMOKE_PORT=3099
TMP_BASE="${TMPDIR:-/data/data/com.termux/files/usr/tmp}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m错误: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1/7 工具链 ──────────────────────────────────────────────
step "1/7 工具链"
command -v pkg >/dev/null || die "这不是 Termux（缺少 pkg 命令）"
need=()
command -v git       >/dev/null || need+=(git)
command -v node      >/dev/null || need+=(nodejs-lts)
command -v python3   >/dev/null || need+=(python)
command -v make      >/dev/null || need+=(make)
command -v clang     >/dev/null || need+=(clang)
command -v rg        >/dev/null || need+=(ripgrep)
command -v curl      >/dev/null || need+=(curl)
command -v tmux      >/dev/null || need+=(tmux)
command -v termux-wake-lock >/dev/null || need+=(termux-api)
[ ${#need[@]} -gt 0 ] && pkg install -y "${need[@]}"
command -v node >/dev/null || die "node 未安装"
major=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$(node -e 'console.log(process.versions.node.split(".")[1])')" -lt 19 ]; }; then
  die "需要 node ^22.19 或 >=24（当前 $(node --version)）；执行 pkg install nodejs-lts 或 pkg upgrade"
fi
command -v pnpm >/dev/null || npm install -g "pnpm@$PNPM_VERSION"
ok "node $(node --version) · pnpm $(pnpm --version)"

# ── 2/7 仓库 ─────────────────────────────────────────────────
step "2/7 仓库 → $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  ok "仓库已存在，跳过克隆"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
cur=$(git rev-parse --abbrev-ref HEAD)
if [ "$cur" != "$BRANCH" ]; then
  git checkout "$BRANCH" >/dev/null 2>&1 || die "无法切换到 $BRANCH"
fi
ok "分支 $BRANCH @ $(git rev-parse --short HEAD)"

# ── 3/7 依赖 ─────────────────────────────────────────────────
step "3/7 依赖（--ignore-scripts 必加：koffi 编译与 lefthook postinstall 在 Android 必失败）"
CI=true pnpm install --ignore-scripts   # CI=true: curl|bash 无 TTY 时 pnpm 可能要求确认清理 modules

# ── 4/7 原生模块 ─────────────────────────────────────────────
step "4/7 编译原生模块 koffi/node-pty（无 android-arm64 预编译产物）"
bash scripts/android-native-build.sh

# ── 5/7 构建 ─────────────────────────────────────────────────
step "5/7 构建 host 面（用 npm：pnpm run 会触发依赖自检→install→lefthook 失败）"
npm run build:lib:host

# ── 6/7 shell 快捷函数 ───────────────────────────────────────
step "6/7 配置 ~/.zshrc 快捷函数（dshstart/dshstop/dshstatus/dshattach）"
if grep -q 'dshstart()' "$HOME/.zshrc" 2>/dev/null; then
  ok "已存在，跳过"
else
  cat >> "$HOME/.zshrc" <<'ZSH_EOF'

# ========== DeepSeek Harness Web 快捷命令 ==========

DSH_WEB_DIR="__DSH_WEB_DIR__"  # dsh 仓库目录
DSH_WEB_PORT=3080  # web 端口

# 启动 dsh web（构建模式,可指定端口: dshstart 或 dshstart 8080）
dshstart() {
    local port="${1:-$DSH_WEB_PORT}"
    if tmux has-session -t dshweb 2>/dev/null; then
        echo "dsh web 已在运行，attach 进去: tmux attach -t dshweb"
    else
        termux-wake-lock
        tmux new-session -d -s dshweb "cd $DSH_WEB_DIR && node --expose-internals apps/cli/lib/bin.js web --port $port"
        sleep 1
        if tmux has-session -t dshweb 2>/dev/null; then
            echo "dsh web 已启动 (tmux: dshweb, 端口: $port)"
            echo "查看日志: tmux attach -t dshweb"
            echo "本地地址: http://127.0.0.1:$port"
        else
            echo "启动失败，检查 $DSH_WEB_DIR 是否存在且已 npm run build:lib:host"
        fi
    fi
}

# 停止 dsh web（关闭 tmux 会话 + 该目录下的 node 进程,不影响其他目录）
dshstop() {
    tmux kill-session -t dshweb 2>/dev/null && echo "dsh web 已停止" || echo "dsh web 未运行"
    local pids=()
    local pid cmd cwd
    for p in /proc/[0-9]*; do
        pid=${p#/proc/}
        cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
        case "$cmd" in
            *no"de"*) ;;
            *) continue ;;
        esac
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
        case "$cwd" in
            "$DSH_WEB_DIR"|"$DSH_WEB_DIR"/*) pids+=("$pid") ;;
        esac
    done
    if [ ${#pids[@]} -eq 0 ]; then
        echo "无残留 node 进程"
    else
        for pid in "${pids[@]}"; do
            kill "$pid" 2>/dev/null && echo "已关闭 node 进程 $pid"
        done
        sleep 1
        for pid in "${pids[@]}"; do
            kill -0 "$pid" 2>/dev/null && { kill -9 "$pid" 2>/dev/null; echo "已强制关闭 node 进程 $pid"; }
        done
    fi
    termux-wake-unlock 2>/dev/null
}

# 进入 dsh web 终端（查看日志/调试）
dshattach() {
    tmux attach -t dshweb
}

# 查看状态（自动识别实际端口）
dshstatus() {
    if tmux has-session -t dshweb 2>/dev/null; then
        echo "状态: 运行中"
        tmux ls | grep dshweb
        local pane_pid port=""
        pane_pid=$(tmux list-panes -t dshweb -F '#{pane_pid}' 2>/dev/null | head -1)
        if [ -n "$pane_pid" ]; then
            port=$(tr '\0' ' ' < "/proc/$pane_pid/cmdline" 2>/dev/null | sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p')
        fi
        if [ -n "$port" ]; then
            echo "端口: $port (http://127.0.0.1:$port)"
        else
            ss -tln 2>/dev/null | grep $DSH_WEB_PORT || netstat -tln 2>/dev/null | grep $DSH_WEB_PORT || echo "端口状态: 无法检测"
        fi
    else
        echo "状态: 未运行"
    fi
}
ZSH_EOF
  sed -i "s|__DSH_WEB_DIR__|$INSTALL_DIR|g" "$HOME/.zshrc"
  ok "已追加（新开终端生效）"
fi

# ── 7/7 冒烟验证 ─────────────────────────────────────────────
step "7/7 冒烟测试（用一次性 DSH_HOME，不动真实配置）"
SMOKE_HOME=$(mktemp -d "$TMP_BASE/dsh-smoke-home.XXXX")
SMOKE_TMP=$(mktemp -d "$TMP_BASE/dsh-smoke.XXXX")
DSH_HOME="$SMOKE_HOME" node --expose-internals apps/cli/lib/bin.js web --port "$SMOKE_PORT" >"$SMOKE_TMP/server.log" 2>&1 &
pid=$!
booted=0
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$SMOKE_PORT/"; then booted=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
kill "$pid" 2>/dev/null || true
if [ "$booted" -eq 1 ]; then
  rm -rf "$SMOKE_HOME" "$SMOKE_TMP"
  ok "服务可启动（HTTP 200，${i}s 内就绪）"
else
  # Read the log before removing the throwaway dir so a failure stays diagnosable.
  die "启动失败：$(tail -3 "$SMOKE_TMP/server.log" 2>/dev/null || echo 无日志)"
fi

printf '\n\033[1;32m完成 ✅\033[0m\n'
echo "  下一步："
echo "    1. 配置 API key：编辑 \$DSH_HOME/.credentials.yaml，加  DEEPSEEK_API_KEY: <你的 key>"
echo "    2. 新开终端（让 zsh 函数生效）后：dshstart"
echo "    3. 状态/日志/停止：dshstatus / dshattach / dshstop"
echo "    4. 浏览器打开 http://127.0.0.1:3080"
