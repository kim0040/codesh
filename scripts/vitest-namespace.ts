// Gives every test file its own Valkey namespace so parallel runs on one Valkey never see
// each other's keys or pub/sub messages (see `namespace()` in packages/shared/src/keys.ts).
process.env.CODESH_NS = `t${Math.random().toString(36).slice(2, 10)}:`;
