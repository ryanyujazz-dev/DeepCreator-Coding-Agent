import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("publishes the native update assets required by macOS and Windows", () => {
  const forge = readFileSync(path.join(root, "forge.config.ts"), "utf8");
  const main = readFileSync(path.join(root, "desktop/main.ts"), "utf8");
  const packageJson = readFileSync(path.join(root, "package.json"), "utf8");
  const release = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

  assert.match(forge, /new MakerZIP\(\{\}, \["darwin"\]\)/);
  assert.match(forge, /new MakerSquirrel\([\s\S]*name: "deepcreator"[\s\S]*\["win32"\]\)/);
  assert.match(forge, /certificateFile: windowsCertificateFile/);
  assert.match(forge, /icon: appIcon/);
  assert.match(forge, /setupIcon: "assets\/app-icon\.ico"/);
  assert.match(main, /UpdateSourceType\.ElectronPublicUpdateService/);
  assert.match(main, /notifyUser: false/);
  assert.match(main, /updateInterval: "6 hours"/);
  assert.match(release, /artifacts\/\*\*\/\*\.nupkg/);
  assert.match(release, /artifacts\/\*\*\/RELEASES/);
  assert.match(release, /apple-actions\/import-codesign-certs@v5/);
  assert.match(release, /WINDOWS_CERTIFICATE_FILE=\$certificatePath/);
  assert.match(release, /npm run release:validate-version/);
  assert.match(packageJson, /"make:mac:arm64"/);
  assert.match(packageJson, /"make:mac:x64"/);
  assert.match(release, /macos-15-intel/);
  assert.match(release, /DeepCreator-\$\{\{ matrix\.artifact \}\}/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /sha256sum/);
});

test("ships native application icons for every packaged desktop target", () => {
  const pngPath = path.join(root, "assets/app-icon.png");
  const icnsPath = path.join(root, "assets/app-icon.icns");
  const icoPath = path.join(root, "assets/app-icon.ico");

  assert.equal(existsSync(path.join(root, "assets/app-icon.svg")), true);
  assert.equal(existsSync(pngPath), true);
  assert.equal(readFileSync(pngPath).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(readFileSync(icnsPath).subarray(0, 4).toString("ascii"), "icns");
  assert.equal(readFileSync(icoPath).subarray(0, 4).toString("hex"), "00000100");
});
