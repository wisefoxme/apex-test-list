# summary

Use the Apex Tests List tool to list specific tests on your Salesforce DX repository. If no tests are found, all classes with the `@IsTest` annotation will be included in the list. The tests you want listed must meet some criteria, such as having a specific comment to annotate them to show up on this list. Please refer to the documentation on the project's GitHub page for more information if needed.

# description

Lists tests in a package.xml file or from your package directories.

# flags.format.summary

Format of the output.

# flags.format.description

By default, the format being returned is a list in the format that can be merged with the test flags of the Salesforce CLI deploy and validate commands. Available formats are `sf` (default) and `csv`.

# flags.manifest.summary

Manifest XML file.

# flags.manifest.description

When you specify a manifest file, the plugin will not search directories for all classes with annotations, but instead will read the manifest file and search for those classes within your package directories.

# flags.ignore-missing-tests.summary

Ignore missing test methods.

# flags.ignore-missing-tests.description

If provided, ignore test methods that are not found in any of the package directories.

# flags.ignore-package-directory.summary

Ignore a package directory.

# flags.ignore-package-directory.description

If provided, do not search the package directory for test annotations.

# flags.no-warnings.summary

Do not print warnings for each Apex file missing annotations.

# flags.no-warnings.description

Do not print warnings for each Apex file missing annotations.

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

- <%= config.bin %> <%= command.id %> --format csv
- <%= config.bin %> <%= command.id %> --format sf
- <%= config.bin %> <%= command.id %> --format sf --manifest package.xml
- <%= config.bin %> <%= command.id %> --format sf --manifest package.xml --ignore-missing-tests
- <%= config.bin %> <%= command.id %> --format sf --manifest package.xml -d "force-app"
- <%= config.bin %> <%= command.id %> --format sf --manifest package.xml --fail-on-empty
