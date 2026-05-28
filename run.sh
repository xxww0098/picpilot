#!/bin/bash
set -e

echo "=== GPT Image Playground - 本地静态构建启动 ==="

if ! command -v node &> /dev/null; then
  echo "错误: 未安装 Node.js"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "错误: 未安装 npm"
  exit 1
fi

echo "Node 版本: $(node -v)"
echo "npm 版本: $(npm -v)"

echo ""
echo ">>> 安装依赖..."
npm install

echo ""
echo ">>> 构建项目..."
npm run build

echo ""
echo ">>> 预览构建产物 (http://localhost:4173)..."
npm run preview
