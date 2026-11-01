process.env.PORT = "18799";
process.env.HOST = "127.0.0.1";
process.env.DATABASE_PATH = ":memory:";
process.env.MODEL_PROVIDER = "demo";
await import("../server/index.mjs");
