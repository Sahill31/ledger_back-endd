import bcrypt from "bcryptjs";
import { prisma } from "../config/database";
import { env } from "../config/env";

/**
 * First-admin bootstrap — controlled CLI path, NOT an HTTP endpoint.
 *
 *   npm run bootstrap:admin -- --email admin@example.com --password 'S3cure!' --name "Sahil Admin"
 *
 * Creates an ADMIN only when no admin exists yet. To provision additional
 * admins afterwards, an authenticated admin uses POST /api/v1/users.
 */
async function main() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // CLI flags take precedence; env vars (ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD /
  // ADMIN_NAME) let the script run unattended on a deploy shell.
  const email = (get("email") ?? process.env.ADMIN_EMAIL)?.trim().toLowerCase();
  const password = get("password") ?? process.env.ADMIN_INITIAL_PASSWORD;
  const name = get("name") ?? process.env.ADMIN_NAME ?? "Administrator";

  if (!email || !password) {
    console.error(
      "Usage: npm run bootstrap:admin -- --email <email> --password <password> [--name <name>]\n" +
        "   or: set ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD (+ optional ADMIN_NAME)"
    );
    process.exit(1);
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    console.error("Password must be 8+ chars with a letter and a digit.");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Idempotent: never overwrite an existing account's credentials.
    console.log(`Account ${email} already exists (${existing.role}) — leaving it unchanged.`);
    return;
  }
  const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
  if (adminCount > 0) {
    console.error(
      "An admin account already exists. Use POST /api/v1/users as an authenticated admin instead."
    );
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      fullName: name,
      email,
      passwordHash,
      role: "ADMIN",
      title: "Administrator",
    },
  });
  console.log(`Created admin account: ${user.email} (${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
