#!/bin/bash
# Auto-push to GitHub using GITHUB_TOKEN
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN not set"
  exit 1
fi

REPO="https://x-access-token:${GITHUB_TOKEN}@github.com/sykexyz/cozybot2.git"

git config user.email "bot@dummyl.bot"
git config user.name "DummylBot AutoPush"
git remote set-url origin "$REPO"
git add -A
git diff --cached --quiet && echo "Nothing to commit." && exit 0
git commit -m "auto: update $(date '+%Y-%m-%d %H:%M')"
git push origin HEAD
echo "Pushed to GitHub successfully."
