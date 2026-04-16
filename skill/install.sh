#!/bin/sh
set -e

REPO="zackiles/agent-runtime"
SKILL_NAME="agent-runtime"

claude_dir="$HOME/.claude/skills/$SKILL_NAME"
cursor_dir="$HOME/.cursor/skills/$SKILL_NAME"

fetch_skill() {
  url="https://raw.githubusercontent.com/${REPO}/main/skill/SKILL.md"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    printf "Error: curl or wget is required\n" >&2
    exit 1
  fi
}

content=$(fetch_skill)

installed=""

mkdir -p "$claude_dir"
printf '%s\n' "$content" > "$claude_dir/SKILL.md"
installed="$installed claude($claude_dir)"

mkdir -p "$cursor_dir"
printf '%s\n' "$content" > "$cursor_dir/SKILL.md"
installed="$installed cursor($cursor_dir)"

printf "Installed agent-runtime skill to:%s\n" "$installed"
printf "\nUsage:\n"
printf "  Claude Code:  /agent-runtime\n"
printf "  Cursor:       @agent-runtime or /agent-runtime\n"
