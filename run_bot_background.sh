#!/usr/bin/env bash
# run_bot_background.sh — безопасный запуск бота сходки в фоновом режиме
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Проверка, не запущен ли уже бот
if pgrep -f "python3.*bot\.py" > /dev/null; then
  echo "Бот уже запущен в фоновом режиме!"
  exit 0
fi

nohup python3 "$DIR/bot.py" > "$DIR/bot.log" 2>&1 &
echo "Бот успешно запущен в фоновом режиме (PID: $!)"
echo "Логи работы записываются в файл bot.log"
