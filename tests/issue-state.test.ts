import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { encodeState, decodeState, loadIssueState, saveIssueState, STATE_MARKER } from "../src/issue-state.js";
import type { GitHubClient } from "../src/github.js";

const ROOT = "/tmp/luci-issue-state-test-" + Date.now();
const A = path.join(ROOT, "a");
const B = path.join(ROOT, "b");

function write(dir: string, rel: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("encodeState / decodeState", () => {
  it("round-trips queue and plan files", () => {
    write(A, "queue.json", JSON.stringify({ jobs: [{ id: "1", status: "running", payload: { x: 1 } }], deliveries: [] }));
    write(A, "plans/o__r__3.json", '{"status":"pending","note":"reply /luci go -- now"}');
    const body = encodeState(A);
    expect(body.startsWith(STATE_MARKER)).toBe(true);
    // Must not end the HTML comment early or look like a command
    expect(body.slice(STATE_MARKER.length, body.indexOf(" -->"))).not.toMatch(/--|\/luci/);

    expect(decodeState(body, B)).toBe(2);
    expect(fs.readFileSync(path.join(B, "plans/o__r__3.json"), "utf-8")).toContain("/luci go");
    expect(JSON.parse(fs.readFileSync(path.join(B, "queue.json"), "utf-8")).jobs[0].payload).toEqual({ x: 1 });
  });

  it("drops payloads of finished jobs and old deliveries", () => {
    write(A, "queue.json", JSON.stringify({ jobs: [{ id: "1", status: "succeeded", payload: { big: "x" } }], deliveries: [{ id: "d" }] }));
    decodeState(encodeState(A), B);
    const q = JSON.parse(fs.readFileSync(path.join(B, "queue.json"), "utf-8"));
    expect(q.jobs[0].payload).toBeUndefined();
    expect(q.deliveries).toEqual([]);
  });

  it("refuses paths outside the state dir", () => {
    const evil = Buffer.from(JSON.stringify({ "../escape.json": "{}", "plans/../../x.json": "{}", "ok.txt": "x" })).toString("base64url");
    expect(decodeState(`<!-- luci-bot:state ${evil} -->`, B)).toBe(0);
    expect(fs.existsSync(path.join(ROOT, "escape.json"))).toBe(false);
  });

  it("ignores bodies without state", () => {
    expect(decodeState("hello", B)).toBe(0);
  });
});

describe("load/save via GitHub", () => {
  function fakeGh(existing?: { id: number; body: string }) {
    return {
      findCommentWithMarker: vi.fn(async () => existing),
      createComment: vi.fn(async () => ({ id: 9, url: "" })),
      updateComment: vi.fn(async () => {}),
    };
  }

  it("only trusts a comment by the bot account", async () => {
    const gh = fakeGh();
    await loadIssueState(gh as unknown as GitHubClient, "o/r", 3, "bot", B);
    expect(gh.findCommentWithMarker).toHaveBeenCalledWith("o/r", 3, STATE_MARKER, "bot");
  });

  it("creates the comment once, then updates it only when the state changed", async () => {
    write(A, "queue.json", '{"jobs":[],"deliveries":[]}');
    const created = fakeGh();
    await saveIssueState(created as unknown as GitHubClient, "o/r", 3, "bot", A);
    expect(created.createComment).toHaveBeenCalledOnce();

    const same = fakeGh({ id: 5, body: encodeState(A) });
    await saveIssueState(same as unknown as GitHubClient, "o/r", 3, "bot", A);
    expect(same.updateComment).not.toHaveBeenCalled();

    const stale = fakeGh({ id: 5, body: `${STATE_MARKER} e30 -->` });
    await saveIssueState(stale as unknown as GitHubClient, "o/r", 3, "bot", A);
    expect(stale.updateComment).toHaveBeenCalledWith("o/r", 5, encodeState(A));
  });

  it("writes nothing for an empty state dir", async () => {
    const gh = fakeGh();
    await saveIssueState(gh as unknown as GitHubClient, "o/r", 3, "bot", path.join(ROOT, "empty"));
    expect(gh.createComment).not.toHaveBeenCalled();
  });
});
