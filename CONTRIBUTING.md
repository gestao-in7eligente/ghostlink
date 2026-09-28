# Contributing / Como contribuir

Thanks for helping with GhostLink! Issues and pull requests are welcome in Portuguese or English.

- **Bugs and ideas:** open an issue. For crashes, include your OS, the app version (Settings → Updates) and, if you can, the relevant part of `%APPDATA%\GhostLink\logs\main.log` (check it for anything private first).
- **Security problems:** never in public. Follow [SECURITY.md](SECURITY.md).

## Pull requests

1. Discuss bigger changes in an issue first. The design lives in `docs/superpowers/specs/` and behavior follows it.
2. Keep changes small and focused, with tests (Vitest) that check real behavior, including the forbidden and failure paths. New server requests need a strict zod schema, a permission check and their rate limit.
3. Before pushing, all of these must pass:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```
   If you touch the site, also run `npm run docs:build`.
4. Every user-facing string goes in the app's i18n files (pt-BR **and** en) or in both languages of the site.
5. UI: use the CSS tokens (`apps/desktop/src/renderer/styles/tokens.css`), never hard-coded colors; keep everything keyboard-accessible.
6. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(server): …`, `fix(desktop): …`, `docs(site): …`).

Dependencies are pinned to exact versions, and GitHub Actions to commit SHAs. Explain any new dependency in the pull request.

By contributing, you agree that your contribution is licensed under the project's license, **GPL-3.0-or-later**.

---

**Português:** discuta mudanças grandes numa issue antes, mande PRs pequenos e com testes, rode `npm run lint`, `npm run typecheck` e `npm test` (e `npm run docs:build` se mexer no site), escreva os textos em pt-BR e em inglês e use Conventional Commits. Problemas de segurança seguem o [SECURITY.md](SECURITY.md). As contribuições ficam sob a licença GPL-3.0-or-later.
