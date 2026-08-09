import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("publishes the native update assets required by macOS and Windows", () => {
  const forge = readFileSync(path.join(root, "forge.config.ts"), "utf8");
  const main = readFileSync(path.join(root, "desktop/main.ts"), "utf8");
  const release = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

  assert.match(forge, /new MakerZIP\(\{\}, \["darwin"\]\)/);
  assert.match(forge, /new MakerSquirrel\([\s\S]*name: "deepcreator"[\s\S]*\["win32"\]\)/);
  assert.match(forge, /certificateFile: windowsCertificateFile/);
  assert.match(main, /UpdateSourceType\.ElectronPublicUpdateService/);
  assert.match(main, /notifyUser: false/);
  assert.match(main, /updateInterval: "6 hours"/);
  assert.match(release, /artifacts\/\*\*\/\*\.nupkg/);
  assert.match(release, /artifacts\/\*\*\/RELEASES/);
  assert.match(release, /apple-actions\/import-codesign-certs@v5/);
  assert.match(release, /WINDOWS_CERTIFICATE_FILE=\$certificatePath/);
  assert.match(release, /npm run release:validate-version/);
});
