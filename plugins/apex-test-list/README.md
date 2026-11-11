# apex-test-list for Claude Code

Adopt [apextestlist](https://github.com/wisefoxme/apex-test-list) in a
Salesforce DX project without annotating hundreds of Apex classes by hand.
Claude maps each class and trigger to the tests that cover it and writes the
`// @Tests:` comments that `sf apextests list` reads.

Unlike server-side test selection, every mapping is a line in your source code:
you review it in the pull request, and `sf apextests list` shows exactly which
tests a deployment will run before it starts.

## Skills

| Skill            | What it does                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `annotate-tests` | Proposes tests for each class and trigger from org code coverage (when you have an org) or from static analysis of your test code, lets you review the plan, then writes or merges `// @Tests:` annotations. Can also build `.test-dependencies.yml` for flows, fields, and other non-Apex metadata. |
| `audit-tests`    | Finds classes without annotations, names that aren't test classes, missing suites, overly broad annotations, and differences from org coverage. Explains which tests a given change will run, and why a test didn't.                                                                                 |

Both use a small Node.js script bundled with the plugin. It has no
dependencies and edits files only when you approve a plan.

## Install

```text
/plugin marketplace add wisefoxme/apex-test-list
/plugin install apex-test-list@apex-test-list
```

## Requirements

- Node.js 22 or newer
- A Salesforce DX project (a folder with `sfdx-project.json`)
- Optional: the Salesforce CLI with an authorized org, for coverage-based
  mappings, and the `apextestlist` plugin (`sf plugins install apextestlist`)
  to check the result with `sf apextests list`

## Try it

- "Add @Tests annotations to every Apex class that doesn't have one"
- "Map our triggers to their tests using coverage from my dev sandbox"
- "Which tests will run if I deploy the changes on this branch?"
- "Audit our @Tests annotations against org coverage"
- "Build a .test-dependencies.yml for our Account flows and validation rules"

## Data handling

The skills read Apex and metadata files in your local project. With your
approval, they query `ApexCodeCoverage` from an org you choose through the
Salesforce CLI and save the result to a temporary folder outside the project.
They don't run tests in an org unless you ask. Nothing is sent anywhere except
what Claude itself reads.

## More

Annotations, the `.test-dependencies.yml` format, CI usage, and the GitHub
Action: <https://github.com/wisefoxme/apex-test-list#readme>
