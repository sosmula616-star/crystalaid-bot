# CrystalAid Bot

Discord-бот поддержки CrystalAid: заявки через `/help` в личных сообщениях, капча, пересылка сообщений, логи и транскрипты, расписание ПТ и напоминания, меню `/menu` и `/dev`, список сотрудников, права, настройки и журнал действий.

Один репозиторий, один `package.json`, один процесс: `src/index.ts` запускает миграции, внутренний API (только на 127.0.0.1), обработчик событий и самого бота. Снаружи открыт только `GET /health` на порту `PORT`.

## Развёртывание на bothost

1. Укажите URL репозитория и ветку `main`.
2. Включите «Использовать собственный Dockerfile».
3. Главный файл: `src/index.ts`, порт: `3000`. Задайте переменные из списка ниже.

Redis внутри образа ставится вместе с контейнером (`redis-server`), отдельный Redis не нужен.

## Переменные

| Переменная | Обязательна | Значение |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | да | токен бота |
| `DISCORD_CLIENT_ID` | да | ID приложения Discord |
| `DATABASE_URL` | да | строка подключения PostgreSQL |
| `CONFIG_JSON` | да, либо файл `config.json` в корне | конфигурация сервера, одной строкой JSON |
| `REDIS_URL` | нет | внешний Redis; если не задан, запускается локальный `redis-server` на 127.0.0.1 без сохранения на диск |
| `PORT` | нет | порт `GET /health`, по умолчанию 3000 |

Пример `CONFIG_JSON`:

```
{"guildId":"100000000000000001","timezone":"Europe/Moscow","roles":{"support":["100000000000000011"],"curator":["100000000000000012"]},"users":{"admins":["100000000000000031"],"developers":["100000000000000032"]},"channels":{"log":"100000000000000021","help":"100000000000000022"}}
```

Правила: `guildId`, `timezone`, `roles.support`, `roles.curator`, `channels.log`, `channels.help` обязательны; куратору нужны обе роли (поддержка и куратор); `roles.admin` необязательна; администраторы и разработчики задаются списками ID пользователей в `users.admins` и `users.developers`. При ошибке бот остановится и назовёт поле, не печатая секретов. Полный пример: `config.example.json`.

## Discord Developer Portal

В разделе Bot включите **Server Members Intent** (Privileged Gateway Intents). Без него список сотрудников и роли не обновятся. Пригласите бота на сервер со scope `bot` и `applications.commands`, а также на сервер с каналом `channels.log`, если он отдельный.

## Локальный запуск

```
pnpm install
cp .env.example .env     # заполните значения
pnpm start
```

Нужны Node.js 24+ и PostgreSQL; без `REDIS_URL` ещё и установленный `redis-server`. Проверки: `pnpm test` (нужны `TEST_DATABASE_URL` и `TEST_REDIS_URL`, отдельные от рабочих), `pnpm typecheck`, `pnpm lint`.
