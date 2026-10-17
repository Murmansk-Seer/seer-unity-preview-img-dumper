import assert from "node:assert/strict";
import { test } from "node:test";
import axios, { AxiosError } from "axios";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  requestWithRetry, DownloadIntegrityError, REQUEST_TIMEOUT_MS, ATTEMPT_DEADLINE_MS,
} from "../parser/updater/network";
import Downloader from "../parser/updater/Downloader";
import Updater from "../parser/updater/Updater";
import YooVersionManager from "../parser/updater/YooVersionManager";

function clientWithFailures(failures: number, code = "ECONNRESET") {
  let calls = 0;
  const client = axios.create({ adapter: async (config) => {
    calls++;
    assert.equal(config.timeout, REQUEST_TIMEOUT_MS);
    assert.ok(config.signal);
    if (calls <= failures) throw new AxiosError("simulated failure", code);
    return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
  } });
  return { client, calls: () => calls };
}

test("network failures use at most three total attempts", async () => {
  const fixture = clientWithFailures(99);
  await assert.rejects(requestWithRetry(fixture.client, { url: "https://example.test" }, undefined, 0), /simulated/);
  assert.equal(fixture.calls(), 3);
});

test("third attempt may succeed, with no fourth request", async () => {
  const fixture = clientWithFailures(2);
  assert.equal((await requestWithRetry(fixture.client, { url: "https://example.test" }, undefined, 0)).data, "ok");
  assert.equal(fixture.calls(), 3);
});

test("successful requests are not repeated", async () => {
  const fixture = clientWithFailures(0);
  await requestWithRetry(fixture.client, { url: "https://example.test" }, undefined, 0);
  assert.equal(fixture.calls(), 1);
});

test("unexpected programming errors are not retried", async () => {
  let calls = 0;
  const client = axios.create({ adapter: async () => { calls++; throw new TypeError("bug"); } });
  await assert.rejects(requestWithRetry(client, { url: "https://example.test" }, undefined, 0), /bug/);
  assert.equal(calls, 1);
});

test("integrity failures share the same three-attempt budget", async () => {
  const fixture = clientWithFailures(0);
  await assert.rejects(requestWithRetry(fixture.client, { url: "https://example.test" }, () => {
    throw new DownloadIntegrityError("bad checksum");
  }, 0), /bad checksum/);
  assert.equal(fixture.calls(), 3);
});

test("explicit cancellation is propagated without retry", async () => {
  const fixture = clientWithFailures(99);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestWithRetry(fixture.client, { url: "https://example.test", signal: controller.signal }, undefined, 0));
  assert.equal(fixture.calls(), 0);
});

test("real HTTP requests time out after three attempts", async (t) => {
  let requests = 0;
  const server = createServer(() => { requests++; });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(requestWithRetry(axios, { url: `http://127.0.0.1:${port}`, timeout: 40 }, undefined, 0), /timeout/);
  assert.equal(requests, 3);
  assert.ok(ATTEMPT_DEADLINE_MS > REQUEST_TIMEOUT_MS);
});

test("permanent HTTP errors are not retried", async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(404); res.end(); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  await assert.rejects(requestWithRetry(axios, { url: `http://127.0.0.1:${port}` }, undefined, 0));
  assert.equal(requests, 1);
});

for (const status of [429, 503]) {
  test(`HTTP ${status} uses three total attempts`, async (t) => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.writeHead(status); res.end(); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => server.close());
    const port = (server.address() as { port: number }).port;
    await assert.rejects(requestWithRetry(axios, { url: `http://127.0.0.1:${port}` }, undefined, 0));
    assert.equal(requests, 3);
  });
}

test("manifest download failure never starts resources or saves state", async () => {
  let downloaded = 0, saved = 0;
  const manager = {
    getRemoteManifest: async () => { throw new Error("manifest unavailable"); },
    saveManifestToLocal: () => { saved++; },
  } as unknown as YooVersionManager;
  const downloader = { downloads: async () => { downloaded++; } } as unknown as Downloader;
  await assert.rejects(new Updater("test", "test", manager, downloader).update(), /manifest unavailable/);
  assert.equal(downloaded, 0);
  assert.equal(saved, 0);
});

test("version and manifest requests both use bounded retry", async (t) => {
  let versionRequests = 0, manifestRequests = 0;
  const server = createServer((req, res) => {
    const version = req.url!.includes(".version");
    const count = version ? ++versionRequests : ++manifestRequests;
    if (count < 3) { req.socket.destroy(); return; }
    res.end(version ? "20261016152125" : "manifest");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const manager = new YooVersionManager("DefaultPackage", `http://127.0.0.1:${port}/`, "unused", () => (
    { PackageVersion: "20261016152125", BundleList: [] } as any
  ));
  assert.equal((await manager.getRemoteManifest()).version, "20261016152125");
  assert.equal(versionRequests, 3);
  assert.equal(manifestRequests, 3);
});

test("resource download retries resets and validates MD5 before writing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "preview-download-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let requests = 0;
  const data = Buffer.from("validated bundle");
  const server = createServer((req, res) => {
    requests++;
    if (requests < 3) { req.socket.destroy(); return; }
    res.end(data);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const filename = join(directory, "bundle");
  await new Downloader().download({ url: `http://127.0.0.1:${port}`, filename, md5: createHash("md5").update(data).digest("hex") });
  assert.equal(requests, 3); // No redundant HEAD probe or nested retries.
  assert.deepEqual(readFileSync(filename), data);
});

test("failed download preserves existing file and does not advance manifest", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "preview-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "activityListPreview");
  writeFileSync(filename, "old validated bundle");
  let requests = 0, saved = 0;
  const server = createServer((_req, res) => { requests++; res.end("wrong checksum"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const manager = {
    getRemoteManifest: async () => ({ version: "new", items: new Map([[filename, { remoteFilename: `http://127.0.0.1:${port}`, fileHash: "0".repeat(32) }]]) }),
    loadLocalManifest: () => ({ version: "old", items: new Map() }),
    saveManifestToLocal: () => { saved++; },
  } as unknown as YooVersionManager;
  await assert.rejects(new Updater("test", "test", manager, new Downloader()).update(1), /MD5/);
  assert.equal(requests, 3);
  assert.equal(saved, 0);
  assert.equal(readFileSync(filename, "utf8"), "old validated bundle");
});

test("update CLI exits nonzero and the pipeline does not invoke extraction", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "preview-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, "extraction-started");
  // Run the real entry point with a permanent network failure, followed by the
  // same && boundary used by npm start. Never contact official servers in tests.
  const updateFile = join(directory, "update.mjs");
  const extractFile = join(directory, "extract.mjs");
  writeFileSync(updateFile, `import axios from ${JSON.stringify(pathToFileURL(resolve("node_modules/axios/index.js")).href)};
    axios.defaults.adapter = async () => { throw new TypeError("test download failure"); };
    await import(${JSON.stringify(pathToFileURL(resolve("parser/index.ts")).href)});`);
  writeFileSync(extractFile, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "extraction started");`);
  const first = spawnSync(`"${process.execPath}" --import tsx "${updateFile}" && "${process.execPath}" "${extractFile}"`, {
    shell: true, encoding: "utf8",
  });
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /更新失败/);
  assert.equal(existsSync(marker), false);
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "npm run update && npm run export && npm run merge");
});
