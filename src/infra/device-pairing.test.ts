import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  rejectDevicePairing,
  requestDevicePairing,
  verifyDeviceToken,
} from "./device-pairing.js";
import { FsStorageBackend } from "./storage-backend.js";

let tmpDir: string;
let storage: FsStorageBackend;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-device-pair-"));
  // Pre-create lock parent so FsStorageBackend.withLock (recursive:false mkdir) works
  fs.mkdirSync(path.join(tmpDir, ".locks", "pair"), { recursive: true });
  storage = new FsStorageBackend(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("device pairing (storage backend)", () => {
  it("list returns empty pending and paired", async () => {
    const list = await listDevicePairing(undefined, storage);
    expect(list.pending).toEqual([]);
    expect(list.paired).toEqual([]);
  });

  it("request pairing creates pending, second request returns created=false", async () => {
    const first = await requestDevicePairing(
      { deviceId: "dev-1", publicKey: "pk-1" },
      undefined,
      storage,
    );
    expect(first.status).toBe("pending");
    expect(first.created).toBe(true);
    expect(first.request.deviceId).toBe("dev-1");

    const second = await requestDevicePairing(
      { deviceId: "dev-1", publicKey: "pk-1" },
      undefined,
      storage,
    );
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  it("approve pairing flow: paired device retrievable, pending cleared", async () => {
    const req = await requestDevicePairing(
      { deviceId: "dev-2", publicKey: "pk-2", displayName: "Test Device" },
      undefined,
      storage,
    );
    const approved = await approveDevicePairing(req.request.requestId, undefined, storage);
    expect(approved).not.toBeNull();
    expect(approved!.device.deviceId).toBe("dev-2");

    const paired = await getPairedDevice("dev-2", undefined, storage);
    expect(paired).not.toBeNull();
    expect(paired!.displayName).toBe("Test Device");

    const list = await listDevicePairing(undefined, storage);
    expect(list.pending).toHaveLength(0);
    expect(list.paired).toHaveLength(1);
  });

  it("reject pairing flow: pending cleared, paired stays empty", async () => {
    const req = await requestDevicePairing(
      { deviceId: "dev-3", publicKey: "pk-3" },
      undefined,
      storage,
    );
    const rejected = await rejectDevicePairing(req.request.requestId, undefined, storage);
    expect(rejected).not.toBeNull();
    expect(rejected!.deviceId).toBe("dev-3");

    const list = await listDevicePairing(undefined, storage);
    expect(list.pending).toHaveLength(0);
    expect(list.paired).toHaveLength(0);
  });

  it("token verification: correct token ok, wrong token fails", async () => {
    const req = await requestDevicePairing(
      { deviceId: "dev-4", publicKey: "pk-4", role: "operator", scopes: ["read"] },
      undefined,
      storage,
    );
    const approved = await approveDevicePairing(req.request.requestId, undefined, storage);
    const token = approved!.device.tokens?.operator?.token;
    expect(token).toBeDefined();

    const ok = await verifyDeviceToken({
      deviceId: "dev-4",
      token: token!,
      role: "operator",
      scopes: ["read"],
      storage,
    });
    expect(ok.ok).toBe(true);

    const bad = await verifyDeviceToken({
      deviceId: "dev-4",
      token: "wrong-token",
      role: "operator",
      scopes: ["read"],
      storage,
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("token-mismatch");
  });

  it("list shows both pending and paired devices", async () => {
    // Create and approve one device
    const req1 = await requestDevicePairing(
      { deviceId: "dev-5", publicKey: "pk-5" },
      undefined,
      storage,
    );
    await approveDevicePairing(req1.request.requestId, undefined, storage);

    // Create a pending device
    await requestDevicePairing({ deviceId: "dev-6", publicKey: "pk-6" }, undefined, storage);

    const list = await listDevicePairing(undefined, storage);
    expect(list.paired).toHaveLength(1);
    expect(list.paired[0].deviceId).toBe("dev-5");
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0].deviceId).toBe("dev-6");
  });
});
