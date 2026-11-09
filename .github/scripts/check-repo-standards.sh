#!/usr/bin/env bash
set -euo pipefail

min_readme_words=200
max_readme_words=1500
required_files=(
  .editorconfig
  .gitattributes
  .github/CODEOWNERS
  .github/ISSUE_TEMPLATE/bug_report.yml
  .github/ISSUE_TEMPLATE/feature_request.yml
  .github/pull_request_template.md
  .gitignore
  CHANGELOG.md
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  LICENSE
  README.md
  SECURITY.md
)
required_sections=(Features 'Quick start' Usage 'Project structure' Contributing Security License)
errors=0

error() {
  echo "Repo standards: $1" >&2
  errors=$((errors + 1))
}

for file in "${required_files[@]}"; do
  [[ -f $file ]] || error "$file is missing"
done

if [[ -f README.md ]]; then
  [[ $(head -n 1 README.md) == '# '* ]] || error 'README.md must start with a # title'
  for section in "${required_sections[@]}"; do
    grep -qx "## $section" README.md || error "README.md has no \"## $section\" section"
  done
  words=$(wc -w <README.md)
  ((words >= min_readme_words)) || error "README.md has $words words, and needs at least $min_readme_words"
  ((words <= max_readme_words)) || error "README.md has $words words, so move detail into docs/ to reach $max_readme_words"
fi

if [[ -f CHANGELOG.md ]]; then
  grep -q '^## ' CHANGELOG.md || error 'CHANGELOG.md needs a ## section, such as ## [Unreleased]'
fi

if ((errors > 0)); then
  echo "Repo standards failed with $errors error(s)" >&2
  exit 1
fi
echo 'Repo standards passed'
