'use strict';

import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';

import { listTests } from '../../core/listTests.js';
import { ApextestsListResult } from '../../utils/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('apextestlist', 'apextests.list');

export default class ApextestsList extends SfCommand<ApextestsListResult> {
  public static override readonly summary = messages.getMessage('summary');
  public static override readonly description = messages.getMessage('description');
  public static override readonly examples = messages.getMessages('examples');

  public static override readonly flags = {
    format: Flags.string({
      summary: messages.getMessage('flags.format.summary'),
      description: messages.getMessage('flags.format.description'),
      char: 'f',
      required: false,
      default: 'sf',
    }),
    manifest: Flags.string({
      summary: messages.getMessage('flags.manifest.summary'),
      description: messages.getMessage('flags.manifest.description'),
      char: 'x',
      required: false,
    }),
    'ignore-missing-tests': Flags.boolean({
      summary: messages.getMessage('flags.ignore-missing-tests.summary'),
      description: messages.getMessage('flags.ignore-missing-tests.description'),
      required: false,
      char: 's',
      default: false,
    }),
    'ignore-package-directory': Flags.directory({
      summary: messages.getMessage('flags.ignore-package-directory.summary'),
      description: messages.getMessage('flags.ignore-package-directory.description'),
      char: 'd',
      required: false,
      multiple: true,
    }),
    'no-warnings': Flags.boolean({
      summary: messages.getMessage('flags.no-warnings.summary'),
      description: messages.getMessage('flags.no-warnings.description'),
      char: 'n',
      required: false,
      default: false,
    }),
    'filter-by-metadata': Flags.boolean({
      summary: messages.getMessage('flags.filter-by-metadata.summary'),
      description: messages.getMessage('flags.filter-by-metadata.description'),
      char: 'm',
      required: false,
      default: false,
    }),
  };

  public async run(): Promise<ApextestsListResult> {
    const { flags } = await this.parse(ApextestsList);

    const result = await listTests({
      format: flags.format,
      manifest: flags.manifest,
      ignoreMissingTests: flags['ignore-missing-tests'],
      ignoreDirs: flags['ignore-package-directory'],
      noWarnings: flags['no-warnings'],
      filterByMetadata: flags['filter-by-metadata'],
      warn: this.warn.bind(this),
    });

    this.log(result.command);
    return result;
  }
}
