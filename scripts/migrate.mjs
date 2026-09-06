import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

config({ path: ".dev.vars" });
config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run production migrations");
}

await migrate(drizzle(neon(process.env.DATABASE_URL)), {
  migrationsFolder: "drizzle",
});

console.log("Database migrations are current.");
