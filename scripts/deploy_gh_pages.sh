#!/usr/bin/env bash
#
# 把构建产物推送到 gh-pages 分支，供 GitHub Pages 提供部署。
#
# 用法：
#   npm run deploy:gh
#
# 前置：
#   1. 在 GitHub Pages 设置里把 Source 选为「Deploy from a branch」→ gh-pages / (root)
#   2. macOS 已经通过 Keychain 存好了 GitHub 凭据，可直接 git push
#
# 行为：
#   - 用 GITHUB_PAGES=true 重新构建（base 路径切到 /<repo>/）
#   - 临时把 gh-pages 分支切到一个独立 worktree
#   - 用最新的 dist/ 内容覆盖（保留 .nojekyll / CNAME）
#   - 提交并 push 到 gh-pages 分支
#   - 自动清理临时 worktree

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d -t ghpages.XXXXXX)"
SRC_DIR="$REPO_ROOT/dist"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "❌ $SRC_DIR 不存在，请先运行 npm run build:gh"
  exit 1
fi

cd "$REPO_ROOT"

echo "→ 用 worktree 方式创建/切换 gh-pages 分支（起点 origin/main）..."
git fetch origin main 2>&1 | tail -2 || true
git worktree add --force -B gh-pages "$WORK_DIR" origin/main 2>&1 | tail -3

cd "$WORK_DIR"

echo "→ 清理工作区文件（保留 .git / .nojekyll / CNAME）..."
# 解除 worktree 自带的 .git 链接，转用主仓库的 .git 目录（共享对象库）
# 这样能正常 add/commit/push
find . -mindepth 1 -maxdepth 1 \
  ! -name '.git' \
  ! -name '.nojekyll' \
  ! -name 'CNAME' \
  -exec rm -rf {} +

touch .nojekyll

echo "→ 拷入新 dist/ 内容..."
cp -R "$SRC_DIR"/ .

echo "→ 提交并推送到 gh-pages..."
git add -A
git -c user.name="aigc-data-dashboard" \
    -c user.email="dashboard@local.invalid" \
    commit -m "deploy: $(date -u +'%Y-%m-%d %H:%M:%S UTC')" >/dev/null
git push origin gh-pages --force-with-lease 2>&1 | tail -5

cd "$REPO_ROOT"
git worktree remove --force "$WORK_DIR" 2>&1 | tail -2
rm -rf "$WORK_DIR"

echo ""
echo "✅ 推送完成。"
echo "   几分钟后访问：https://DylanPattinson.github.io/aigc_data_dashboard/"
