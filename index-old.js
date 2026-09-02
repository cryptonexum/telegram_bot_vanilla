require("dotenv").config();
const express = require("express");
const fs = require("fs");
const FormData = require("form-data");
const axios = require("axios");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ================= CONFIG =================
const TELEGRAM_API = process.env.TELEGRAM_API;
const APP_URL = process.env.APP_URL;
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB;
const APP_NAME = process.env.APP_NAME;

const DEBUG = process.env.DEBUG === "true";
const MAINTAIN = false;

const apiUrl = `https://api.telegram.org/bot${TELEGRAM_API}/`;

let db;
let usersCollection;

// ================= LOGGER =================
function writeLog(message, type = "INFO") {
  if (process.env.DEBUG !== "true") return;
  console.log(`[${new Date().toISOString()}][${type}]`, message);
}

// ================= MONGO =================
async function initMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB);
  usersCollection = db.collection("users");
  writeLog("MongoDB connected", "DB");
}

// ================= USER =================
async function findUserByUserId(userId) {
  writeLog(`Finding user: ${userId}`, "DB");
  return await usersCollection.findOne({ id: String(userId) });
}

async function insertUser(userId, fullName, username, firstName, lastName, isPremium, referrerId, source) {
  const visaCardNumber = "43" + Math.floor(Math.random() * 10 ** 14).toString().padStart(14, "0");
  const cvv = Math.floor(Math.random() * 999).toString().padStart(3, "0");
  const expiry =
    `${String(Math.floor(Math.random() * 12) + 1).padStart(2, "0")}/${new Date().getFullYear() + 1 + Math.floor(Math.random() * 5)}`;

  const document = {
    id: String(userId),
    fullName,
    username: username || String(userId),
    firstName,
    lastName,
    total_balance: 0,
    referred_by: referrerId || null,
    referral_code: String(userId),
    card_number: `${visaCardNumber}-${cvv}-${expiry}`,
    isPremium: !!isPremium,
    source,
    created_at: new Date()
  };

  try {
    writeLog(document, "INSERT_DOC");
    const result = await usersCollection.insertOne(document);
    writeLog(`User inserted: ${userId} (${result.insertedId})`, "INSERT");
    return true;
  } catch (err) {
    writeLog(JSON.stringify(err), "ERROR");
    return false;
  }
}

// ================= TELEGRAM =================
async function sendTelegramMessage(chatId, text) {
  try {
    writeLog(`Sending message to ${chatId}`, "TG");
    await axios.get(apiUrl + "sendMessage", {
      params: {
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      }
    });
  } catch (err) {
    writeLog(JSON.stringify(err.response?.data || err.message), "ERROR");
  }
}

async function sendTelegramPhoto(chatId, photoPath, caption, keyboard = []) {
  try {
    writeLog(`Sending photo to ${chatId}`, "TG");
    writeLog(`Photo path: ${photoPath}`, "TG");

    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", fs.createReadStream(photoPath));
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append(
      "reply_markup",
      JSON.stringify({ inline_keyboard: keyboard })
    );

    await axios.post(apiUrl + "sendPhoto", form, {
      headers: form.getHeaders()
    });

    writeLog("Photo sent successfully", "TG");
  } catch (err) {
    writeLog(JSON.stringify(err.response?.data || err.message), "ERROR");
  }
}

// ================= GLOBAL HTTP LOG =================
app.use((req, res, next) => {
  if (DEBUG) {
    writeLog(`HTTP ${req.method} ${req.url}`, "HTTP");
  }
  next();
});

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    writeLog("Webhook triggered", "WEBHOOK");
    writeLog(req.body, "RAW");

    const update = req.body;
    if (!update?.message) return res.sendStatus(200);

    const message = update.message;

    const chatId = message?.chat?.id;
    const text = message?.text;
    const userId = message?.from?.id;
    const firstName = message?.from?.first_name || "";
    const lastName = message?.from?.last_name || "";
    const username = message?.from?.username || "";
    const isPremium = message?.from?.is_premium || false;
    const chatType = message?.chat?.type;

    writeLog({ chatId, text, userId, chatType }, "MESSAGE");

    if (MAINTAIN) {
      await sendTelegramMessage(chatId, "System under maintenance.");
      return res.sendStatus(200);
    }

    if (chatType !== "private" || !chatId || !text) {
      return res.sendStatus(200);
    }

    // ================= START =================
    if (text.startsWith("/start")) {
      writeLog("START command detected", "START");

      let referrerId = null;
      let source = "direct";

      const payload = text.replace("/start", "").trim();
      const parts = payload.split("_");

      if (parts[0]) referrerId = parts[0].replace("r", "");
      if (parts[1]) source = parts[1];

      writeLog({ referrerId, source }, "REF");

      if (referrerId === String(userId)) {
        await sendTelegramMessage(chatId, "You can't refer yourself.");
        return res.sendStatus(200);
      }

      let referrerData = null;

      if (referrerId) {
        writeLog(`Checking referrer: ${referrerId}`, "REF");
        referrerData = await findUserByUserId(referrerId);

        writeLog(`Referrer exists: ${!!referrerData}`, "REF");

        if (!referrerData) {
          await sendTelegramMessage(chatId, "Invalid referral link.");
          referrerId = null;
        }
      }

      writeLog(`Checking existing user: ${userId}`, "DB");
      const existingUser = await findUserByUserId(userId);
      writeLog(`Existing user found: ${!!existingUser}`, "DB");

      if (!existingUser) {
        writeLog("User not found → inserting", "FLOW");

        await insertUser(
          userId,
          `${firstName} ${lastName}`,
          username,
          firstName,
          lastName,
          isPremium,
          referrerId,
          source
        );

        if (referrerId) {
          const notifyName = username || `${firstName} ${lastName}`;
          writeLog(`Notifying referrer: ${referrerId}`, "REF");

          await sendTelegramMessage(
            referrerId,
            `🎉 Congrats! Your friend ${notifyName} joined using your referral link!`
          );
        }
      }

      const referralLink = `${APP_URL}?ref=${userId}`;
      
     const caption=`<b>🚀 Welcome to ${APP_NAME} BOT</b>
<i>Next-generation platform to make money smarter, faster & automated.</i>

<b>Core Features:</b>
⛏️ <code>One-Tap Mining:</code> Start generating rewards instantly with our high-tech cloud mining engine.

👥 <code>Referral Multiplier:</code> Invite friends and watch your mining speed skyrocket!

🎁 <code>Daily Rewards:</code> Log in daily to claim bonuses and boost your hashrate.

🌈 <b>Smart. Fast. Automated.</b>`;

      const keyboard = [
        [
          {
            text: "⛏️ Start Mining Now",
            web_app: { url: referralLink }
          }
        ]
      ];

      await sendTelegramPhoto(
        chatId,
        "./public/banner.png",
        caption,
        keyboard
      );
    }

    res.sendStatus(200);
  } catch (err) {
    writeLog(err.stack || err, "FATAL");
    res.sendStatus(200);
  }
});

// ================= START =================
initMongo().then(() => {
  app.listen(3000, () => {
    console.log("Bot running on port 3000");
  });
});