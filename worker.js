/**
 * Cloudflare Worker: автономный Telegram-бот для записи на сходку @mskmeethub
 * Работает 24/7 бесплатно в облаке Cloudflare без использования компьютера.
 */

// Базовые настройки по умолчанию (их также можно переопределить через Variables в Cloudflare)
const DEFAULT_CONFIG = {
  BOT_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN",
  ADMIN_ID: 1581816068,
  ALLOWED_CHAT: "mskmeethub",
  GITHUB_REPO: "qualbyy/mskmeetsgmd",
  GITHUB_FILE_PATH: "participants.json",
  SITE_URL: "https://qualbyy.github.io/mskmeetsgmd/"
};

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Бот сходки работает в облаке Cloudflare Workers!", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Метод не поддерживается", { status: 405 });
    }

    const token = env.BOT_TOKEN || DEFAULT_CONFIG.BOT_TOKEN;
    const githubToken = env.GITHUB_TOKEN; // Персональный токен GitHub (PAT)
    const adminId = parseInt(env.ADMIN_ID || DEFAULT_CONFIG.ADMIN_ID, 10);
    const allowedChat = (env.ALLOWED_CHAT || DEFAULT_CONFIG.ALLOWED_CHAT).toLowerCase().replace(/^@/, "");

    try {
      const update = await request.json();
      if (!update || !update.message) {
        return new Response("OK", { status: 200 });
      }

      const msg = update.message;
      const text = (msg.text || "").trim();
      if (!text.startsWith("/")) {
        return new Response("OK", { status: 200 });
      }

      const chat = msg.chat || {};
      const chatType = chat.type || "";
      const chatUsername = (chat.username || "").toLowerCase().replace(/^@/, "");
      const user = msg.from || {};
      const userId = user.id;
      const msgId = msg.message_id;
      const chatId = chat.id;

      // Ограничение: бот отвечает исключительно в группе @mskmeethub или в ЛС администратору
      const isAllowedGroup = (chatType === "group" || chatType === "supergroup") && chatUsername === allowedChat;
      const isAdminDm = chatType === "private" && userId === adminId;

      if (!isAllowedGroup && !isAdminDm) {
        if (chatType === "private") {
          await sendMessage(token, chatId, `Привет! Я работаю только в группе @${allowedChat}. Запись на сходку происходит там командой /register.`);
        }
        return new Response("OK", { status: 200 });
      }

      const cmd = text.split(" ")[0].split("@")[0].toLowerCase();

      if (cmd === "/register") {
        await handleRegister(token, githubToken, chatId, user, msgId);
      } else if (cmd === "/unregister") {
        await handleUnregister(token, githubToken, chatId, user, msgId);
      } else if (cmd === "/participants" || cmd === "/list") {
        await handleList(token, githubToken, chatId, msgId);
      } else if (cmd === "/help" || cmd === "/start") {
        await handleHelp(token, chatId, allowedChat, msgId);
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Ошибка обработки:", err);
      return new Response("OK", { status: 200 });
    }
  }
};

// Отправка сообщений в Telegram
async function sendMessage(token, chatId, text, replyToId = null) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: false
  };
  if (replyToId) body.reply_to_message_id = replyToId;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Получение участников из GitHub через REST API
