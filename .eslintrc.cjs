const SF_PLUGIN_MAX_NODE_MAJOR = 24;
const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
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
