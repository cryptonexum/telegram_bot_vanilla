require("dotenv").config();

const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const axios = require("axios");
const { MongoClient } = require("mongodb");

// ================= CONFIG =================

const APP_NAME = process.env.APP_NAME || "TONWON";
const APP_URL = process.env.APP_URL;

const MAINTAIN = process.env.MAINTAIN === "true";

const apiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_API}/`;

// ================= REDIS =================

const connection = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null
});

// ================= MONGO =================

let usersCollection;

async function initMongo() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();

  const db = client.db(process.env.MONGO_DB);
  usersCollection = db.collection("users");

  await usersCollection.createIndex({ id: 1 }, { unique: true });

  console.log("Mongo Connected");
}

// ================= TELEGRAM =================

async function sendMessage(chatId, text) {
  return axios.post(apiUrl + "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

async function sendPhoto(chatId, caption, keyboard = []) {
  return axios.post(apiUrl + "sendPhoto", {
    chat_id: chatId,
    photo: process.env.BANNER_FILE_ID,
    caption,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

// ================= DB =================

async function findUserByUserId(userId) {
  return usersCollection.findOne({ id: String(userId) });
}

async function createUserIfNotExists(userId, data) {
  return usersCollection.updateOne(
    { id: String(userId) },
    {
      $setOnInsert: {
        id: String(userId),
        ...data,
        created_at: new Date()
      }
    },
    { upsert: true }
  );
}

// ================= WORKER =================

async function startWorker() {
  await initMongo();

  const worker = new Worker(
    "telegramQueue",
    async (job) => {
      console.log("🔥 JOB RECEIVED");

      const update = job.data;
      if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];

      console.log("=================================");
      console.log("BANNER FILE ID:");
      console.log(photo.file_id);
      console.log("=================================");

      return;
      }
      const msg = update?.message;

      if (!msg) return;

      const chatId = msg.chat.id;
      const text = msg.text || "";
      const userId = msg.from.id;

      const firstName = msg.from.first_name || "";
      const lastName = msg.from.last_name || "";
      const username = msg.from.username || userId;

      if (!chatId || !userId) return;

      // ================= MAINTENANCE (FIXED) =================

      if (process.env.MAINTAIN === "true") {
        await sendMessage(chatId, "⚠️ System under maintenance.");
        return;
      }

      // ================= /START =================

      if (text.startsWith("/start")) {

        let referrerId = null;
        let source = "direct";

        const payload = text.replace("/start", "").trim();
        const parts = payload.split("_");

        if (parts[0] && parts[0].startsWith("r")) {
          referrerId = parts[0].replace("r", "");
        }

        if (parts[1]) {
          source = parts[1];
        }

        console.log("START:", { userId, referrerId, source });

        // ================= SELF REFERRAL =================

        if (referrerId && referrerId === String(userId)) {
          await sendMessage(chatId, "❌ You can't refer yourself.");
          return;
        }

        // ================= REF CHECK =================

        if (referrerId) {
          const refExists = await findUserByUserId(referrerId);

          if (!refExists) {
            await sendMessage(chatId, "❌ Invalid referral link.");
            referrerId = null;
          }
        }

        // ================= USER CREATE =================

        const isNewUser = await createUserIfNotExists(userId, {
          fullName: `${firstName} ${lastName}`.trim(),
          username,
          referred_by: referrerId,
          source
        });

        // ================= REF NOTIFY =================

        if (isNewUser && referrerId) {
          const notifyName =
            username || `${firstName} ${lastName}`.trim();

          await sendMessage(
            referrerId,
            `🎉 Congrats! ${notifyName} joined using your referral link!`
          );
        }

        // ================= MINI APP =================

        const referralLink = `${APP_URL}?ref=${userId}`;

        const caption = `
<b>🚀 Welcome to ${APP_NAME} BOT</b>

<i>Next-generation platform to make money smarter, faster & automated.</i>

<b>Core Features:</b>

⛏️ <b>One Tap Mining</b> – Start earning instantly  

🎯 <b>Complete Tasks & Earning</b> – Simple daily tasks  

👥 <b>Referral Earning</b> – Earn from every invite  

⚡ <b>Instant Withdrawal</b> – Fast & secure payouts  

📈 <b>Impressive Staking Rewards</b> – High passive income  

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

        try {
          await sendPhoto(chatId, caption, keyboard);
        } catch (err) {
          console.log("PHOTO FAILED → fallback");
          await sendMessage(chatId, caption);
        }
      }
    },
    {
      connection,
      concurrency: 50
    }
  );

  worker.on("failed", (job, err) => {
    console.error("❌ JOB FAILED:", err.message);
  });

  console.log("✅ Worker Started");
}

startWorker();