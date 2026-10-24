// Used by new volumes and by the explicit existing-volume migration; no passwords in argv.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Mongo init runs outside Turbo.
const username = process.env.MONGO_APP_USER;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Mongo init runs outside Turbo.
const password = process.env.MONGO_APP_PASSWORD;
if (username && username !== "codesh" && password) {
  const app = db.getSiblingDB("codesh");
  if (!app.getUser(username)) {
    app.createUser({ user: username, pwd: password, roles: [{ role: "readWrite", db: "codesh" }] });
  }
}
