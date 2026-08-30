import GLib from "gi://GLib";
import System from "system";

let passed = 0;
let failed = 0;

export function assert(cond, name) {
  if (cond) {
    passed++;
    print(`ok - ${name}`);
  } else {
    failed++;
    print(`FAIL - ${name}`);
  }
}

export async function waitFor(pred, timeoutMs = 8000) {
  const start = GLib.get_monotonic_time();
  while (!pred()) {
    if ((GLib.get_monotonic_time() - start) / 1000 > timeoutMs) return false;
    await new Promise((r) =>
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        r();
        return GLib.SOURCE_REMOVE;
      }),
    );
  }
  return true;
}

export function sleepMs(ms) {
  return new Promise((r) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      r();
      return GLib.SOURCE_REMOVE;
    }),
  );
}

export function runMain(main) {
  const loop = GLib.MainLoop.new(null, false);
  let code = 1;
  main()
    .then(() => {
      code = failed === 0 ? 0 : 1;
    })
    .catch((e) => {
      printerr(e);
      code = 1;
    })
    .finally(() => loop.quit());
  loop.run();
  print(`${passed} passed, ${failed} failed`);
  System.exit(code);
}
