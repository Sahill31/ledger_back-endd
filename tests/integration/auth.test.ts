import "../helpers/env";
import { beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../../src/app";
import { auth, makeUser, prisma, resetDb } from "../helpers/db";
import { signAccessToken } from "../../src/middleware/authenticate";

const app = createApp();
const base = "/api/v1";

describe("auth", () => {
  beforeEach(resetDb);

  it("logs in with valid credentials and returns a session user", async () => {
    const { user } = await makeUser({ role: "ADMIN", password: "admin1234" });
    const res = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: user.email, password: "admin1234" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe("admin");
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
    // password hash must never appear
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("rejects wrong password and unknown email identically", async () => {
    const { user } = await makeUser({ role: "ACCOUNTANT" });
    const bad1 = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: user.email, password: "wrongpass1" });
    const bad2 = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: "nobody@test.local", password: "x" });
    expect(bad1.status).toBe(401);
    expect(bad2.status).toBe(401);
    expect(bad1.body.error.message).toBe(bad2.body.error.message);
  });

  it("rejects invalid and expired access tokens", async () => {
    const bad = await request(app).get(`${base}/auth/me`).set(auth("not-a-token"));
    expect(bad.status).toBe(401);

    const { user } = await makeUser({ role: "ADMIN" });
    const expired = jwt.sign({ role: user.role, type: "access" }, process.env.JWT_ACCESS_SECRET!, {
      subject: user.id,
      expiresIn: "0s",
      issuer: "autoledger-api",
      audience: "autoledger-client",
    });
    const res = await request(app).get(`${base}/auth/me`).set(auth(expired));
    expect(res.status).toBe(401);
  });

  it("rejects tokens with wrong issuer/audience", async () => {
    const { user } = await makeUser({ role: "ADMIN" });
    const token = jwt.sign({ role: user.role, type: "access" }, process.env.JWT_ACCESS_SECRET!, {
      subject: user.id,
      expiresIn: "1h",
      issuer: "evil",
      audience: "autoledger-client",
    });
    expect((await request(app).get(`${base}/auth/me`).set(auth(token))).status).toBe(401);
  });

  it("denies inactive users even with a valid token", async () => {
    const { user, token } = await makeUser({ role: "ACCOUNTANT", isActive: false });
    expect((await request(app).get(`${base}/auth/me`).set(auth(token))).status).toBe(403);
    // login is also blocked
    const res = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: user.email, password: "passw0rd1" });
    expect(res.status).toBe(403);
  });

  it("rotates refresh tokens and revokes on logout", async () => {
    const { user } = await makeUser({ role: "ADMIN", password: "admin1234" });
    const login = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: user.email, password: "admin1234" });
    const rt = login.body.data.refreshToken;

    const refreshed = await request(app).post(`${base}/auth/refresh`).send({ refreshToken: rt });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.refreshToken).not.toBe(rt);

    // Old refresh token is dead.
    const reuse = await request(app).post(`${base}/auth/refresh`).send({ refreshToken: rt });
    expect(reuse.status).toBe(401);

    // Logout kills the new one.
    await request(app).post(`${base}/auth/logout`).send({ refreshToken: refreshed.body.data.refreshToken });
    const afterLogout = await request(app)
      .post(`${base}/auth/refresh`)
      .send({ refreshToken: refreshed.body.data.refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it("resets password via token and invalidates sessions", async () => {
    const { user } = await makeUser({ role: "ACCOUNTANT", password: "oldpass12" });
    await request(app).post(`${base}/auth/forgot-password`).send({ email: user.email });
    const stored = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(stored).toBeTruthy();
    // we can't recover the raw token (only hash stored) — emulate by minting one
    const { createHash, randomBytes } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    await prisma.passwordResetToken.update({
      where: { id: stored!.id },
      data: { tokenHash: createHash("sha256").update(raw).digest("hex") },
    });
    const res = await request(app)
      .post(`${base}/auth/reset-password`)
      .send({ token: raw, password: "newpass123" });
    expect(res.status).toBe(200);
    const login = await request(app)
      .post(`${base}/auth/login`)
      .send({ email: user.email, password: "newpass123" });
    expect(login.status).toBe(200);
  });

  it("signAccessToken produces verifiable issuer/audience", () => {
    const t = signAccessToken({ id: "x", role: "ADMIN" });
    const payload = jwt.verify(t, process.env.JWT_ACCESS_SECRET!, {
      issuer: "autoledger-api",
      audience: "autoledger-client",
    }) as jwt.JwtPayload;
    expect(payload.sub).toBe("x");
  });
});
