# Formatting

**Status:** the configuration is pinned and the generated-file hazard is closed,
7 September 2026. **The reformat has not been run, and that is the open
decision.** ·
**Blueprint sections:** §2 (C2), §11.3, §13 (solo bus factor)
**Related:** [validation.md](validation.md)

---

## 1. What was wrong

Until 7 September 2026 there was **no Prettier configuration anywhere in this
repository**, and no ignore file — while `package.json` carried both:

```json
"format": "prettier --write .",
"format:check": "prettier --check ."
```

and `lint-staged` ran `prettier --write` over every staged `.ts`, `.tsx`,
`.js`, `.json`, `.md`, `.yml` and `.css` file.

So `pnpm format` was a command that reformatted the entire repository to
settings nobody had chosen. Three separate problems, worth separating because
they have different fixes:

1. **The defaults are not this codebase's style.** 822 of the 841 TypeScript
   files in `packages/` and `apps/web/` would have been rewritten.
2. **The defaults are not even stable.** With no config, the output is whatever
   the installed Prettier version defaults to, which changes across releases.
3. **It would have rewritten generated files** — the 19 tracked Drizzle
   snapshots under `packages/db/migrations/meta/`, every migration `.sql`, and
   `pnpm-lock.yaml`.

The only reason none of this had happened is that `lint-staged` was never
firing: `.husky/` contains only the `_` helper directory, so no hook is
installed. The landmine was armed and had not been stepped on.

## 2. What was fixed

Problems 2 and 3, because they have a correct answer that does not depend on
anyone's taste.

**`.prettierignore`** now excludes the generated artefacts. Drizzle owns the
migrations and the snapshots it diffs against to produce the next one;
reformatting an applied migration also edits history, which §13.2 forbids for
its own reasons. `pnpm-lock.yaml` is rewritten by pnpm on every install, so
Prettier and pnpm would take turns rewriting it forever.

**`prettier.config.mjs`** pins the settings, chosen by measurement rather than
preference. Every candidate was run against those 841 files, counting the files
whose formatting would change:

| Configuration | Files that would change |
|---|---|
| Prettier defaults (no config) | 822 of 841 |
| 100 columns | 556 |
| 105 columns | 484 |
| **110 columns — what is now pinned** | **429** |
| 115 columns | 450 |
| 120 columns | 469 |
| 130 columns | 539 |
| 110 columns + `experimentalTernaries` | 501 |

Single quotes, trailing commas, semicolons and always-parenthesised arrow
parameters all match what is already written and cost nothing.

`experimentalTernaries` is **off**, despite some of the newer JSX being written
in exactly that style — the nested `cond ?\n  <A />\n: <B />` shape. Turning it
on costs 72 additional files. The style in the tree is genuinely mixed; the
measurement is not.

## 3. The decision that has not been made

**110 columns is the floor, and it is still 429 files.** There is no
configuration that makes adopting Prettier a no-op here, because this code was
written by hand and not by a formatter.

So `pnpm format` has deliberately **not** been run, and `pnpm format:check`
currently fails on 497 files across the repository. That failure is not a bug
to be silenced — it is an accurate report of a known state, which is better than
the previous situation where the same command reported a *different* known-bad
state that nobody had measured.

The cost of adopting it is not the diff. It is `git blame`. Rewriting half the
tree in one commit puts a formatting commit between every line and its real
author and reason — and for a record intended to last twenty years (C2),
maintained by one person (§13's solo bus factor), the commentary in this
codebase *is* the documentation. Losing the path back to why a line was written
is a real loss, and it should be chosen deliberately rather than absorbed as a
side effect of an unrelated commit.

### The options, honestly

| Option | What it costs | What it buys |
|---|---|---|
| **Adopt** — run `pnpm format`, commit alone, add the commit to `.git-blame-ignore-revs` | 497 files in one commit; blame needs the ignore file configured to stay useful | Formatting stops being a thing anyone thinks about |
| **Adopt gradually** — leave `format:check` failing, let `lint-staged` format only files already being touched | A long period where the tree is half-formatted and `format:check` is a permanently red signal | No blame event; the diff arrives spread across commits that were happening anyway |
| **Decline** — remove `format`, `format:check`, and Prettier from `lint-staged` | Nothing enforces formatting; ESLint continues to enforce correctness only | Honest. The codebase is hand-formatted and would stay that way on purpose |

`.git-blame-ignore-revs` is the thing that makes the first option survivable and
it is worth knowing about before choosing: Git can be told to skip a commit when
computing blame, so a pure-formatting commit becomes invisible to
`git blame` for anyone who has run `git config blame.ignoreRevsFile`.

There is no recommendation here, because the trade is between two things this
project genuinely values — consistency and provenance — and only the operator
can price them.

## 4. What formatting does not cover

ESLint, not Prettier, enforces the rules that actually matter in this
repository, and none of them are cosmetic: no non-null assertions, no raw
`new Date` outside `**/temporal/**` (§11.3), the layering boundaries of §5.0,
`no-bare-quantity`, `no-sensitive-log`. `--max-warnings=0` is the gate.

Prettier would only ever decide where the line breaks. Nothing above depends on
this decision, which is another way of saying it can safely wait.
