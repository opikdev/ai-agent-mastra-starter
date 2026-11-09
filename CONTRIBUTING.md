# Contributing

Thanks for helping out. Small, focused changes are the easiest to review and merge.

## Report a problem or suggest a change

- Search open issues first, in case someone has already raised it.
- Use the issue forms, and include the steps to reproduce a bug.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Make a change

1. Fork the repo and create a branch named `type/short-description`, such as `fix/login-redirect`.
2. Follow the README's **Quick start** to set up the project.
3. Make one logical change, and add or update tests for it.
4. Update any docs your change makes wrong.
5. Run the project's checks. The README lists them.
6. Open a pull request and fill in the template.

## Write commit messages

Use one line in the [Conventional Commits](https://www.conventionalcommits.org/) format, in the imperative mood:

```text
fix(auth): handle expired refresh tokens
```

Common types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, and `chore`.

## Change shared files

Files listed in `.baseline.sha256` come from [opikdev/starters](https://github.com/opikdev/starters) and fail CI if edited here. Change them in `base/` in that repo instead.

## Follow the code of conduct

Everyone taking part agrees to follow the [code of conduct](CODE_OF_CONDUCT.md).
