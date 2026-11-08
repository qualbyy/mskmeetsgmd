#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Telegram-бот для регистрации на сходку в группе @mskmeethub.
Работает исключительно на стандартных библиотеках Python 3 без pip.
"""

import os
import sys
import json
import time
import re
import urllib.request
import urllib.parse
import urllib.error
import subprocess

DIR = os.path.dirname(os.path.abspath(__file__))
PARTICIPANTS_FILE = os.path.join(DIR, "participants.json")
MEETUP_DATA_FILE = os.path.join(DIR, "meetup_data.js")
DEPLOY_SCRIPT = os.path.join(DIR, "deploy.sh")
ENV_FILE = os.path.join(DIR, ".env")

def get_meetup_status():
    if not os.path.isfile(MEETUP_DATA_FILE):
        return "upcoming"
    try:
        with open(MEETUP_DATA_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        m = re.search(r'MEETUP_DATA\s*=\s*\{[\s\S]*?status:\s*["\']([^"\']+)["\']', content)
        if m:
            return m.group(1).lower().strip()
    except Exception:
        pass
    return "upcoming"

# 1. Загрузка переменных окружения из .env
def load_env():
    env = {}
    if os.path.isfile(ENV_FILE):
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env

CONFIG = load_env()
BOT_TOKEN = CONFIG.get("TELEGRAM_BOT_TOKEN", "").strip()
ADMIN_ID = int(CONFIG.get("TELEGRAM_ADMIN_ID", "1581816068"))
ALLOWED_CHAT = CONFIG.get("TELEGRAM_ALLOWED_CHAT", "mskmeethub").lower().lstrip("@")

if not BOT_TOKEN:
    print("Ошибка: TELEGRAM_BOT_TOKEN не задан в файле .env!")
    sys.exit(1)

API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"

# 2. Функции взаимодействия с Telegram Bot API
def tg_request(method, payload=None):
    url = f"{API_BASE}/{method}"
    headers = {"Content-Type": "application/json"}
    data = json.dumps(payload).encode("utf-8") if payload else None
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="ignore")
        print(f"Ошибка API [{method}]: {e.code} — {err_msg}")
        return None
    except Exception as e:
        print(f"Сетевая ошибка [{method}]: {e}")
        return None

def send_message(chat_id, text, reply_to_message_id=None):
    payload = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": False
    }
    if reply_to_message_id:
        payload["reply_to_message_id"] = reply_to_message_id
    return tg_request("sendMessage", payload)

# 3. Работа с файлом участников и публикацией
def load_participants():
    if not os.path.isfile(PARTICIPANTS_FILE):
        return []
    try:
        with open(PARTICIPANTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Ошибка чтения {PARTICIPANTS_FILE}: {e}")
        return []

def save_and_deploy(participants, action_description):
    try:
        with open(PARTICIPANTS_FILE, "w", encoding="utf-8") as f:
            json.dump(participants, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception as e:
        print(f"Ошибка записи {PARTICIPANTS_FILE}: {e}")
        return False

    # Запуск публикации на GitHub
    if os.path.isfile(DEPLOY_SCRIPT):
        try:
            print(f"Публикация изменений на GitHub: {action_description}")
            res = subprocess.run(["bash", DEPLOY_SCRIPT], cwd=DIR, capture_output=True, text=True, timeout=60)
            if res.returncode == 0:
                print("Сайт успешно обновлен!")
                return True
            else:
                print(f"Ошибка deploy.sh: {res.stderr}")
        except Exception as e:
            print(f"Исключение при вызове deploy.sh: {e}")
    return False

# 4. Обработчики команд
def handle_register(chat_id, user, msg_id):
    current_st = get_meetup_status()
    if current_st in ["none", "нет", "idle"]:
        text = (
            "Сейчас активных сходок не запланировано, поэтому запись закрыта.\n"
            "Следите за анонсами и опросами в группе: https://t.me/mskmeethub"
        )
        send_message(chat_id, text, reply_to_message_id=msg_id)
        return

    participants = load_participants()
    uid = user.get("id")
    username = user.get("username")
    tag = f"@{username}" if username else ""
    first_name = user.get("first_name", "")
    last_name = user.get("last_name", "")
    name = (f"{first_name} {last_name}").strip() or (tag if tag else "участник")

    # Проверка, записан ли уже участник
    for idx, p in enumerate(participants, 1):
        if (uid and p.get("id") == uid) or (tag and p.get("tag", "").lower() == tag.lower()):
            text = (
                f"{name}, ты уже в списке участников! (№{idx})\n"
                f"Посмотреть список: https://qualbyy.github.io/mskmeetsgmd/\n\n"
                f"Если нужно отменить запись: напиши /unregister"
            )
            send_message(chat_id, text, reply_to_message_id=msg_id)
            return

    # Добавление нового участника
    new_entry = {
        "id": uid,
        "name": name,
        "tag": tag,
        "status": "участник"
    }
    participants.append(new_entry)
    total = len(participants)

    display_name = f"{name} ({tag})" if tag else name
    save_and_deploy(participants, f"добавлен участник {display_name}")

    text = (
        f"{display_name}, ты успешно записан(а) на сходку! (№{total})\n"
        f"Список участников на сайте: https://qualbyy.github.io/mskmeetsgmd/\n\n"
        f"Если твои планы изменятся, отменить запись можно командой /unregister"
    )
    send_message(chat_id, text, reply_to_message_id=msg_id)

def handle_unregister(chat_id, user, msg_id):
    participants = load_participants()
    uid = user.get("id")
    username = user.get("username")
    tag = f"@{username}" if username else ""
    first_name = user.get("first_name", "")
    last_name = user.get("last_name", "")
    name = (f"{first_name} {last_name}").strip() or (tag if tag else "участник")

    found_idx = None
    for idx, p in enumerate(participants):
        if (uid and p.get("id") == uid) or (tag and p.get("tag", "").lower() == tag.lower()):
            # Организаторов через бота снять нельзя
            if p.get("status") == "организатор":
                send_message(chat_id, f"{name}, статус организатора нельзя снять через бота.", reply_to_message_id=msg_id)
                return
            found_idx = idx
            break

    if found_idx is None:
        send_message(chat_id, f"{name}, тебя нет в списке записавшихся на сходку.", reply_to_message_id=msg_id)
        return

    removed = participants.pop(found_idx)
    save_and_deploy(participants, f"удален участник {removed.get('name')}")

    text = (
        f"{name}, запись отменена. Будем ждать тебя на следующих сходках!\n"
        f"Актуальный список: https://qualbyy.github.io/mskmeetsgmd/"
    )
    send_message(chat_id, text, reply_to_message_id=msg_id)

def handle_list(chat_id, msg_id):
    participants = load_participants()
    if not participants:
        send_message(chat_id, "В списке участников пока пусто.", reply_to_message_id=msg_id)
        return

    lines = ["Список участников сходки:"]
    for idx, p in enumerate(participants, 1):
        name = p.get("name", "участник")
        tag = p.get("tag", "")
        status = p.get("status", "участник")
        tag_str = f" ({tag})" if tag else ""
        role_str = " [организатор]" if status == "организатор" else ""
        lines.append(f"{idx}. {name}{tag_str}{role_str}")

    lines.append(f"\nВсего: {len(participants)} чел.")
    lines.append("Сайт сходки: https://qualbyy.github.io/mskmeetsgmd/")
    send_message(chat_id, "\n".join(lines), reply_to_message_id=msg_id)

def handle_help(chat_id, msg_id):
    text = (
        "Бот сходки @mskmeethub\n\n"
        "Команды в чате:\n"
        "/register — записаться на сходку\n"
        "/unregister — отменить свою запись\n"
        "/participants — посмотреть список участников\n\n"
        "Сайт сходки: https://qualbyy.github.io/mskmeetsgmd/"
    )
    send_message(chat_id, text, reply_to_message_id=msg_id)

def setup_bot_commands():
    commands = [
        {"command": "register", "description": "записаться на сходку"},
        {"command": "unregister", "description": "отменить свою запись на сходку"},
        {"command": "participants", "description": "посмотреть список участников"},
        {"command": "help", "description": "информация о сходке и сайте"}
    ]
    # Регистрация подсказок команд для всех пользователей и групп
    tg_request("setMyCommands", {"commands": commands})
    tg_request("setMyCommands", {
        "commands": commands,
        "scope": {"type": "all_group_chats"}
    })

# 5. Главный цикл бота (Long Polling)
def main():
    print(f"=== Бот запускается для группы @{ALLOWED_CHAT} ===")
    me = tg_request("getMe")
    if me and me.get("ok"):
        bot_user = me["result"]
        print(f"Бот авторизован: @{bot_user.get('username')} (ID: {bot_user.get('id')})")
        setup_bot_commands()
        print("Всплывающие подсказки команд зарегистрированы в Telegram.")
    else:
        print("Не удалось связаться с Telegram. Проверьте токен в .env.")
        sys.exit(1)

    offset = 0
    while True:
        try:
            updates = tg_request("getUpdates", {"offset": offset, "timeout": 25})
            if not updates or not updates.get("ok"):
                time.sleep(2)
                continue

            for item in updates.get("result", []):
                offset = max(offset, item["update_id"] + 1)
                msg = item.get("message")
                if not msg:
                    continue

                text = (msg.get("text") or "").strip()
                if not text.startswith("/"):
                    continue

                chat = msg.get("chat", {})
                chat_id = chat.get("id")
                chat_type = chat.get("type", "")
                chat_username = (chat.get("username") or "").lower().lstrip("@")
                user = msg.get("from", {})
                user_id = user.get("id")
                msg_id = msg.get("message_id")

                # Проверка: бот должен работать исключительно в группе @mskmeethub (или в ЛС с админом)
                is_allowed_group = (chat_type in ["group", "supergroup"] and chat_username == ALLOWED_CHAT)
                is_admin_dm = (chat_type == "private" and user_id == ADMIN_ID)

                if not is_allowed_group and not is_admin_dm:
                    if chat_type == "private":
                        send_message(
                            chat_id,
                            f"Привет! Я работаю только в группе @{ALLOWED_CHAT}. Запись на сходку происходит там командой /register."
                        )
                    continue

                # Извлечение команды без упоминания бота (например, /register@botname -> /register)
                cmd = text.split()[0].split("@")[0].lower()

                if cmd == "/register":
                    handle_register(chat_id, user, msg_id)
                elif cmd == "/unregister":
                    handle_unregister(chat_id, user, msg_id)
                elif cmd in ["/participants", "/list"]:
                    handle_list(chat_id, msg_id)
                elif cmd in ["/help", "/start"]:
                    handle_help(chat_id, msg_id)

        except KeyboardInterrupt:
            print("\nБот остановлен пользователем.")
            break
        except Exception as e:
            print(f"Ошибка в цикле: {e}")
            time.sleep(3)

if __name__ == "__main__":
    main()
