import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceMutationCoordinator } from "../server/app/workspaceMutationCoordinator";

test("workspace mutation leases are FIFO per normalized project root", async () => {
  const coordinator = new WorkspaceMutationCoordinator();
  const first = await coordinator.acquire("C:\\workspace\\project");
  const order: string[] = [];
  const second = coordinator.acquire("C:/workspace/project").then((release) => {
    order.push("second");
    return release;
  });
  const third = coordinator.acquire("C:/workspace//project/").then((release) => {
    order.push("third");
    return release;
  });

  await Promise.resolve();
  assert.deepEqual(order, []);
  first();
  const releaseSecond = await second;
  assert.deepEqual(order, ["second"]);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(order, ["second", "third"]);
  releaseThird();
});

test("a cancelled waiter leaves the queue and a retained command releases its lease", async () => {
  const coordinator = new WorkspaceMutationCoordinator();
  const first = await coordinator.acquire("/workspace/project");
  const abort = new AbortController();
  const cancelled = coordinator.acquire("/workspace/project", abort.signal);
  const next = coordinator.acquire("/workspace/project");
  abort.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(cancelled, /cancelled/);

  coordinator.retainForCommand("command_1", first);
  coordinator.releaseCommand("command_1");
  const releaseNext = await next;
  releaseNext();

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(new DOMException("already cancelled", "AbortError"));
  await assert.rejects(coordinator.acquire("/workspace/project", alreadyCancelled.signal), /already cancelled/);
});
