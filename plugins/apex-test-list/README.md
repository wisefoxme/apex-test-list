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

Both run the `apex-test-map` command from the
[`apextestlist`](https://www.npmjs.com/package/apextestlist) npm package with
`npx -y -p apextestlist@1 apex-test-map`. It needs no Salesforce CLI or plugin install,
and edits files only when you approve a plan.

## Install

The skills are standard `SKILL.md` files, so they work in Claude Code, GitHub
Copilot, and other AI coding agents that support Agent Skills. Install them one
of these ways:

- **Claude Code**, from this repository's plugin marketplace:

  ```text
  /plugin marketplace add wisefoxme/apex-test-list
  /plugin install apex-test-list@apex-test-list
  ```

- **GitHub Copilot CLI**, which reads the same marketplace:

  ```sh
  copilot plugin marketplace add wisefoxme/apex-test-list
  copilot plugin install apex-test-list@apex-test-list
  ```

- **Any agent, with the [skills](https://skills.sh) CLI**. It asks which
  agents to install into:

  ```sh
  npx skills add wisefoxme/apex-test-list
  ```

- **Any agent, with the GitHub CLI** (`gh skill`, in public preview). Pick the
  agent with `--agent`, for example `github-copilot`, `claude-code`, `cursor`,
  or `codex`:

  ```sh
  gh skill install wisefoxme/apex-test-list --agent github-copilot
  ```

## Requirements

- Node.js 22.19 or newer
- A Salesforce DX project (a folder with `sfdx-project.json`)
- Optional: the Salesforce CLI with an authorized org, for coverage-based
  mappings. Checking which tests a change selects (`apex-test-map list`) needs
  neither the Salesforce CLI nor the `apextestlist` plugin.

## Try it

- "Add @Tests annotations to every Apex class that doesn't have one"
- "Map our triggers to their tests using coverage from my dev sandbox"
- "Annotate our classes using the ApexDoc header in config/apex-header.txt"
- "Which tests will run if I deploy the changes on this branch?"
- "Audit our @Tests annotations against org coverage"
- "Build a .test-dependencies.yml for our Account flows and validation rules"

## Data handling

The skills read Apex and metadata files in your local project. With your
approval, they query `ApexCodeCoverage` from an org you choose through the
Salesforce CLI and save the result to a temporary folder outside the project.
They don't run tests in an org unless you ask. Both skills download the `apextestlist` package from the npm registry through
`npx`. Nothing is sent anywhere except what Claude itself reads.

## More

Annotations, the `.test-dependencies.yml` format, CI usage, and the GitHub
Action: <https://github.com/wisefoxme/apex-test-list#readme>
