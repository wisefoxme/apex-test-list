# summary

List Apex tests to run, from annotations in your package directories or a package.xml.

# description

Use the Apex Tests List tool to list specific tests on your Salesforce DX repository. If no tests are found, all classes with the `@IsTest` annotation will be included in the list. The tests you want listed must meet some criteria, such as having a specific comment to annotate them to show up on this list. Please refer to the documentation on the project's GitHub page for more information if needed.

# flags.format.summary

Format of the output.

# flags.format.description

Available formats:

- `sf` (default): One `--tests` flag per test (`--tests A --tests B`), ready to append to the Salesforce CLI deploy and validate commands.
- `sfdx`: A single `--tests` flag followed by space-separated test names (`--tests A B`).
- `csv`: Comma-separated test names (`A,B`).

# flags.manifest.summary

Manifest XML file.

# flags.manifest.description

When you specify a manifest file, the plugin will not search directories for all classes with annotations, but instead will read the manifest file and search for those classes within your package directories.

# flags.ignore-missing-tests.summary

Ignore missing test methods.

# flags.ignore-missing-tests.description

If provided, ignore test methods that are not found in any of the local package directories.

# flags.ignore-package-directory.summary

Ignore a package directory.

# flags.ignore-package-directory.description

If provided, do not search the package directory for test annotations. The value must match how the directory is declared in `sfdx-project.json`. You can specify this flag multiple times.

# flags.no-warnings.summary

Do not print warnings for each Apex file missing annotations.

# flags.no-warnings.description

Suppresses the warning printed for each Apex file without a `@tests`, `@testsuites`, or `@istest` annotation, and for each annotated test class that is not found in any package directory.

# flags.filter-by-metadata.summary

Only include tests that explicitly declare metadata dependencies matching changed metadata.

# flags.filter-by-metadata.description

When enabled with `manifest`, test selection is based on metadata changes (e.g., Flow, CustomObject) rather than Apex annotations.

# flags.fail-on-empty.summary

Fail with exit code 1 if no test methods are found.

# flags.fail-on-empty.description

If provided, the command exits with code 1 when no test methods are found. When combined with `--manifest`, the command still exits with code 0 if the manifest contains no `ApexClass` or `ApexTrigger` members, since there is nothing to test in that case.

# errors.noTestsFound

No test methods found.

# examples

- List all test annotations found in package directories in Salesforce CLI format:

  <%= config.bin %> <%= command.id %> --format sf

- List all test annotations in CSV format:

  <%= config.bin %> <%= command.id %> --format csv

- List test annotations only for Apex classes/triggers in a manifest file:

  <%= config.bin %> <%= command.id %> --format sf --manifest package.xml

- List test annotations only if they exist in the package directories:

  <%= config.bin %> <%= command.id %> --format sf --ignore-missing-tests

- Exclude annotations found in the "force-app" directory:

  <%= config.bin %> <%= command.id %> -d "force-app"

- Fail with exit code 1 if a manifest declares Apex but no tests are found for it (exit 0 if the manifest has no Apex at all):

  <%= config.bin %> <%= command.id %> --format sf --manifest package.xml --fail-on-empty

- List test annotations without printing warnings for each file missing annotations:

  <%= config.bin %> <%= command.id %> -n
