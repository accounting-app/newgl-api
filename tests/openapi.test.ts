import { describe, expect, test, beforeAll } from "bun:test";
import { createTestApp, readJson } from "./helpers/create-test-app";
describe("OpenAPI", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  test("GET /openapi.json returns OpenAPI 3.1 document", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = await readJson<{ openapi: string; info: { title: string } }>(res);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Bank Register API");
  });
});