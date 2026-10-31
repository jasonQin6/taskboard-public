/**
 * 反代安全栅栏单测：受信来源解析与裁决是纯函数，全部用合成地址驱动，
 * 不起真服务。语义依据 ADR-0007——写面从严（受信来源 + 令牌），读面
 * 本机回环豁免；栅栏关（未配置）时永远放行。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleProxyGuard,
  evaluateProxyGuard,
  isLoopbackAddress,
  normalizeRemoteAddress,
  parseTrustedHosts,
  PROXY_TOKEN_HEADER,
} from "../src/http-guard.js";

test("parseTrustedHosts accepts IPv4/IPv6 literals and IPv4 CIDR, rejects the rest", () => {
  const hosts = parseTrustedHosts(["127.0.0.1", "10.0.0.0/8", "::1", "192.168.1.7/32"]);
  assert.equal(hosts.length, 4);
  for (const bad of ["proxy.example.com", "localhost", "10.0.0.0/33", "10.0.0.0/-1", "300.1.1.1", "10.0.0.0/", "/8", ""]) {
    assert.throws(() => parseTrustedHosts([bad]), undefined, `expected rejection: ${JSON.stringify(bad)}`);
  }
});

test("normalizeRemoteAddress strips IPv4-mapped IPv6 prefix", () => {
  assert.equal(normalizeRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeRemoteAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeRemoteAddress("::1"), "::1");
  assert.equal(normalizeRemoteAddress(undefined), undefined);
});

test("isLoopbackAddress covers 127.0.0.0/8 and ::1 (mapped forms included)", () => {
  for (const yes of ["127.0.0.1", "127.255.0.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(yes), true, yes);
  }
  for (const no of ["10.0.0.1", "192.168.1.7", "::2", "::ffff:10.0.0.1", undefined]) {
    assert.equal(isLoopbackAddress(no), false, String(no));
  }
});

test("guard off (no config): everything is allowed, token headers are ignored", () => {
  for (const input of [
    { method: "POST", remoteAddress: "203.0.113.9", tokenHeader: "wrong" },
    { method: "POST", remoteAddress: undefined },
    { method: "GET", remoteAddress: "203.0.113.9" },
    { method: "GET", remoteAddress: "127.0.0.1", tokenHeader: PROXY_TOKEN_HEADER },
  ]) {
    const verdict = evaluateProxyGuard(undefined, input);
    assert.deepEqual(verdict, { allowed: true }, JSON.stringify(input));
  }
});

test("guard on, write: untrusted source is 403 even with a correct token", () => {
  const guard = assembleProxyGuard({
    trustedProxyHosts: ["10.0.0.0/8"],
    proxyTokenEnv: "TB_TOKEN",
    env: { TB_TOKEN: "sekret" },
  });
  assert.ok(guard !== undefined);
  const verdict = evaluateProxyGuard(guard, {
    method: "POST",
    remoteAddress: "203.0.113.9",
    tokenHeader: "sekret",
  });
  assert.deepEqual(verdict, { allowed: false, status: 403, error: "request source is not a trusted proxy" });
});

test("guard on, write: trusted source without token env passes on source alone", () => {
  const guard = assembleProxyGuard({ trustedProxyHosts: ["10.0.0.5"], env: {} });
  assert.ok(guard !== undefined);
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "POST", remoteAddress: "10.0.0.5" }),
    { allowed: true },
  );
});

test("guard on, write: token missing or wrong is 401, correct token passes", () => {
  const guard = assembleProxyGuard({
    trustedProxyHosts: ["127.0.0.0/8"],
    proxyTokenEnv: "TB_TOKEN",
    env: { TB_TOKEN: "sekret" },
  });
  assert.ok(guard !== undefined);
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "POST", remoteAddress: "127.0.0.1" }),
    { allowed: false, status: 401, error: "proxy token missing or incorrect" },
  );
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "POST", remoteAddress: "127.0.0.1", tokenHeader: "nope" }),
    { allowed: false, status: 401, error: "proxy token missing or incorrect" },
  );
  // Node 把重复的未知头合并为 "a, b"：追加式伪造拼串后必不等。
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "POST", remoteAddress: "127.0.0.1", tokenHeader: "sekret, sekret" }),
    { allowed: false, status: 401, error: "proxy token missing or incorrect" },
  );
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "POST", remoteAddress: "127.0.0.1", tokenHeader: "sekret" }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateProxyGuard(guard, {
      method: "POST",
      remoteAddress: "::ffff:127.0.0.1", // IPv4-mapped 归一化后命中 127.0.0.0/8
      tokenHeader: "sekret",
    }),
    { allowed: true },
  );
});

test("guard on, read: loopback origin passes without token even when untrusted", () => {
  const guard = assembleProxyGuard({
    trustedProxyHosts: ["10.0.0.0/8"],
    proxyTokenEnv: "TB_TOKEN",
    env: { TB_TOKEN: "sekret" },
  });
  assert.ok(guard !== undefined);
  for (const method of ["GET", "HEAD"]) {
    assert.deepEqual(
      evaluateProxyGuard(guard, { method, remoteAddress: "127.0.0.1" }),
      { allowed: true },
      method,
    );
    assert.deepEqual(
      evaluateProxyGuard(guard, { method, remoteAddress: "::1" }),
      { allowed: true },
      method,
    );
  }
});

test("guard on, read: trusted non-loopback source follows the token gate; others 403", () => {
  const guard = assembleProxyGuard({
    trustedProxyHosts: ["10.0.0.0/8"],
    proxyTokenEnv: "TB_TOKEN",
    env: { TB_TOKEN: "sekret" },
  });
  assert.ok(guard !== undefined);
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "GET", remoteAddress: "10.0.0.5" }),
    { allowed: false, status: 401, error: "proxy token missing or incorrect" },
  );
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "GET", remoteAddress: "10.0.0.5", tokenHeader: "sekret" }),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "GET", remoteAddress: "203.0.113.9", tokenHeader: "sekret" }),
    { allowed: false, status: 403, error: "request source is not a trusted proxy" },
  );
});

test("guard on: unknown/missing remote address fails closed (403 on writes)", () => {
  const guard = assembleProxyGuard({ trustedProxyHosts: ["127.0.0.0/8"], env: {} });
  assert.ok(guard !== undefined);
  assert.deepEqual(
    evaluateProxyGuard(guard, { method: "POST", remoteAddress: undefined }),
    { allowed: false, status: 403, error: "request source is not a trusted proxy" },
  );
  // 读面未知地址也不是回环 → 403
  assert.equal(
    evaluateProxyGuard(guard, { method: "GET", remoteAddress: "mailroot" }).allowed,
    false,
  );
});

test("assembleProxyGuard: empty host list means guard off (tokenEnv ignored)", () => {
  assert.equal(assembleProxyGuard({ trustedProxyHosts: [], proxyTokenEnv: "TB_TOKEN", env: {} }), undefined);
});

test("assembleProxyGuard: token env missing or blank fails closed with a clear error", () => {
  assert.throws(
    () => assembleProxyGuard({ trustedProxyHosts: ["127.0.0.0/8"], proxyTokenEnv: "MISSING_VAR", env: {} }),
    /MISSING_VAR/,
  );
  assert.throws(
    () =>
      assembleProxyGuard({
        trustedProxyHosts: ["127.0.0.0/8"],
        proxyTokenEnv: "BLANK_VAR",
        env: { BLANK_VAR: "   " },
      }),
    /BLANK_VAR/,
  );
});

test("assembleProxyGuard: invalid host entry fails closed", () => {
  assert.throws(
    () => assembleProxyGuard({ trustedProxyHosts: ["proxy.example.com"], env: {} }),
    /proxy\.example\.com/,
  );
});
