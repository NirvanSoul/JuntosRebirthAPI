import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(script) {
  const result = spawnSync(npmCommand, ["run", script], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Procesos separados: drizzle-kit puede finalizar su proceso correctamente al
// no encontrar trabajo pendiente. Así nunca impide que la publicación suceda,
// pero un error real de migración sí corta el despliegue antes del Worker.
run("db:migrate:production");
run("deploy:worker");
