---

name: annotate-tests
description: Use when the user wants to map Apex classes and triggers to the tests that cover them in a Salesforce DX project, so deployments run only the relevant tests with the apextestlist plugin (`sf apextests list`). Examples include "add @Tests annotations to our Apex classes", "which tests should run when AccountService changes", "set up test annotations for apex-test-list", "annotate the classes that have no @Tests", or "map our triggers to their tests". Proposes mappings from org code coverage (when an org is connected) or from static analysis of the test code, has the user review them, then writes `// @Tests:` comments. Unlike Salesforce's server-side RunRelevantTests, every mapping is in the source and reviewable. Needs Node.js 22+; the Salesforce CLI is optional.
---

# Annotate Apex classes with the tests that cover them

The apextestlist plugin reads `// @Tests:` and `// @TestSuites:` comments in
Apex classes and triggers, and `sf apextests list` turns the changed files into
a `--tests` list for `sf project deploy start --test-level RunSpecifiedTests`.
This skill writes those comments. Every mapping lives in the source, so the
team can review it in a pull request and see exactly which tests a deploy runs.

A helper script does the scanning and file edits, so large projects don't have
to be read file by file. It is `scripts/apex-test-map.mjs` in this skill's
folder (below, `$MAP` means `node <this skill's folder>/scripts/apex-test-map.mjs`).
It needs only Node.js 22 or newer and changes files only in `apply`.

## Annotation rules

apextestlist reads annotations with `/@tests\s*:\s*([^/\n]+)/gi`:

- Use `//` line comments: `// @Tests: AccountServiceTest, AccountTriggerTest`.
  A name ends at a `/` or the end of the line, so never put annotations inside
  a `/* ... */` block on one line, and never add trailing comments after them.
- Separate names with commas, spaces, or both. The `@Tests:` keyword is
  case-insensitive.
- Several `@Tests:` lines in one file are combined.
- Test classes (any file containing `@isTest`) are always selected when they
  change and need no annotation.

## Step 1: Check the project

1. Find `sfdx-project.json` in the working directory or a parent. If there is
   none, stop: this only works in a Salesforce DX project. Run commands from
   the folder that holds it.
2. Confirm `node --version` is 22 or newer.
3. Ask which package directories to skip, if any (managed or vendored code).
   Pass each with `--ignore-package-directory <path>`.
4. Note uncommitted changes in Apex files (`git status --porcelain -- '*.cls' '*.trigger'`).
   If there are any, tell the user, so their edits and the annotations stay
   distinguishable in the diff.

## Step 2: Get coverage data (recommended)

Org code coverage gives the real class-to-test map, including indirect coverage
that static analysis can't see. Ask whether the user has an org with the
project's code deployed and recent test results, and its alias. Prefer a full
sandbox or scratch org. Never run tests in production without the user asking.

Coverage per test class lives in `ApexCodeCoverage`. It holds data only after
tests ran asynchronously, and recompiling Apex can clear it. If it's empty or
stale, ask before running the tests, because a full run can take a long time:

```bash
sf apex run test --test-level RunLocalTests --code-coverage --wait 120 --target-org <alias>
```

Then export it:

```bash
sf data query --use-tooling-api --json --target-org <alias> \
  --query "SELECT ApexTestClass.Name, ApexClassOrTrigger.Name FROM ApexCodeCoverage" \
  > <temp folder>/coverage.json
```

Write the file to a temporary folder outside the project. Large orgs can
exceed the CLI's 10,000-record default; if the result reports more records than
it returned, ask the user to raise it with `sf config set org-max-query-limit=<n>`
and query again.

If there's no org, skip this step. Tell the user the mappings will come from
static analysis only, and that they miss indirect coverage.

## Step 3: Scan

```bash
$MAP scan [--coverage <temp folder>/coverage.json] [--missing-only] [--only Name1,Name2]
```

