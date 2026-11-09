#!/usr/bin/env bash
set -euo pipefail

output=$(pnpm exec drizzle-kit generate 2>&1)
if [[ $output != *'No schema changes'* ]]; then
  echo 'src/db/schema.ts has changes with no migration. Run pnpm db:generate and commit the result.' >&2
  echo "$output" >&2
  exit 1
fi

if [[ -n ${GITHUB_BASE_REF:-} ]]; then
  edited=$(git diff --name-status "origin/$GITHUB_BASE_REF...HEAD" -- 'migrations/*.sql' | grep -v '^A' || true)
  if [[ -n $edited ]]; then
    echo "Migrations are append-only. Add a new one instead of changing these:" >&2
    echo "$edited" >&2
    exit 1
  fi
fi
