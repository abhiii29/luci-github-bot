import { describe, it, expect, vi } from "vitest";
vi.mock("../src/docker-worker.js", () => ({ DockerWorker: class {} }));
const { isModelUnavailable } = await import("../src/issue-handler.js");

describe("isModelUnavailable", () => {
  it("recognises the Adesso/litellm outage seen live", () => {
    const err = Object.assign(new Error("502 litellm.BadGatewayError: BadGatewayError: OpenAIException - The model backend is unavailable."), { status: 502 });
    expect(isModelUnavailable(err)).toBe(true);
  });
  it("recognises connection failures, timeouts and rate limits", () => {
    expect(isModelUnavailable(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isModelUnavailable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isModelUnavailable(Object.assign(new Error("slow down"), { status: 429 }))).toBe(true);
    expect(isModelUnavailable(new Error("Ollama 503: loading model"))).toBe(true);
  });
  it("does not treat bugs as outages", () => {
    expect(isModelUnavailable(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isModelUnavailable(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
  });
});
