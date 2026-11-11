# Building `.test-dependencies.yml`

`sf apextests list --manifest package.xml --filter-by-metadata` ignores Apex
annotations and selects tests from `.test-dependencies.yml` in the project
root instead: a test is selected when any metadata in the manifest matches one
of its entries.

```yaml
AccountServiceTest:
  - CustomField:Account.Industry
  - ValidationRule:Account.RequiredEmail
  - Flow:Account_After_Save

OpportunityServiceTest:
  - CustomObject:Opportunity
  - CustomField:Opportunity.*
```

## Format

- Top-level keys are test class names. Each holds a list of
  `MetadataType:Member` strings using Metadata API type names, the same ones a
  `package.xml` uses (for example from sfdx-git-delta).
- Child members use `Parent.Child`: `CustomField:Account.Industry`,
  `ValidationRule:Account.RequiredEmail`, `RecordType:Account.Partner`.
- One `*` matches the rest of a name: `CustomField:Opportunity.*` matches every
  Opportunity field.
- apextestlist fails if the file isn't a map of string lists.

## Finding the dependencies

For each test class the user cares about, read the test code and its direct
callees, and look for:

| In the code                                                              | Entry                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| DML on an object whose flows or triggers the test asserts on             | `Flow:<FlowApiName>` for record-triggered flows on that object |
| `Account.Industry`, `acc.Industry = ...`, `SELECT Industry FROM Account` | `CustomField:Account.Industry` (custom fields end in `__c`)    |
| assertions on a `DmlException` with a validation message                 | `ValidationRule:<Object>.<RuleName>`                           |
| `Schema.SObjectType.Foo__c`, `new Foo__c()`                              | `CustomObject:Foo__c`                                          |
| `Flow.Interview.<Name>`                                                  | `Flow:<Name>`                                                  |

To find record-triggered flows for an object, search the project's
`*.flow-meta.xml` files for `<object>Account</object>` together with a
`<triggerType>` of `RecordAfterSave` or `RecordBeforeSave`. Validation rules
are in `objects/<Object>/validationRules/`.

Only add standard fields (`Account.Name`) when the test asserts on behavior
that depends on them; they rarely change through deployments.

## Checks

- Every key must be a local `@isTest` class. Run the audit
  (`apex-test-map.mjs audit`), which reports unknown keys and entries that
  aren't `Type:Member`.
- If an existing file is present, merge into it. Keep the user's entries and
  ordering, and show the diff before saving.
