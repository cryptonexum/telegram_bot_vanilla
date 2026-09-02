require("dotenv").config();

const express = require("express");
const http = require("http");
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const cluster = require("cluster");
const os = require("os");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ================= CONFIG =================

const PORT = process.env.PORT || 3000;

const redis = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null
});

const telegramQueue = new Queue("telegramQueue", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});

// ================= WEBHOOK =================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    await telegramQueue.add("update", req.body);
    console.log("QUEUE PUSHED");
  } catch (err) {
    console.error("QUEUE ERROR:", err.message);
  }
});

// ================= HEALTH =================

app.get("/", (req, res) => {
  res.send("Bot Running");
});

// ================= CLUSTER =================

http.createServer(app).listen(PORT, () => {
  console.log(`HTTP Server running on port ${PORT}`);
});

// if (cluster.isPrimary) {
//   const cpus = os.cpus().length;

//   console.log(`Master running. CPUs: ${cpus}`);

//   for (let i = 0; i < cpus; i++) {
//     cluster.fork();
//   }

//   cluster.on("exit", () => cluster.fork());

// } else {
//   http.createServer(app).listen(PORT, () => {
//     console.log(`HTTP Worker ${process.pid} running`);
//   });
// }