async function fetchGitHubFile(githubToken, filePath) {
  const url = `https://api.github.com/repos/${DEFAULT_CONFIG.GITHUB_REPO}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Cloudflare-Worker-Bot",
      "Accept": "application/vnd.github.v3+json",
      ...(githubToken ? { "Authorization": `Bearer ${githubToken}` } : {})
    }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return decodeUnicodeBase64(data.content);
}

// Получение участников из GitHub через REST API
async function getGitHubParticipants(githubToken) {
  const url = `https://api.github.com/repos/${DEFAULT_CONFIG.GITHUB_REPO}/contents/${DEFAULT_CONFIG.GITHUB_FILE_PATH}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Cloudflare-Worker-Bot",
      "Accept": "application/vnd.github.v3+json",
      ...(githubToken ? { "Authorization": `Bearer ${githubToken}` } : {})
    }
  });

  if (!res.ok) {
    throw new Error(`Ошибка GitHub API (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const rawText = decodeUnicodeBase64(data.content);
  return {
    participants: JSON.parse(rawText),
    sha: data.sha
  };
}

// Запись участников в GitHub через REST API
async function saveGitHubParticipants(githubToken, participants, sha, commitMsg) {
  const url = `https://api.github.com/repos/${DEFAULT_CONFIG.GITHUB_REPO}/contents/${DEFAULT_CONFIG.GITHUB_FILE_PATH}`;
  const contentBase64 = encodeUnicodeBase64(JSON.stringify(participants, null, 2) + "\n");

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "User-Agent": "Cloudflare-Worker-Bot",
      "Authorization": `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "Accept": "application/vnd.github.v3+json"
    },
    body: JSON.stringify({
      message: commitMsg,
      content: contentBase64,
      sha: sha,
      branch: "main"
    })
  });

  if (!res.ok) {
    throw new Error(`Не удалось сохранить в GitHub (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

// Обработка /register
async function handleRegister(token, githubToken, chatId, user, msgId) {
  if (!githubToken) {
    await sendMessage(token, chatId, "Ошибка: в настройках бота в Cloudflare не указан GITHUB_TOKEN.", msgId);
    return;
  }

  // Проверка статуса из meetup_data.js на GitHub
  try {
    const rawData = await fetchGitHubFile(githubToken, "meetup_data.js");
    if (rawData) {
      const match = rawData.match(/status:\s*["']([^"']+)["']/);
      if (match && ["none", "нет", "idle"].includes(match[1].toLowerCase().trim())) {
        await sendMessage(
          token,
          chatId,
          "Сейчас активных сходок не запланировано, поэтому запись закрыта.\nСледите за анонсами и опросами в группе: https://t.me/mskmeethub",
          msgId
        );
        return;
      }
    }
  } catch (err) {
    console.error("Ошибка проверки статуса сходки:", err);
  }

  const uid = user.id;
  const username = user.username;
  const tag = username ? `@${username}` : "";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || (tag || "участник");

  try {
    const { participants, sha } = await getGitHubParticipants(githubToken);

    // Проверка, записан ли уже
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if ((uid && p.id === uid) || (tag && (p.tag || "").toLowerCase() === tag.toLowerCase())) {
        const text = `${name}, ты уже в списке участников! (№${i + 1})\nПосмотреть список: ${DEFAULT_CONFIG.SITE_URL}\n\nЕсли нужно отменить запись: напиши /unregister`;
        await sendMessage(token, chatId, text, msgId);
        return;
      }
    }

    participants.push({
      id: uid,
      name: name,
      tag: tag,
      status: "участник"
    });

    const displayName = tag ? `${name} (${tag})` : name;
    await saveGitHubParticipants(githubToken, participants, sha, `добавлен участник: ${displayName}`);

    const text = `${displayName}, ты успешно записан(а) на сходку! (№${participants.length})\nСписок участников на сайте: ${DEFAULT_CONFIG.SITE_URL}\n\nЕсли твои планы изменятся, отменить запись можно командой /unregister`;
    await sendMessage(token, chatId, text, msgId);
  } catch (err) {
    console.error(err);
    await sendMessage(token, chatId, `Не удалось выполнить запись. Попробуйте чуть позже.`, msgId);
  }
}

// Обработка /unregister
async function handleUnregister(token, githubToken, chatId, user, msgId) {
  if (!githubToken) {
    await sendMessage(token, chatId, "Ошибка: в настройках бота в Cloudflare не указан GITHUB_TOKEN.", msgId);
    return;
  }

  const uid = user.id;
  const username = user.username;
  const tag = username ? `@${username}` : "";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || (tag || "участник");

  try {
    const { participants, sha } = await getGitHubParticipants(githubToken);

    let foundIdx = -1;
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if ((uid && p.id === uid) || (tag && (p.tag || "").toLowerCase() === tag.toLowerCase())) {
        if (p.status === "организатор") {
          await sendMessage(token, chatId, `${name}, статус организатора нельзя снять через бота.`, msgId);
          return;
        }
        foundIdx = i;
        break;
      }
    }

    if (foundIdx === -1) {
      await sendMessage(token, chatId, `${name}, тебя нет в списке записавшихся на сходку.`, msgId);
      return;
    }

    const removed = participants.splice(foundIdx, 1)[0];
    await saveGitHubParticipants(githubToken, participants, sha, `удален участник: ${removed.name}`);

    const text = `${name}, запись отменена. Будем ждать тебя на следующих сходках!\nАктуальный список: ${DEFAULT_CONFIG.SITE_URL}`;
    await sendMessage(token, chatId, text, msgId);
  } catch (err) {
    console.error(err);
    await sendMessage(token, chatId, `Не удалось отменить запись. Попробуйте чуть позже.`, msgId);
  }
}

// Обработка /participants
async function handleList(token, githubToken, chatId, msgId) {
  try {
    const { participants } = await getGitHubParticipants(githubToken);
    if (!participants || participants.length === 0) {
      await sendMessage(token, chatId, "В списке участников пока пусто.", msgId);
      return;
    }

    const lines = ["Список участников сходки:"];
    participants.forEach((p, idx) => {
      const tagStr = p.tag ? ` (${p.tag})` : "";
      const roleStr = p.status === "организатор" ? " [организатор]" : "";
      lines.push(`${idx + 1}. ${p.name || "участник"}${tagStr}${roleStr}`);
    });
    lines.push(`\nВсего: ${participants.length} чел.`);
    lines.push(`Сайт сходки: ${DEFAULT_CONFIG.SITE_URL}`);

    await sendMessage(token, chatId, lines.join("\n"), msgId);
  } catch (err) {
    await sendMessage(token, chatId, `Сайт сходки: ${DEFAULT_CONFIG.SITE_URL}`, msgId);
  }
}

// Обработка /help
async function handleHelp(token, chatId, allowedChat, msgId) {
  const text = `Бот сходки @${allowedChat}\n\nКоманды в чате:\n/register — записаться на сходку\n/unregister — отменить свою запись\n/participants — посмотреть список участников\n\nСайт сходки: ${DEFAULT_CONFIG.SITE_URL}`;
  await sendMessage(token, chatId, text, msgId);
}

// Вспомогательные функции для корректной работы с UTF-8 в base64
function encodeUnicodeBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeUnicodeBase64(base64) {
  return decodeURIComponent(escape(atob(base64.replace(/\n/g, ""))));
}
