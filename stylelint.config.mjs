export default {
  ignoreFiles: ["dist/**", "node_modules/**", "out/**"],
  rules: {
    "block-no-empty": true,
    "color-no-invalid-hex": true,
    "declaration-block-no-duplicate-custom-properties": true,
    "declaration-block-no-duplicate-properties": [true, {
      ignore: ["consecutive-duplicates-with-different-values"]
    }],
    "no-duplicate-at-import-rules": true,
    "selector-anb-no-unmatchable": true
  },
  overrides: [{
    files: ["src/styles/**/*.css"],
    rules: { "color-no-hex": true }
  }]
};