Use `--missing-only` for a first pass on a project that already has some
annotations, and `--only` for a few classes. Add `--json` if you need to
process the output further.

Each class or trigger gets proposed tests, each tagged with where it came from:

| Source      | Meaning                                                                     | Trust                     |
| ----------- | --------------------------------------------------------------------------- | ------------------------- |
| `coverage`  | the test executed lines of this class in the org                            | high                      |
| `name`      | naming convention: `FooTest`, `Foo_Test`, `FooTests`, `TestFoo`, `Test_Foo` | high                      |
| `handler`   | (triggers) a test of a class the trigger calls, such as its handler         | high                      |
| `reference` | the test's code names the class (comments and strings ignored)              | medium: may be setup only |

For triggers, the scan also lists tests that run DML on the trigger's object.
Those fire the trigger, but there are usually too many to annotate. Don't
propose them unless they're clearly about the trigger's behavior, or coverage
confirms them.

## Step 4: Build the plan

Decide the tests for each class with judgment, not just by copying every
proposal:

- Prefer `coverage`, `name`, and `handler` tests. Keep `reference` tests whose
  test methods exercise the class, and drop ones that only use it for setup
  (for example a data factory or utility).
- Keep each list short. If a class is used everywhere (utilities, selectors,
  test data factories), more than about 10 tests is a smell: pick its dedicated
  tests, or suggest a test suite and `@TestSuites:` instead.
- Leave out tests reported as "not found locally" unless the user confirms they
  exist in the org but not in this repository.
- Keep existing annotations. The script only adds names; it never removes them.
  Mention any existing names that look wrong, and let the user decide.
- Classes with no proposal have no test touching them that the scan could see.
  Look at who calls them (`grep` for the class name in non-test classes) and
  suggest those callers' tests, or report them as untested.

Show the user the plan as a table (class, tests, why) before writing anything.
For many classes, summarize and list only the uncertain ones. Then write it to
a temporary file outside the project:

```json
{
  "AccountService": ["AccountServiceTest"],
  "trigger:AccountTrigger": ["AccountTriggerHandlerTest"],
  "OpportunitySelector": { "tests": ["OpportunityServiceTest"], "suites": ["SalesSuite"] }
}
```

Keys are class or trigger names. Prefix a key with `trigger:` or `class:` when
a class and a trigger share a name.

## Step 5: Apply

Preview, then write:

```bash
$MAP apply --plan <temp folder>/plan.json --dry-run
$MAP apply --plan <temp folder>/plan.json
```

`apply` checks the whole plan first and changes nothing if any name is not a
local test class or suite (`--allow-unknown` allows org-only tests). It adds a
`// @Tests:` line at the top of each file, or merges new names into the first
existing one, and keeps the file's line endings. Running it twice changes
nothing.

## Step 6: Verify

1. Run `$MAP audit` and fix anything it reports about the new annotations.
2. If the Salesforce CLI and the plugin are installed (`sf plugins inspect apextestlist`),
   run `sf apextests list --ignore-missing-tests` and show the user the list it
   produces. Don't install the plugin yourself; the user confirms that install.
3. Show `git diff --stat` and suggest committing the annotations on their own,
   separate from functional changes.

## Non-Apex metadata

Changes to flows, fields, objects, or validation rules don't touch an Apex
file, so `@Tests:` can't select tests for them. For those, apextestlist reads
`.test-dependencies.yml` in the project root when run with
`--manifest package.xml --filter-by-metadata`. See
[references/test-dependencies.md](references/test-dependencies.md) to build it.
Only do this if the user asks for it or deploys these changes with a manifest.

## Hand off

Summarize: how many files were annotated, which mappings came from coverage
versus static analysis, classes left without tests, and broad mappings worth a
suite. Remind the user that selecting tests per change can miss side effects
(trigger cascades, flows calling Apex), so a periodic full `RunLocalTests` run
is still worth keeping, and that the `audit-tests` skill finds annotations that
go stale over time.
