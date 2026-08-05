import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PLUGIN_VERSION } from "../src/version.mjs";

test("runtime version matches plugin manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../plugin.json", import.meta.url), "utf8"),
  );
  const packageManifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(PLUGIN_VERSION, manifest.version);
  assert.equal(PLUGIN_VERSION, packageManifest.version);
  assert.equal(manifest.skills, "./skills/");
});
