import "../helpers/env";
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { auth, makeDealership, makeUser, prisma, resetDb } from "../helpers/db";

const app = createApp();
const base = "/api/v1";

describe("authorization", () => {
  beforeEach(resetDb);

  it("requires authentication on protected routes", async () => {
    for (const path of ["/users", "/dealerships", "/budgets", "/bills", "/schedules", "/notifications", "/analytics/overview"]) {
      const res = await request(app).get(`${base}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("allows admins to provision users; blocks accountants", async () => {
    const d = await makeDealership();
    const { token: adminToken } = await makeUser({ role: "ADMIN" });
    const { token: acctToken } = await makeUser({ role: "ACCOUNTANT", dealershipIds: [d.id] });

    const create = await request(app)
      .post(`${base}/users`)
      .set(auth(adminToken))
      .send({
        fullName: "New Acct",
        email: "new@test.local",
        password: "password1",
        role: "ACCOUNTANT",
        dealershipIds: [d.id],
      });
    expect(create.status).toBe(201);
    expect(create.body.data.role).toBe("accountant");
    expect(create.body.data.dealershipIds).toEqual([d.id]);
    expect(create.body.data.password).toBeUndefined();

    const denied = await request(app)
      .post(`${base}/users`)
      .set(auth(acctToken))
      .send({ fullName: "X", email: "x@test.local", password: "password1", role: "ACCOUNTANT" });
    expect(denied.status).toBe(403);
  });

  it("blocks role escalation through update endpoints", async () => {
    const { token: adminToken } = await makeUser({ role: "ADMIN" });
    const { user: acct } = await makeUser({ role: "ACCOUNTANT" });

    // strict schema rejects the role field outright
    const res = await request(app)
      .patch(`${base}/users/${acct.id}`)
      .set(auth(adminToken))
      .send({ role: "ADMIN" });
    expect(res.status).toBe(400);

    const unchanged = await prisma.user.findUnique({ where: { id: acct.id } });
    expect(unchanged!.role).toBe("ACCOUNTANT");
  });

  it("prevents self status change even for admins", async () => {
    const { user: admin, token: adminToken } = await makeUser({ role: "ADMIN" });
    const res = await request(app)
      .patch(`${base}/users/${admin.id}/status`)
      .set(auth(adminToken))
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it("deactivating a user revokes their refresh tokens", async () => {
    const { token: adminToken } = await makeUser({ role: "ADMIN" });
    const { user: acct } = await makeUser({ role: "ACCOUNTANT", password: "account123" });
    const login = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: acct.email, password: "account123" });
    const rt = login.body.data.refreshToken;

    await request(app)
      .patch(`${base}/users/${acct.id}/status`)
      .set(auth(adminToken))
      .send({ isActive: false });

    const res = await request(app).post(`${base}/auth/refresh`).send({ refreshToken: rt });
    expect(res.status).toBe(401);
  });

  it("scopes dealership list to accountant assignments", async () => {
    const mine = await makeDealership();
    const other = await makeDealership();
    const { token } = await makeUser({ role: "ACCOUNTANT", dealershipIds: [mine.id] });
    const res = await request(app).get(`${base}/dealerships`).set(auth(token));
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((d: { id: string }) => d.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);

    // direct access to an unassigned dealership is denied
    const single = await request(app).get(`${base}/dealerships/${other.id}`).set(auth(token));
    expect(single.status).toBe(403);
  });

  it("denies accountants ALL budget endpoints", async () => {
    const { token } = await makeUser({ role: "ACCOUNTANT" });
    for (const [method, path] of [
      ["get", "/budgets"],
      ["get", "/budgets/summary"],
      ["post", "/budgets"],
      ["get", "/analytics/budget-vs-actual"],
      ["get", "/analytics/overview"],
    ] as const) {
      const res = await request(app)[method](`${base}${path}`).set(auth(token)).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("denies accountants review decisions and admin mutations", async () => {
    const { token } = await makeUser({ role: "ACCOUNTANT" });
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const review = await request(app)
      .post(`${base}/bills/${fakeId}/review`)
      .set(auth(token))
      .send({ decision: "APPROVED" });
    expect(review.status).toBe(403);

    const mkDealer = await request(app)
      .post(`${base}/dealerships`)
      .set(auth(token))
      .send({ name: "X", code: "XX", address: "a", city: "c" });
    expect(mkDealer.status).toBe(403);
  });

  it("accountants cannot read other users' notifications", async () => {
    const { user: a, token: ta } = await makeUser({ role: "ACCOUNTANT" });
    const { user: b } = await makeUser({ role: "ACCOUNTANT" });
    await prisma.notification.create({
      data: { recipientId: a.id, type: "system", title: "hi", message: "m" },
    });
    const nB = await prisma.notification.create({
      data: { recipientId: b.id, type: "system", title: "b", message: "m" },
    });

    const listA = await request(app).get(`${base}/notifications`).set(auth(ta));
    expect(listA.body.data.items).toHaveLength(1);

    // A cannot mark B's notification
    const res = await request(app).patch(`${base}/notifications/${nB.id}/read`).set(auth(ta));
    expect(res.status).toBe(404);
  });
});
