require("dotenv").config();

const express = require("express");
const axios = require("axios");
const http = require("http");
const cluster = require("cluster");
const os = require("os");

const { MongoClient } = require("mongodb");

const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");

// ======================================================
// CONFIG
// ======================================================

const TELEGRAM_API = process.env.TELEGRAM_API;
const APP_URL = process.env.APP_URL;

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB;

const APP_NAME = process.env.APP_NAME || "M5DEX";

const BANNER_FILE_ID = process.env.BANNER_FILE_ID;

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

const DEBUG = process.env.DEBUG === "true";
const MAINTAIN = false;

const PORT = process.env.PORT || 3000;

const apiUrl = `https://api.telegram.org/bot${TELEGRAM_API}/`;

// ======================================================
// EXPRESS
// ======================================================

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ======================================================
// LOGGER
// ======================================================

function writeLog(message, type = "INFO") {
  if (!DEBUG) return;

  console.log(
    `[${new Date().toISOString()}][${type}]`,
    typeof message === "object"
      ? JSON.stringify(message, null, 2)
      : message
  );
}

// ======================================================
// REDIS
// ======================================================

const redisConnection = new IORedis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null
});

// ======================================================
// QUEUE
// ======================================================

const telegramQueue = new Queue("telegramQueue", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000
    }
  }
});

// ======================================================
// MONGO
// ======================================================

let db;
let usersCollection;

async function initMongo() {
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 200,
    minPoolSize: 20
  });

  await client.connect();

  db = client.db(MONGO_DB);

  usersCollection = db.collection("users");

  // ================= INDEXES =================

  await usersCollection.createIndex(
    { id: 1 },
    { unique: true }
  );

  await usersCollection.createIndex({
    referred_by: 1
  });

  await usersCollection.createIndex({
    created_at: -1
  });

  writeLog("Mongo connected", "DB");
}

// ======================================================
// TELEGRAM FUNCTIONS
// ======================================================

async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(
      apiUrl + "sendMessage",
      {
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      },
      {
        timeout: 10000
      }
    );
  } catch (err) {
    writeLog(
      err.response?.data || err.message,
      "SEND_MESSAGE_ERROR"
    );
  }
}

async function sendTelegramPhoto(
  chatId,
  caption,
  keyboard = []
) {
  try {
    await axios.post(
      apiUrl + "sendPhoto",
      {
        chat_id: chatId,
        photo: BANNER_FILE_ID,
        caption,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: keyboard
        }
      },
      {
        timeout: 15000
      }
    );
  } catch (err) {
    writeLog(
      err.response?.data || err.message,
      "SEND_PHOTO_ERROR"
    );
  }
}

// ======================================================
// USER FUNCTIONS
// ======================================================

async function createUserIfNotExists(
  userId,
  fullName,
  username,
  firstName,
  lastName,
  isPremium,
  referrerId,
  source
) {
  try {
    const document = {
      id: String(userId),
      fullName,
      username: username || String(userId),
      firstName,
      lastName,
      total_balance: 0,
      referred_by: referrerId || null,
      referral_code: String(userId),
      isPremium: !!isPremium,
      source,
      created_at: new Date()
    };

    const result = await usersCollection.updateOne(
      {
        id: String(userId)
      },
      {
        $setOnInsert: document
      },
      {
        upsert: true
      }
    );

    return result.upsertedCount > 0;
  } catch (err) {
    writeLog(err.message, "UPSERT_ERROR");
    return false;
  }
}

async function findUserByUserId(userId) {
  return await usersCollection.findOne({
    id: String(userId)
  });
}

// ======================================================
// WORKER
// ======================================================

