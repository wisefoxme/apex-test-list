const SF_PLUGIN_MAX_NODE_MAJOR = 24;
const nodeVersion = process.versions?.node ?? '';
const nodeMajorMatch = /^(\d+)/.exec(nodeVersion);
const nodeMajorVersion = nodeMajorMatch ? Number.parseInt(nodeMajorMatch[1], 10) : Number.NaN;
const shouldUseSfPlugin =
  Number.isFinite(nodeMajorVersion) && nodeMajorVersion <= SF_PLUGIN_MAX_NODE_MAJOR;

module.exports = {
  extends: shouldUseSfPlugin
    ? ['eslint-config-salesforce-typescript', 'plugin:sf-plugin/recommended']
    : ['eslint-config-salesforce-typescript'],
  root: true,
  rules: {
    header: 'off',
  },
};
