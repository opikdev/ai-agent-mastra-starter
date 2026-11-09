#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}"

max_agents_lines=100
max_claude_lines=5
errors=0

error() {
  echo "Harness check: $1" >&2
  errors=$((errors + 1))
}

check_agent_files() {
  if [[ ! -f AGENTS.md ]]; then
    error 'AGENTS.md is missing'
  elif (($(wc -l <AGENTS.md) > max_agents_lines)); then
    error "AGENTS.md is over $max_agents_lines lines, so move detail into docs/"
  fi

  if [[ ! -f CLAUDE.md ]]; then
    error 'CLAUDE.md is missing'
  elif ! grep -q 'AGENTS\.md' CLAUDE.md; then
    error 'CLAUDE.md must point to AGENTS.md'
  elif (($(wc -l <CLAUDE.md) > max_claude_lines)); then
    error "CLAUDE.md is over $max_claude_lines lines, so keep it a pointer to AGENTS.md"
  fi
}

check_links() {
  local file link target
  while IFS= read -r file; do
    while IFS= read -r link; do
      target=${link%%#*}
      target=${target%% *}
      [[ -z $target || $target =~ ^[a-z][a-z0-9+.-]*: ]] && continue
      [[ -e $(dirname "$file")/$target ]] || error "$file links to missing \"$link\""
    done < <(grep -oE '\]\([^)]+\)' "$file" | sed -E 's/^\]\(//; s/\)$//')
  done < <(find AGENTS.md CLAUDE.md docs .agents/skills -name '*.md' 2>/dev/null)
}

check_decisions() {
  [[ -f docs/architecture.md ]] || error 'docs/architecture.md is missing'
  [[ -d docs/decisions ]] || error 'docs/decisions/ is missing'

  local file name field duplicate
  for file in docs/decisions/*.md; do
    name=$(basename "$file")
    [[ $name == README.md ]] && continue
    [[ $name =~ ^[0-9]{3}-[a-z0-9-]+\.md$ ]] || error "$file must be named NNN-short-title.md"
    for field in Status Context Decision Consequences; do
      grep -q "^- \*\*$field\*\*:" "$file" || error "$file has no $field field"
    done
  done

  duplicate=$(find docs/decisions -maxdepth 1 -name '[0-9][0-9][0-9]-*.md' 2>/dev/null |
    sed -E 's|.*/([0-9]{3})-.*|\1|' | sort | uniq -d | head -n 1)
  [[ -z $duplicate ]] || error "docs/decisions has two ADRs numbered $duplicate"
}

check_skills() {
  local dir name
  for dir in .agents/skills/*/; do
    name=$(basename "$dir")
    if [[ ! -f $dir/SKILL.md ]]; then
      error "$dir has no SKILL.md"
      continue
    fi
    grep -q "^name: $name$" "$dir/SKILL.md" || error "$dir/SKILL.md must set name: $name"
    grep -qE '^description: .+' "$dir/SKILL.md" || error "$dir/SKILL.md needs a description"
    if [[ ! -f .claude/skills/$name/SKILL.md ]] || ! diff -rq "$dir" ".claude/skills/$name/" >/dev/null 2>&1; then
      error ".claude/skills/$name must link to $dir, or be an identical copy of it"
    fi
  done
}

check_enforcement() {
  local workflow=.github/workflows/harness.yml hook=.githooks/pre-commit
  if [[ ! -f $workflow ]]; then
    error "$workflow is missing, so CI doesn't run the pinned check"
  else
    grep -qE '^ +repository: opikdev/agent-harness[[:space:]]*$' "$workflow" ||
      error "$workflow must check out opikdev/agent-harness"
    grep -qE '^ +ref: (v[0-9]+\.[0-9]+\.[0-9]+|[0-9a-f]{40})[[:space:]]*(#.*)?$' "$workflow" ||
      error "$workflow must pin ref to a release tag such as v1.2.3, or a 40-character commit SHA"
    grep -qE '^ +(- )?run: \.harness/template/\.agents/check\.sh ' "$workflow" ||
      error "$workflow must run .harness/template/.agents/check.sh"
  fi

  if [[ ! -f $hook ]]; then
    error "$hook is missing"
  elif [[ ! -x $hook ]]; then
    error "$hook must be executable, so run chmod +x $hook"
  elif ! grep -q '\.agents/check\.sh' "$hook"; then
    error "$hook must run .agents/check.sh"
  fi
}

check_mcp_config() {
  if ! command -v jq >/dev/null; then
    error 'jq is required to check .mcp.json'
  elif [[ ! -f .mcp.json ]]; then
    error '.mcp.json is missing'
  elif ! jq -e '.mcpServers | type == "object"' .mcp.json >/dev/null 2>&1; then
    error '.mcp.json must be JSON with an mcpServers object'
  fi
}

check_agent_files
check_links
check_decisions
check_skills
check_enforcement
check_mcp_config

if ((errors > 0)); then
  echo "Harness check failed with $errors error(s)" >&2
  exit 1
fi
echo 'Harness check passed'
