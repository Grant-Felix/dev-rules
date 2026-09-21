#!/usr/bin/env bash
# 插件开发用的隔离沙箱：在**独立的 DSH_HOME** 里装本插件、起一个 web 实例，
# 全程不碰你日常在用的 profile，也不碰你真实的规则文件。
#
# 为什么需要它：本插件的宿主半体是在 profile 启动时加载的，一个有问题的改动足以让
# 整个 DSH 起不来 —— 拿日常在用的 profile 试，代价就是「开发时把自己锁在门外」。
# 沙箱把这份风险圈进一个一次性 home：起不来就 clean 掉重来，真实环境毫发无损。
#
# 用法：
#   scripts/sandbox.sh            # 装本地检出（link:）并启动；Ctrl-C 结束
#   scripts/sandbox.sh check      # 自检 + 在沙箱里组装 profile（含本插件），不启动
#   scripts/sandbox.sh install    # 只安装 / 刷新沙箱里的插件
#   scripts/sandbox.sh clean      # 删掉整个沙箱 home
#
# 环境变量：
#   DSH_SANDBOX_HOME    沙箱 home（默认 <仓库>/.sandbox/home）
#   DSH_SANDBOX_PORT    监听端口（默认 3199；传 0 让系统挑）
#   DSH_SANDBOX_SOURCE  安装来源（默认 link:<仓库>）。想验「使用者装到的到底是什么」，
#                       就传发布来源，例如：
#                         DSH_SANDBOX_SOURCE=github:Grant-Felix/dev-rules npm run sandbox
#                         DSH_SANDBOX_SOURCE=git+https://gitee.com/Grant-Felix/dev-rules.git npm run sandbox
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sandbox_home="${DSH_SANDBOX_HOME:-$repo/.sandbox/home}"
port="${DSH_SANDBOX_PORT:-3199}"
source_spec="${DSH_SANDBOX_SOURCE:-link:$repo}"
profile_dir="$sandbox_home/profiles/web"

command -v dsh >/dev/null 2>&1 || {
  echo "找不到 dsh：先装 DeepSeek Harness CLI（npm install -g @deepseek-ai/dsh）。" >&2
  exit 127
}

# 安全闸。沙箱 home 一旦指到真实 home，这个脚本就开始动你日常在用的 profile ——
# 那正是它要防的事，所以宁可直接拒绝。
real_home="${DSH_HOME:-$HOME/.dsh}"
if [ "$sandbox_home" = "$real_home" ] || [ "$sandbox_home" = "$HOME/.dsh" ]; then
  echo "拒绝：DSH_SANDBOX_HOME 指向真实 DSH_HOME（$sandbox_home）。" >&2
  echo "沙箱的价值就在隔离，请换一个路径。" >&2
  exit 1
fi

export DSH_HOME="$sandbox_home"

# 保证沙箱里确实装着「本次来源」的本插件。
# 少了这一步，check 会在一个只有 base 的空 profile 上通过 —— 那是假绿灯：
# 组装绿了，却根本没验过本插件。
ensure_profile() {
  local recorded
  # `|| true`：package.json 里没有这条时 grep 会以非零退出，配上 set -e/pipefail
  # 会把整个脚本掐掉 —— 而「还没装过」恰恰是最正常的第一次运行。
  recorded="$(grep -o '"dsh-dev-rules": "[^"]*"' "$profile_dir/package.json" 2>/dev/null | head -1 | sed 's/.*: "//; s/"$//' || true)"
  if [ "$recorded" = "$source_spec" ]; then
    return 0
  fi
  if [ -n "$recorded" ]; then
    echo "沙箱里装的是「$recorded」，与本次来源「$source_spec」不同 → 重新安装"
  else
    echo "在沙箱初始化 profile 并安装 $source_spec"
  fi
  dsh plugin --profile web add "$source_spec"
  # 自动登记 bundle 是 dsh plugin 的职责，但「装上了却没进阵容」会让后面全部失真，
  # 所以这里显式确认一次，不靠假设。
  grep -q '"dsh-dev-rules"' "$profile_dir/package.json" || {
    echo "安装后沙箱 profile 里仍没有 dsh-dev-rules，中止。" >&2
    exit 1
  }
}

cmd="${1:-boot}"

case "$cmd" in
  check)
    # 组装能过 ≠ 运行能过，但组装过不了就一定起不来；先把它和自检一起卡掉最便宜
    npm --prefix "$repo" run check
    ensure_profile
    dsh --profile web --dump-config >/dev/null
    echo "✓ 自检与 profile 组装都通过（沙箱 home：$sandbox_home，来源：$source_spec）"
    ;;
  install)
    ensure_profile
    ;;
  clean)
    rm -rf "$sandbox_home"
    # 默认布局是 <仓库>/.sandbox/home：home 删掉后 .sandbox 会空着，顺手收掉，
    # 免得工作树里留个空目录让人以为还有东西。自定义路径只删它自己，不动父目录。
    case "$sandbox_home" in
      "$repo/.sandbox"/*) rmdir --ignore-fail-on-non-empty "$repo/.sandbox" 2>/dev/null || true ;;
    esac
    echo "已删除沙箱 home：$sandbox_home"
    ;;
  boot)
    ensure_profile
    echo "隔离实例：DSH_HOME=$sandbox_home  端口=$port  来源=$source_spec"
    echo "（它读沙箱自己的 dev-rules.json，不会碰 ~/.dsh/dev-rules.json）"
    # 改完代码重跑这一条即可；--no-open 免得每次弹浏览器
    exec dsh --profile web --port "$port" --no-open
    ;;
  *)
    echo "用法：$0 [boot|check|install|clean]" >&2
    exit 2
    ;;
esac
