const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
const shouldUseSfPlugin = Number.isNaN(nodeMajorVersion) || nodeMajorVersion < 25;

module.exports = {
  extends: shouldUseSfPlugin
    ? ['eslint-config-salesforce-typescript', 'plugin:sf-plugin/recommended']
    : ['eslint-config-salesforce-typescript'],
  root: true,
  rules: {
    header: 'off',
  },
};
