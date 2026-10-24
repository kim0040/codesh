// Explicit operator migration; use a container environment, never passwords in command arguments.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Explicit Mongo operator command.
db.getSiblingDB("admin").auth("codesh", process.env.MONGO_INITDB_ROOT_PASSWORD);
load("/opt/codesh/init-app-user.js");