async function startWorker() {

  await initMongo();

  new Worker(
    "telegramQueue",

    async (job) => {

      try {

        const update = job.data;

        if (!update?.message) {
          return;
        }

        const message = update.message;

        const chatId = message?.chat?.id;
        const text = message?.text || "";

        const userId = message?.from?.id;

        const firstName =
          message?.from?.first_name || "";

        const lastName =
          message?.from?.last_name || "";

        const username =
          message?.from?.username || "";

        const isPremium =
          message?.from?.is_premium || false;

        const chatType =
          message?.chat?.type;

        // ================= VALIDATION =================

        if (
          !chatId ||
          !userId ||
          !text ||
          chatType !== "private"
        ) {
          return;
        }

        if (MAINTAIN) {

          await sendTelegramMessage(
            chatId,
            "⚠️ System under maintenance."
          );

          return;
        }

        // ================= START =================

        if (text.startsWith("/start")) {

          let referrerId = null;
          let source = "direct";

          const payload = text
            .replace("/start", "")
            .trim();

          if (payload) {

            const parts =
              payload.split("_");

            if (
              parts[0] &&
              parts[0].startsWith("r")
            ) {
              referrerId = parts[0]
                .replace("r", "")
                .trim();
            }

            if (parts[1]) {
              source = parts[1];
            }
          }

          // ================= SELF REFERRAL =================

          if (
            referrerId &&
            referrerId === String(userId)
          ) {

            await sendTelegramMessage(
              chatId,
              "❌ You can't refer yourself."
            );

            return;
          }

          // ================= REFERRER CHECK =================

          if (referrerId) {

            const referrerExists =
              await findUserByUserId(referrerId);

            if (!referrerExists) {

              await sendTelegramMessage(
                chatId,
                "❌ Invalid referral link."
              );

              referrerId = null;
            }
          }

          // ================= CREATE USER =================

          const isNewUser =
            await createUserIfNotExists(
              userId,
              `${firstName} ${lastName}`.trim(),
              username,
              firstName,
              lastName,
              isPremium,
              referrerId,
              source
            );

          // ================= REFERRAL NOTIFY =================

          if (isNewUser && referrerId) {

            const notifyName =
              username ||
              `${firstName} ${lastName}`.trim();

            await sendTelegramMessage(
              referrerId,
              `🎉 Congrats! ${notifyName} joined using your referral link!`
            );
          }

          // ================= MINI APP LINK =================

          const referralLink =
            `${APP_URL}?ref=${userId}`;

          // ================= MESSAGE =================

          const caption = `
<b>🚀 Welcome to ${APP_NAME} BOT</b>

<i>Next-generation platform to make money smarter, faster & automated.</i>

<b>Core Features:</b>

⛏️ <code>One-Tap Mining</code>
Start generating rewards instantly.

👥 <code>Referral Multiplier</code>
Invite friends and boost rewards.

🎁 <code>Daily Rewards</code>
Claim bonuses every day.

🌈 <b>Smart. Fast. Automated.</b>
`;

          const keyboard = [
            [
              {
                text: "⛏️ Start Mining Now",
                web_app: {
                  url: referralLink
                }
              }
            ]
          ];

          // ================= SEND PHOTO =================

          await sendTelegramPhoto(
            chatId,
            caption,
            keyboard
          );
        }

      } catch (err) {
        writeLog(
          err.stack || err.message,
          "WORKER_ERROR"
        );
      }
    },

    {
      concurrency: 100,
      connection: redisConnection
    }
  );

  console.log("✅ Worker started");
}

// ======================================================
// WEBHOOK
// ======================================================

app.post("/webhook", async (req, res) => {

  // ================= INSTANT RESPONSE =================
  // CRITICAL FOR HIGH SCALE

  res.sendStatus(200);

  try {

    // ================= PUSH TO QUEUE =================

    await telegramQueue.add(
      "telegram-update",
      req.body
    );

  } catch (err) {

    writeLog(
      err.stack || err.message,
      "QUEUE_ERROR"
    );
  }
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/", (req, res) => {
  res.send("Bot Running");
});

// ======================================================
// CLUSTER MODE
// ======================================================

if (cluster.isPrimary) {

  const cpuCount = os.cpus().length;

  console.log(
    `Primary process started. CPUs: ${cpuCount}`
  );

  // ================= FORK WEB SERVERS =================

  for (let i = 0; i < cpuCount; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {

    console.log(
      `Worker ${worker.process.pid} died. Restarting...`
    );

    cluster.fork();
  });

  // ================= START WORKER =================

  startWorker();

} else {

  // ================= HTTP SERVER =================

  const server = http.createServer(app);

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  server.listen(PORT, () => {

    console.log(
      `✅ Worker ${process.pid} running on port ${PORT}`
    );
  });
}
