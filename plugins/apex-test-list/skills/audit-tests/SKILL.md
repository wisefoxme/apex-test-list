---
name: audit-tests
description: Use when the user wants to check the Apex test annotations used by the apextestlist plugin (`sf apextests list`) in a Salesforce DX project, such as "which classes have no @Tests", "find stale test annotations", "check our @Tests against org coverage", "why didn't this test run in the deploy", "what tests will run for this change", or "audit .test-dependencies.yml". Reports classes without annotations, names that aren't test classes, missing suites, overly broad annotations, and differences from org code coverage, then offers fixes. Read-only unless the user approves changes. Needs Node.js 22.19+; the Salesforce CLI is optional.
license: BSD-3-Clause
---

# Audit Apex test annotations

Test annotations drift: tests get renamed or deleted, classes get added
without annotations, and coverage moves as code changes. This skill finds those
problems and shows exactly which tests a change would run, so the selection
stays transparent instead of trusted blindly.

The audit runs the `apex-test-map` command from the `apextestlist` npm package
with `npx -y -p apextestlist@1 apex-test-map`, which needs no Salesforce CLI or plugin
install. It needs Node.js 22.19 or newer and doesn't change files in `scan` or
`audit`.

## Step 1: Check the project

1. Find `sfdx-project.json` in the working directory or a parent and run
   commands from its folder. Without one, stop.
2. Confirm `node --version` is 22.19 or newer.
3. Ask whether any package directories should be skipped, and pass each with
   `--ignore-package-directory <path>`.
4. If the project has an Apex header template (see the `annotate-tests` skill),
   add `--header-template <file>` to the audit. It then also reports annotated
   files whose annotations aren't inside a leading header of the template's
   comment style (`/** */` or `//`). Fix those with the user; don't rewrite
   headers on your own.

## Step 2: Static audit

```bash
npx -y -p apextestlist@1 apex-test-map audit
```

It reports:

| Finding                                           | What it means                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| No `@Tests` or `@TestSuites`                      | changing this file selects no tests; apextestlist also warns about it on every run             |
| `@Tests` names that are not local classes         | renamed, deleted, misspelled, or only in the org; `--ignore-missing-tests` silently drops them |
| `@Tests` names that are classes without `@isTest` | points at a non-test class, usually a mistake                                                  |
| `@TestSuites` names with no local suite           | the suite file is missing, so its tests are never added                                        |
| Suite entries that match no local test class      | a suite lists a test (or `Name*Test` pattern) that doesn't exist                               |
| Annotations with more than N tests                | `--max-tests N` (default 10); consider a suite or narrower tests                               |
| `.test-dependencies.yml` problems                 | keys that aren't local tests, entries that aren't `Type:Member`                                |

## Step 3: Compare with org coverage (optional)

If the user has an org with the code deployed and recent test results, export
coverage as described in the `annotate-tests` skill (Step 2), to a temporary
folder outside the project, then:

```bash
npx -y -p apextestlist@1 apex-test-map audit --coverage <temp folder>/coverage.json
```

This adds, per annotated class:

- **covering tests not annotated**: tests that executed this class but won't
  run when it changes. Strong candidates to add.
- **annotated but no coverage**: annotated tests that never executed this
  class. Often stale, but not always: a test can check behavior without
  covering lines (for example through a callout mock), so ask before removing.
- **no coverage rows**: the class has annotations but no coverage data, often
  because the org's coverage is missing or out of date for it.

Coverage only reflects the last test run. If many classes show no coverage
rows, say the data looks stale rather than reporting each one.

## Step 4: Explain a specific change (when asked)

For "which tests will run for this change" or "why didn't X run":

1. Build the manifest the pipeline uses (often sfdx-git-delta:
   `sf sgd source delta --from <base> --to HEAD --output-dir <temp folder>`).
   Without one, write a `package.xml` in a temporary folder listing the changed
   classes and triggers from `git diff --name-only <base>`.
2. Run the same selection `sf apextests list` makes, without the Salesforce CLI:

   ```bash
   npx -y -p apextestlist@1 apex-test-map list --manifest <temp folder>/package/package.xml --ignore-missing-tests
   ```

   Show the tests, the deploy flags, and the warnings. Add
   `--filter-by-metadata` if the pipeline selects tests from
   `.test-dependencies.yml`.
3. For a test that didn't run, point to the missing link: no annotation on the
   changed class, a misspelled name, or a suite that doesn't list it.

## Step 5: Report and fix

Summarize the findings by severity: unannotated classes and unknown names
first, then coverage differences, then broad annotations. Don't edit anything
until the user picks what to fix.

- **Add missing tests**: use the `annotate-tests` skill's plan and
  `apply` flow; it only adds names.
- **Remove or rename names**: edit the `// @Tests:` line directly, keeping the
  comma-separated format on one `//` line. The script never removes names.
- **Missing suite or suite entries**: update `testSuites/*.testSuite-meta.xml`
  or the annotation, whichever the user says is wrong.

After fixing, run `npx -y -p apextestlist@1 apex-test-map audit` again and show the before and after counts.
