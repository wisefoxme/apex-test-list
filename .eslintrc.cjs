const LAST_SUPPORTED_NODE_VERSION_FOR_SF_PLUGIN = 24;
const nodeVersion = process.versions?.node ?? '';
const nodeMajorMatch = /^(\d+)/.exec(nodeVersion);
const nodeMajorVersion = nodeMajorMatch ? Number.parseInt(nodeMajorMatch[1], 10) : NaN;
const shouldUseSfPlugin =
  Number.isFinite(nodeMajorVersion) && nodeMajorVersion <= LAST_SUPPORTED_NODE_VERSION_FOR_SF_PLUGIN;

module.exports = {
  extends: shouldUseSfPlugin
    ? ['eslint-config-salesforce-typescript', 'plugin:sf-plugin/recommended']
    : ['eslint-config-salesforce-typescript'],
  root: true,
  rules: {
    header: 'off',
  },
};
