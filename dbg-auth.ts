import "./tests/helpers/env";
import request from "supertest";
import { createApp } from "./src/app";
import { makeUser } from "./tests/helpers/db";
(async () => {
  const { user, token } = await makeUser({ role: "ADMIN" });
  console.log("token:", token.slice(0, 40));
  const app = createApp();
  const res = await request(app).get("/api/v1/analytics/overview").set("Authorization", `Bearer ${token}`);
  console.log(res.status, JSON.stringify(res.body).slice(0, 300));
  process.exit(0);
})();
