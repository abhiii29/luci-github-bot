import { describe, it, expect } from "vitest";
import { applyPatch, removedLineFraction } from "../src/patch.js";
import { guardChanges } from "../src/change-guard.js";

const big = Array.from({ length: 300 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
const patch = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const none = async () => null;

describe("applyPatch", () => {
  it("replaces a unique block and keeps everything else", () => {
    const r = applyPatch(big, patch("export const line150 = 150;", "export const line150 = 150;\nexport const extra = true;"));
    expect(r.ok && r.content.split("\n").length).toBe(302);
    expect(r.ok && r.content).toContain("export const line299 = 299;");
    expect(r.ok && r.content).toContain("export const extra = true;");
  });

  it("applies several blocks in order", () => {
    const r = applyPatch("a\nb\nc\n", patch("a", "A") + "\n" + patch("c", "C"));
    expect(r).toEqual({ ok: true, content: "A\nb\nC\n" });
  });

  it("rejects a SEARCH that is missing or ambiguous", () => {
    expect(applyPatch(big, patch("nope", "x"))).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    expect(applyPatch("x\nx\n", patch("x", "y"))).toMatchObject({ ok: false, error: expect.stringContaining("2 places") });
  });

  it("tolerates trailing whitespace differences and keeps CRLF files CRLF", () => {
    expect(applyPatch("a  \nb\n", patch("a\nb", "z"))).toEqual({ ok: true, content: "z\n" });
    expect(applyPatch("a\r\nb\r\n", patch("a", "A"))).toEqual({ ok: true, content: "A\r\nb\r\n" });
  });

  it("rejects text without blocks", () => {
    expect(applyPatch(big, "just some code")).toMatchObject({ ok: false });
  });
});

describe("removedLineFraction", () => {
  it("measures dropped lines, not reordering", () => {
    expect(removedLineFraction("a\nb\nc\nd", "d\nc\nb\na")).toBe(0);
    expect(removedLineFraction("a\nb\nc\nd", "a")).toBe(0.75);
  });
});

describe("guardChanges", () => {
  const opts = (extra: Partial<Parameters<typeof guardChanges>[1]> = {}) => ({
    known: { "src/webhook.ts": big },
    truncatedPaths: ["src/webhook.ts"],
    issueText: "Add a GET /version endpoint",
    fetchCurrent: none,
    ...extra,
  });

  it("blocks the PR #5 failure: a whole-file update of a file the model saw truncated", async () => {
    const truncatedRewrite = big.split("\n").slice(0, 90).join("\n") + "\napp.get('/version', ...);\n";
    const r = await guardChanges([{ path: "src/webhook.ts", operation: "update", content: truncatedRewrite }], opts());
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("only saw partially") });
  });

  it("blocks an update that drops most of a file even if it was shown in full", async () => {
    const r = await guardChanges(
      [{ path: "src/webhook.ts", operation: "update", content: big.split("\n").slice(0, 90).join("\n") }],
      opts({ truncatedPaths: [] })
    );
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("% of the file") });
  });

  it("allows large removals the issue asks for", async () => {
    const r = await guardChanges(
      [{ path: "src/webhook.ts", operation: "update", content: "export {};\n" }],
      opts({ truncatedPaths: [], issueText: "Remove the legacy webhook constants" })
    );
    expect(r.ok).toBe(true);
  });

  it("turns a patch into a full-file update against the real current content", async () => {
    const r = await guardChanges(
      [{ path: "src/webhook.ts", operation: "patch", content: patch("export const line0 = 0;", "export const line0 = 0;\nexport const version = 1;") }],
      opts()
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files[0].operation).toBe("update");
      expect(r.files[0].content).toContain("export const line299 = 299;");
      expect(r.files[0].content).toContain("export const version = 1;");
    }
  });

  it("fetches files it doesn't know yet, and treats an update of a missing file as a create", async () => {
    const fetched: string[] = [];
    const r = await guardChanges(
      [
        { path: "src/other.ts", operation: "update", content: "x" },
        { path: "src/new.ts", operation: "update", content: "y" },
      ],
      opts({ fetchCurrent: async (p) => (fetched.push(p), p === "src/other.ts" ? "old\n" : null) })
    );
    expect(fetched).toEqual(["src/other.ts", "src/new.ts"]);
    expect(r.ok && r.files.map((f) => f.operation)).toEqual(["update", "create"]);
  });

  it("guards a 'create' that would overwrite an existing truncated file", async () => {
    const r = await guardChanges([{ path: "src/webhook.ts", operation: "create", content: "tiny" }], opts());
    expect(r.ok).toBe(false);
  });

  it("rejects a patch that does not apply", async () => {
    const r = await guardChanges([{ path: "src/webhook.ts", operation: "patch", content: patch("missing", "x") }], opts());
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
  });
});
