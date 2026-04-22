const pkg = require('./package.json');

module.exports = {
  branches: ["master"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    [
      "@semantic-release/npm",
      {
        npmPublish: false,
      },
    ],
    "@semantic-release/git",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          `zip -qq -r ${pkg.name}-\${nextRelease.version}.zip dist readme.md logo.svg LICENSE package.json`,
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: `${pkg.name}-*.zip`,
      },
    ],
  ],
};
