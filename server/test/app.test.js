import assert from "node:assert/strict";
import { before, test } from "node:test";
import request from "supertest";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/spice_management_test";
process.env.JWT_SECRET ??= "test-secret-with-more-than-32-characters-long";

let app;

before(async () => {
  ({ app } = await import("../src/app.js"));
});

test("health reports the database connection state", async () => {
  const response = await request(app).get("/health");

  assert.equal(response.status, 503);
  assert.equal(response.body.status, "database_unavailable");
});

test("sync endpoints require authentication", async () => {
  const response = await request(app).get("/api/v1/sync/pull");

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authentication_required");
});

test("registration rejects incomplete input", async () => {
  const response = await request(app).post("/api/v1/auth/register").send({ companyName: "Test" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "invalid_request");
});