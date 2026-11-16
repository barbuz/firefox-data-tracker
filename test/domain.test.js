import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hostOf,
  registrableDomain,
  isIpAddress,
  siteKeyForRequest,
  servingHostForRequest,
} from "../src/lib/domain.js";

test("hostOf parses and lower-cases hostnames", () => {
  assert.equal(hostOf("https://Example.COM/path?x=1"), "example.com");
  assert.equal(hostOf("http://a.b.co.uk:8080/"), "a.b.co.uk");
  assert.equal(hostOf("about:blank"), "");
  assert.equal(hostOf(""), "");
  assert.equal(hostOf(undefined), "");
});

test("registrableDomain handles simple and multi-label suffixes", () => {
  assert.equal(registrableDomain("www.example.com"), "example.com");
  assert.equal(registrableDomain("a.b.c.example.com"), "example.com");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("shop.example.com.au"), "example.com.au");
  assert.equal(registrableDomain("EXAMPLE.com."), "example.com");
});

test("registrableDomain leaves IP addresses untouched", () => {
  assert.equal(registrableDomain("192.168.1.10"), "192.168.1.10");
  assert.equal(registrableDomain("2001:db8::1"), "2001:db8::1");
  assert.ok(isIpAddress("10.0.0.1"));
  assert.ok(isIpAddress("::1"));
  assert.ok(!isIpAddress("example.com"));
});

test("site attribution uses the document URL for sub-resources", () => {
  const details = {
    url: "https://cdn.example.net/app.js",
    documentUrl: "https://www.example.com/page",
    type: "script",
  };
  assert.equal(siteKeyForRequest(details), "example.com");
  assert.equal(servingHostForRequest(details), "cdn.example.net");
});

test("site attribution falls back to the request URL for top-level documents", () => {
  const details = {
    url: "https://www.example.com/",
    documentUrl: undefined,
    type: "main_frame",
  };
  assert.equal(siteKeyForRequest(details), "example.com");
});
