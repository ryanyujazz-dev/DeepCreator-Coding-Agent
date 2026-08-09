import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeUpdateController,
  NativeUpdateDownload,
  UpdateManager
} from "../desktop/updateManager";

class FakeUpdater implements NativeUpdateController {
  checks = 0;
  installs = 0;
  private availableListener: () => void = () => undefined;
  private checkingListener: () => void = () => undefined;
  private downloadedListener: (download: NativeUpdateDownload) => void = () => undefined;
  private errorListener: (error: Error) => void = () => undefined;
  private notAvailableListener: () => void = () => undefined;

  checkForUpdates(): void {
    this.checks += 1;
  }

  onAvailable(listener: () => void): void {
    this.availableListener = listener;
  }

  onChecking(listener: () => void): void {
    this.checkingListener = listener;
  }

  onDownloaded(listener: (download: NativeUpdateDownload) => void): void {
    this.downloadedListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  onNotAvailable(listener: () => void): void {
    this.notAvailableListener = listener;
  }

  quitAndInstall(): void {
    this.installs += 1;
  }

  checking(): void {
    this.checkingListener();
  }

  available(): void {
    this.availableListener();
  }

  downloaded(download: NativeUpdateDownload): void {
    this.downloadedListener(download);
  }

  error(error: Error): void {
    this.errorListener(error);
  }

  notAvailable(): void {
    this.notAvailableListener();
  }
}

function createManager(overrides: Partial<ConstructorParameters<typeof UpdateManager>[0]> = {}) {
  const updater = new FakeUpdater();
  let configured = 0;
  let prepared = 0;
  let stopped = 0;
  const manager = new UpdateManager({
    configure: () => {
      configured += 1;
      return { stopUpdates: () => { stopped += 1; } };
    },
    currentVersion: "0.1.0",
    isPackaged: true,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    platform: "darwin",
    prepareToInstall: async () => { prepared += 1; },
    updater,
    ...overrides
  });
  return { configured: () => configured, manager, prepared: () => prepared, stopped: () => stopped, updater };
}

test("keeps development builds disconnected from the release updater", () => {
  const fixture = createManager({ isPackaged: false });

  assert.equal(fixture.manager.initialize().phase, "unsupported");
  assert.equal(fixture.manager.getState().supported, false);
  assert.equal(fixture.configured(), 0);
  assert.equal(fixture.updater.checks, 0);
});

test("projects native update events into a safe install lifecycle", async () => {
  const fixture = createManager();
  const phases: string[] = [];
  fixture.manager.onState((state) => phases.push(state.phase));

  assert.equal(fixture.manager.initialize().phase, "idle");
  assert.equal(fixture.configured(), 1);
  fixture.updater.checking();
  fixture.updater.available();
  fixture.updater.downloaded({
    releaseDate: new Date("2026-08-11T00:00:00.000Z"),
    releaseName: "v0.2.0",
    releaseNotes: "Safer updates and a smaller titlebar."
  });

  assert.deepEqual(phases, ["checking", "downloading", "ready"]);
  assert.equal(fixture.stopped(), 1);
  assert.deepEqual(fixture.manager.getState(), {
    availableVersion: "v0.2.0",
    checkedAt: "2026-08-10T00:00:00.000Z",
    currentVersion: "0.1.0",
    detail: undefined,
    phase: "ready",
    releaseDate: "2026-08-11T00:00:00.000Z",
    releaseNotes: "Safer updates and a smaller titlebar.",
    supported: true
  });

  await fixture.manager.install();
  assert.equal(fixture.prepared(), 1);
  assert.equal(fixture.updater.installs, 1);
  assert.equal(fixture.manager.getState().phase, "installing");
  fixture.manager.dispose();
  assert.equal(fixture.stopped(), 1);
});

test("supports manual checks and exposes recoverable updater errors", () => {
  const fixture = createManager();
  fixture.manager.initialize();
  fixture.updater.notAvailable();
  assert.equal(fixture.manager.getState().phase, "current");

  fixture.manager.check();
  assert.equal(fixture.updater.checks, 1);
  assert.equal(fixture.manager.getState().phase, "checking");
  fixture.updater.error(new Error("release service unavailable"));
  assert.equal(fixture.manager.getState().phase, "error");
  assert.equal(fixture.manager.getState().detail, "release service unavailable");
});
