#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import Librus from "librus-api";

const ui = {
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  rich:
    process.platform !== "win32" ||
    Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM),
};

const glyphs = ui.rich
  ? {
      spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      ok: "✔",
      fail: "✖",
      pointer: "›",
      bullet: "•",
      dot: " · ",
      box: "─│┌┬┐├┼┤└┴┘",
    }
  : {
      spinner: ["|", "/", "-", "\\"],
      ok: "+",
      fail: "x",
      pointer: ">",
      bullet: "*",
      dot: " - ",
      box: "-|+++++++++",
    };

const weekdays = [
  ["Monday", "Poniedziałek"],
  ["Tuesday", "Wtorek"],
  ["Wednesday", "Środa"],
  ["Thursday", "Czwartek"],
  ["Friday", "Piątek"],
  ["Saturday", "Sobota"],
  ["Sunday", "Niedziela"],
];

const cachePath = () => {
  if (process.platform === "win32")
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "libruschedule",
      "cache",
    );
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Caches", "libruschedule");
  return join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "libruschedule",
  );
};

const storePath = () => {
  if (process.platform === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "libruschedule",
    );
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "libruschedule");
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "libruschedule",
  );
};

class Failure extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "Failure";
  }
}

class Cancelled extends Error {
  constructor() {
    super("Przerwano.");
    this.name = "Cancelled";
  }
}

const dates = {
  long: new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }),
  short: new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit" }),
  stamp: new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "long",
    timeStyle: "short",
  }),
};

const clean = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const plural = (count, one, few, many) => {
  if (count === 1) return one;
  const last = count % 10;
  const tens = count % 100;
  return last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? few : many;
};

const since = (milliseconds) => {
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 1) return "przed chwilą";
  if (minutes < 60)
    return `${minutes} ${plural(minutes, "minutę", "minuty", "minut")} temu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)
    return `${hours} ${plural(hours, "godzinę", "godziny", "godzin")} temu`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "dzień", "dni", "dni")} temu`;
};

const paint = (text, code) =>
  ui.color && code ? `\u001B[${code}m${text}\u001B[0m` : String(text);

const write = (stream, text) => {
  try {
    stream.write(text);
  } catch {}
};

const toIso = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const addDays = (date, amount) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};

const weekOf = (value, offset = 0) => {
  const base = value ? new Date(`${value}T12:00:00`) : new Date();
  base.setHours(12, 0, 0, 0);
  if (Number.isNaN(base.getTime()) || (value && toIso(base) !== value)) {
    throw new Failure(
      `"${value}" nie jest poprawną datą. Użyj formatu RRRR-MM-DD, np. 2026-09-21.`,
    );
  }
  const monday = addDays(base, -((base.getDay() + 6) % 7) + offset * 7);
  return { monday, from: toIso(monday), to: toIso(addDays(monday, 6)) };
};

const timeout = async (promise, seconds, message) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Failure(message)), seconds * 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const cursor = (visible) => {
  if (ui.interactive)
    write(process.stdout, visible ? "\u001B[?25h" : "\u001B[?25l");
};

const step = async (label, task) => {
  if (!ui.interactive || !process.stderr.isTTY) {
    write(process.stderr, `${label}...\n`);
    return task();
  }
  const started = Date.now();
  let frame = 0;
  const draw = (symbol, code) => {
    readline.cursorTo(process.stderr, 0);
    readline.clearLine(process.stderr, 0);
    write(process.stderr, `${paint(symbol, code)} ${label}`);
  };
  cursor(false);
  draw(glyphs.spinner[0], "36");
  const timer = setInterval(
    () => draw(glyphs.spinner[++frame % glyphs.spinner.length], "36"),
    80,
  );
  try {
    const result = await task();
    clearInterval(timer);
    draw(glyphs.ok, "32");
    write(
      process.stderr,
      paint(` ${((Date.now() - started) / 1000).toFixed(1)}s\n`, "90"),
    );
    return result;
  } catch (error) {
    clearInterval(timer);
    draw(glyphs.fail, "31");
    write(process.stderr, "\n");
    throw error;
  } finally {
    cursor(true);
  }
};

const keys = (handler) =>
  new Promise((resolve, reject) => {
    const input = process.stdin;
    readline.emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    try {
      input.setRawMode(true);
    } catch (error) {
      reject(
        new Failure("Ten terminal nie obsługuje trybu interaktywnego.", {
          cause: error,
        }),
      );
      return;
    }
    input.resume();
    const stop = (error, value) => {
      input.off("keypress", listener);
      try {
        input.setRawMode(wasRaw);
      } catch {}
      input.pause();
      cursor(true);
      if (error) reject(error);
      else resolve(value);
    };
    const listener = (chunk, key = {}) => {
      if (key.ctrl && key.name === "c") {
        stop(new Cancelled());
        return;
      }
      try {
        handler(chunk, key, stop);
      } catch (error) {
        stop(error);
      }
    };
    input.on("keypress", listener);
  });

const ask = async (label, fallback = "") => {
  if (!ui.interactive)
    throw new Failure(
      `Brak danych: ${label}. Uruchom program w terminalu interaktywnym lub podaj dane opcjami.`,
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${paint(glyphs.pointer, "36")} ${label}${fallback ? paint(` [${fallback}]`, "90") : ""}: `,
    );
    return clean(answer) || fallback;
  } finally {
    rl.close();
  }
};

const askSecret = async (label) => {
  if (!ui.interactive)
    throw new Failure(
      "Brak hasła. Ustaw zmienną LIBRUS_PASSWORD lub uruchom program w terminalu.",
    );
  write(process.stdout, `${paint(glyphs.pointer, "36")} ${label}: `);
  let value = "";
  const result = await keys((chunk, key, stop) => {
    if (key.name === "return" || key.name === "enter") {
      write(process.stdout, "\n");
      stop(null, value);
      return;
    }
    if (key.name === "backspace") {
      if (value.length > 0) {
        value = value.slice(0, -1);
        write(process.stdout, "\b \b");
      }
      return;
    }
    if (key.ctrl || key.meta || !chunk) return;
    const printable = String(chunk).replace(/[\u0000-\u001F\u007F]/g, "");
    if (!printable) return;
    value += printable;
    write(process.stdout, "*".repeat(printable.length));
  });
  return result;
};

const choose = async (title, items) => {
  if (!ui.interactive) throw new Failure("Tryb interaktywny wymaga terminala.");
  write(process.stdout, `\n${paint(title, "1")}\n`);
  let active = 0;
  const render = (first) => {
    if (!first) readline.moveCursor(process.stdout, 0, -items.length);
    items.forEach((item, index) => {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      const marker =
        index === active ? paint(`${glyphs.pointer} `, "36") : "  ";
      write(
        process.stdout,
        `${marker}${index === active ? paint(item.label, "1") : item.label}\n`,
      );
    });
  };
  cursor(false);
  render(true);
  return keys((chunk, key, stop) => {
    if (key.name === "up" || key.name === "k") {
      active = (active - 1 + items.length) % items.length;
      render(false);
      return;
    }
    if (key.name === "down" || key.name === "j" || key.name === "tab") {
      active = (active + 1) % items.length;
      render(false);
      return;
    }
    if (/^[1-9]$/.test(String(chunk)) && Number(chunk) <= items.length) {
      active = Number(chunk) - 1;
      render(false);
      return;
    }
    if (key.name === "return" || key.name === "enter" || key.name === "space") {
      stop(null, items[active].value);
      return;
    }
    if (key.name === "escape" || key.name === "q") stop(null, null);
  });
};

const pause = async (
  label = "Naciśnij dowolny klawisz, aby wrócić do menu",
) => {
  if (!ui.interactive) return null;
  write(process.stdout, paint(`\n${label}`, "90"));
  const pressed = await keys((chunk, key, stop) =>
    stop(null, key.name ?? String(chunk ?? "")),
  );
  write(process.stdout, "\n");
  return pressed;
};

const derive = promisify(scrypt);

const shell = (command, args, input) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, output: "" });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const guard = setTimeout(() => {
      child.kill();
      finish({ ok: false, output: "" });
    }, 15000);
    child.on("error", () => {
      clearTimeout(guard);
      finish({ ok: false, output: "" });
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      clearTimeout(guard);
      finish({ ok: code === 0, output: output.replace(/\r?\n$/, "") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

const localKey = async (salt) =>
  derive(
    `${hostname()}:${userInfo().username}:${process.platform}:libruschedule`,
    Buffer.from(salt, "hex"),
    32,
  );

const vault = {
  async save(login, password, salt) {
    if (process.platform === "darwin") {
      const saved = await shell("security", [
        "add-generic-password",
        "-U",
        "-a",
        login,
        "-s",
        "libruschedule",
        "-w",
        password,
      ]);
      if (saved.ok) return { keeper: "keychain", secret: null };
    }
    if (process.platform === "win32") {
      const saved = await shell(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force | ConvertFrom-SecureString",
        ],
        password,
      );
      if (saved.ok && saved.output)
        return { keeper: "dpapi", secret: saved.output };
    }
    if (process.platform === "linux") {
      const saved = await shell(
        "secret-tool",
        [
          "store",
          "--label=Libruschedule",
          "service",
          "libruschedule",
          "account",
          login,
        ],
        password,
      );
      if (saved.ok) return { keeper: "keychain", secret: null };
    }
    const key = await localKey(salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const payload = Buffer.concat([
      cipher.update(password, "utf8"),
      cipher.final(),
    ]);
    return {
      keeper: "local",
      secret: Buffer.concat([iv, cipher.getAuthTag(), payload]).toString(
        "base64",
      ),
    };
  },

  async read(account, salt) {
    try {
      if (account.keeper === "keychain" && process.platform === "darwin") {
        const found = await shell("security", [
          "find-generic-password",
          "-a",
          account.login,
          "-s",
          "libruschedule",
          "-w",
        ]);
        return found.ok ? found.output : null;
      }
      if (account.keeper === "keychain" && process.platform === "linux") {
        const found = await shell("secret-tool", [
          "lookup",
          "service",
          "libruschedule",
          "account",
          account.login,
        ]);
        return found.ok && found.output ? found.output : null;
      }
      if (account.keeper === "dpapi" && account.secret) {
        const found = await shell(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString ([Console]::In.ReadToEnd()))))",
          ],
          account.secret,
        );
        return found.ok && found.output ? found.output : null;
      }
      if (account.keeper === "local" && account.secret) {
        const raw = Buffer.from(account.secret, "base64");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          await localKey(salt),
          raw.subarray(0, 12),
        );
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([
          decipher.update(raw.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
      }
    } catch {
      return null;
    }
    return null;
  },

  async forget(account) {
    if (account.keeper !== "keychain") return;
    if (process.platform === "darwin") {
      await shell("security", [
        "delete-generic-password",
        "-a",
        account.login,
        "-s",
        "libruschedule",
      ]);
    } else if (process.platform === "linux") {
      await shell("secret-tool", [
        "clear",
        "service",
        "libruschedule",
        "account",
        account.login,
      ]);
    }
  },
};

const loadConfig = async () => {
  const file = join(storePath(), "config.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return {
      file,
      salt:
        typeof parsed.salt === "string"
          ? parsed.salt
          : randomBytes(16).toString("hex"),
      active: typeof parsed.active === "string" ? parsed.active : null,
      events: parsed.events !== false,
      accounts: Array.isArray(parsed.accounts)
        ? parsed.accounts.filter((entry) => entry?.login && entry?.id)
        : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        file,
        salt: randomBytes(16).toString("hex"),
        active: null,
        events: true,
        accounts: [],
      };
    }
    throw new Failure(
      `Plik konfiguracyjny jest uszkodzony: ${file}. Usuń go i uruchom program ponownie.`,
      { cause: error },
    );
  }
};

const saveConfig = async (config) => {
  const { file, ...data } = config;
  try {
    await mkdir(storePath(), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(file, 0o600);
  } catch (error) {
    throw new Failure(`Nie udało się zapisać konfiguracji w ${file}.`, {
      cause: error,
    });
  }
};

const cacheFile = () => join(cachePath(), "weeks.json");

const readCache = async () => {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf8"));
    return parsed?.entries && typeof parsed.entries === "object"
      ? parsed
      : { entries: {} };
  } catch {
    return { entries: {} };
  }
};

const writeCache = async (cache) => {
  try {
    const entries = Object.entries(cache.entries)
      .filter(
        ([, entry]) =>
          Number.isFinite(entry?.fetchedAt) &&
          Date.now() - entry.fetchedAt < 90 * 86400000,
      )
      .sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
      .slice(0, 20);
    await mkdir(cachePath(), { recursive: true, mode: 0o700 });
    await writeFile(
      cacheFile(),
      JSON.stringify({ entries: Object.fromEntries(entries) }),
      { mode: 0o600 },
    );
  } catch {}
};

const dropCache = async () => {
  try {
    await rm(cacheFile(), { force: true });
  } catch (error) {
    throw new Failure("Nie udało się usunąć pamięci podręcznej.", {
      cause: error,
    });
  }
};

const cacheLife = (week, now = new Date()) => {
  const today = toIso(now);
  if (week.to < today) return 7 * 86400000;
  if (week.from > today) return 6 * 3600000;
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  return weekday && now.getHours() >= 6 && now.getHours() < 17
    ? 15 * 60000
    : 3 * 3600000;
};

const connect = async (login, password) => {
  const client = new Librus();
  try {
    const cookies = await timeout(
      client.authorize(login, password),
      45,
      "Serwer Synergii nie odpowiedział w czasie 45 sekund.",
    );
    if (!Array.isArray(cookies) || cookies.length === 0)
      throw new Failure("Serwer nie ustawił sesji.");
    return client;
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(
      "Logowanie nie powiodło się. Sprawdź login i hasło oraz dostępność serwera Synergii.",
      { cause: error },
    );
  }
};

const fetchProfile = async (client) => {
  const [info, lucky] = await Promise.allSettled([
    timeout(
      client.info.getAccountInfo(),
      30,
      "Dane ucznia nie dotarły na czas.",
    ),
    timeout(
      client.info.getLuckyNumber(),
      30,
      "Szczęśliwy numerek nie dotarł na czas.",
    ),
  ]);
  const student = info.status === "fulfilled" ? info.value?.student : null;
  return {
    name: clean(student?.nameSurname) || "Uczeń",
    group: clean(student?.class),
    educator: clean(student?.educator),
    lucky:
      lucky.status === "fulfilled" && Number.isInteger(lucky.value)
        ? lucky.value
        : null,
  };
};

const fetchSignature = async (client) => {
  try {
    const counters = await timeout(
      client.info.getNotifications(),
      20,
      "Licznik powiadomień nie dotarł na czas.",
    );
    if (!counters || typeof counters !== "object") return null;
    const watched = ["calendar", "homework", "absence"].map(
      (name) => `${name}=${Number(counters[name]) || 0}`,
    );
    return watched.join(",");
  } catch {
    return null;
  }
};

const fetchTimetable = async (client, week) => {
  try {
    return await timeout(
      client.calendar.getTimetable(week.from, week.to),
      45,
      "Plan lekcji nie dotarł na czas.",
    );
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure("Nie udało się pobrać planu lekcji z dziennika.", {
      cause: error,
    });
  }
};

const fetchEvents = async (client, week) => {
  const months = new Map();
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(week.monday, index);
    months.set(`${date.getFullYear()}-${date.getMonth()}`, [
      date.getMonth() + 1,
      date.getFullYear(),
    ]);
  }

  const raw = [];
  for (const [month, year] of months.values()) {
    try {
      const calendar = await timeout(
        client.calendar.getCalendar(month, year),
        30,
        "Terminarz nie dotarł na czas.",
      );
      raw.push(...(Array.isArray(calendar) ? calendar.flat(Infinity) : []));
    } catch {}
  }

  const inWeek = raw
    .filter(
      (entry) =>
        /^\d{4}-\d{2}-\d{2}$/.test(entry?.day ?? "") &&
        entry.day >= week.from &&
        entry.day <= week.to &&
        clean(entry?.title),
    )
    .slice(0, 25);

  const events = [];
  for (const entry of inWeek) {
    let details = null;
    if (Number.isInteger(entry.id) && entry.id > 0) {
      try {
        details = await timeout(
          client.calendar.getEvent(entry.id),
          20,
          "Szczegóły wydarzenia nie dotarły na czas.",
        );
      } catch {
        details = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    events.push({
      day: entry.day,
      lesson: Number.parseInt(clean(details?.lessonNumber), 10),
      label: [
        clean(details?.type) || clean(entry.title),
        clean(details?.subject),
        clean(details?.description),
      ]
        .filter(Boolean)
        .join(glyphs.dot),
    });
  }
  return events;
};

const buildSchedule = (timetable, week, events) => {
  const hours = Array.isArray(timetable?.hours) ? timetable.hours : [];
  const grid = timetable?.table ?? {};
  if (hours.length === 0)
    throw new Failure(
      "Librus nie zwrócił godzin lekcyjnych dla tego tygodnia.",
    );

  const slots = hours.map((raw, index) => {
    const text = clean(raw);
    const range = text.match(
      /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/,
    );
    const number = text.match(/^(\d{1,2})\s*[.)]?\s/);
    const at = (hour, minute) => `${String(hour).padStart(2, "0")}:${minute}`;
    return {
      number: number ? Number(number[1]) : index + 1,
      label: range
        ? `${at(range[1], range[2])}-${at(range[3], range[4])}`
        : text || "?",
    };
  });

  const all = weekdays.map(([key, name], index) => {
    const date = addDays(week.monday, index);
    return {
      name,
      date,
      day: toIso(date),
      notes: [],
      lessons: slots.map((_, slot) => {
        const lesson = grid?.[key]?.[slot];
        const subject = clean(lesson?.subject);
        if (!subject) return null;
        const room = clean(lesson?.room).replace(/^s\.\s*/i, "");
        return {
          subject,
          teacher: clean(lesson?.teacher),
          room: room && !/^sala\b/i.test(room) ? `sala ${room}` : room,
          notes: [],
        };
      }),
    };
  });

  const days = all.filter(
    (entry, index) => index < 5 || entry.lessons.some(Boolean),
  );
  if (!days.some((entry) => entry.lessons.some(Boolean))) {
    throw new Failure(
      "W tym tygodniu nie ma żadnych lekcji (ferie, wakacje lub brak planu w dzienniku).",
    );
  }

  for (const event of events) {
    const day = days.find((entry) => entry.day === event.day);
    if (!day || !event.label) continue;
    const slot = slots.findIndex((entry) => entry.number === event.lesson);
    if (slot >= 0 && day.lessons[slot])
      day.lessons[slot].notes.push(event.label);
    else day.notes.push(event.label);
  }

  const filled = slots.map((_, slot) => days.some((day) => day.lessons[slot]));
  const first = filled.indexOf(true);
  const last = filled.lastIndexOf(true);

  return {
    slots: slots.slice(first, last + 1),
    days: days.map((day) => ({
      ...day,
      lessons: day.lessons.slice(first, last + 1),
    })),
    week: `${dates.long.format(week.monday)} - ${dates.long.format(addDays(week.monday, 6))}`,
    count: days.reduce(
      (total, day) => total + day.lessons.filter(Boolean).length,
      0,
    ),
  };
};

const wrap = (text, width) => {
  const words = clean(text).split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    let rest = word;
    while ([...rest].length > width) {
      lines.push(`${[...rest].slice(0, width - 1).join("")}-`);
      rest = [...rest].slice(width - 1).join("");
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines;
};

const cellOf = (lesson, width) => {
  if (!lesson) return [{ text: "-", code: "90" }];
  const lines = wrap(lesson.subject, width).map((text) => ({
    text,
    code: "1",
  }));
  for (const text of wrap(lesson.teacher, width))
    lines.push({ text, code: "90" });
  for (const text of wrap(lesson.room, width)) lines.push({ text, code: "90" });
  for (const note of lesson.notes) {
    for (const text of wrap(`${glyphs.bullet} ${note}`, width))
      lines.push({ text, code: "33" });
  }
  return lines;
};

const grid = (header, rows, widths) => {
  const [h, v, tl, tt, tr, lt, cross, rt, bl, bt, br] = [...glyphs.box];
  const rule = (left, middle, right) =>
    left + widths.map((width) => h.repeat(width + 2)).join(middle) + right;
  const line = (cells) => {
    const height = Math.max(1, ...cells.map((cell) => cell.length));
    return Array.from(
      { length: height },
      (_, index) =>
        `${v}${cells
          .map((cell, column) => {
            const { text = "", code = null } = cell[index] ?? {};
            return ` ${paint(text + " ".repeat(Math.max(0, widths[column] - [...text].length)), code)} `;
          })
          .join(v)}${v}`,
    ).join("\n");
  };
  return [
    rule(tl, tt, tr),
    line(header),
    rule(lt, cross, rt),
    rows.map(line).join(`\n${rule(lt, cross, rt)}\n`),
    rule(bl, bt, br),
  ].join("\n");
};

const cellsOf = (schedule) => {
  const map = new Map();
  for (const day of schedule.days) {
    schedule.slots.forEach((slot, index) => {
      map.set(`${day.day}#${slot.number}`, {
        day,
        slot,
        lesson: day.lessons[index],
      });
    });
  }
  return map;
};

const describe = (lesson) =>
  lesson
    ? [lesson.subject, lesson.teacher, lesson.room].filter(Boolean).join(", ")
    : null;

const changesBetween = (before, after) => {
  if (!before) return [];
  const previous = cellsOf(before);
  const changes = [];
  for (const [key, { day, slot, lesson }] of cellsOf(after)) {
    const old = previous.get(key);
    const was = describe(old?.lesson);
    const is = describe(lesson);
    const notesBefore = (old?.lesson?.notes ?? []).join(" ");
    const notesAfter = (lesson?.notes ?? []).join(" ");
    if (was === is && notesBefore === notesAfter) continue;
    const where = `${day.name} ${dates.short.format(day.date)}, lekcja ${slot.number}`;
    if (!was && is) changes.push(`${where}: dodano ${is}`);
    else if (was && !is) changes.push(`${where}: odwołano ${was}`);
    else if (was !== is) changes.push(`${where}: ${was} -> ${is}`);
    else
      changes.push(`${where}: ${notesAfter || "usunięto wpis z terminarza"}`);
  }
  for (const day of after.days) {
    const old = before.days.find((entry) => entry.day === day.day);
    for (const note of day.notes) {
      if (!old?.notes?.includes(note))
        changes.push(`${day.name} ${dates.short.format(day.date)}: ${note}`);
    }
  }
  return changes;
};

const trailer = (meta) => {
  if (!meta) return [];
  const lines = [];
  const age = since(Date.now() - meta.fetchedAt);
  if (meta.source === "cache") {
    lines.push(paint(`Z pamięci podręcznej, pobrane ${age}.`, "90"));
  } else if (meta.source === "offline") {
    lines.push(
      paint(
        `Brak łączności z Synergią (${meta.reason}), pokazuję dane pobrane ${age}.`,
        "33",
      ),
    );
  } else {
    const events = meta.reusedEvents
      ? `${glyphs.dot}terminarz z pamięci, sprawdzony ${since(Date.now() - meta.eventsAt)}`
      : "";
    lines.push(paint(`Pobrane z dziennika przed chwilą${events}.`, "90"));
  }
  if (meta.changes?.length > 0) {
    lines.push("", paint("Zmiany od poprzedniego pobrania:", "1"));
    for (const change of meta.changes.slice(0, 10))
      lines.push(`  ${glyphs.bullet} ${paint(change, "33")}`);
    if (meta.changes.length > 10)
      lines.push(paint(`  ...oraz ${meta.changes.length - 10} więcej`, "90"));
  } else if (meta.source === "network" && meta.compared) {
    lines.push(paint("Bez zmian od poprzedniego pobrania.", "90"));
  }
  return lines;
};

const render = (schedule, profile, meta) => {
  const head = [
    paint(`Plan lekcji${glyphs.dot}${schedule.week}`, "1"),
    [
      profile.name,
      profile.group && `klasa ${profile.group}`,
      profile.lucky && `szczęśliwy numerek: ${profile.lucky}`,
    ]
      .filter(Boolean)
      .join(glyphs.dot),
  ];

  const width = Math.max(60, process.stdout.columns || 120);
  const span = Math.min(
    28,
    Math.floor(
      (width - 1 - 3 * (schedule.days.length + 1) - 13) / schedule.days.length,
    ),
  );

  const body =
    span >= 14
      ? grid(
          [
            [
              { text: "Lekcja", code: "1" },
              { text: "godziny", code: "90" },
            ],
            ...schedule.days.map((day) => [
              { text: day.name, code: "1" },
              { text: dates.short.format(day.date), code: "90" },
            ]),
          ],
          schedule.slots.map((slot, index) => [
            [
              { text: `${slot.number}.`, code: "1" },
              { text: slot.label, code: "90" },
            ],
            ...schedule.days.map((day) => cellOf(day.lessons[index], span)),
          ]),
          [13, ...schedule.days.map(() => span)],
        )
      : schedule.days
          .map((day) =>
            [
              paint(`${day.name}, ${dates.short.format(day.date)}`, "1"),
              ...schedule.slots.map((slot, index) => {
                const lesson = day.lessons[index];
                const time = paint(
                  `${String(slot.number).padStart(2)}. ${slot.label}`,
                  "90",
                );
                if (!lesson) return `  ${time}  ${paint("-", "90")}`;
                const extra = [lesson.teacher, lesson.room, ...lesson.notes]
                  .filter(Boolean)
                  .join(glyphs.dot);
                return `  ${time}  ${paint(lesson.subject, "1")}${extra ? paint(`${glyphs.dot}${extra}`, "90") : ""}`;
              }),
            ].join("\n"),
          )
          .join("\n\n");

  const notes = schedule.days
    .filter((day) => day.notes.length > 0)
    .map(
      (day) =>
        `  ${glyphs.bullet} ${paint(day.name, "1")}: ${day.notes.join(glyphs.dot)}`,
    );

  return [
    ...head,
    "",
    body,
    ...(notes.length > 0 ? ["", paint("Terminarz:", "1"), ...notes] : []),
    "",
    paint(
      `Lekcji w tygodniu: ${schedule.count}${glyphs.dot}stan na ${dates.stamp.format(new Date(meta?.fetchedAt ?? Date.now()))}`,
      "90",
    ),
    ...trailer(meta),
  ].join("\n");
};

const parseArguments = (argv) => {
  const options = {
    date: null,
    offset: 0,
    account: null,
    events: null,
    cache: true,
    refresh: false,
    purge: false,
    help: false,
  };
  const args = [...argv];
  const value = (flag) => {
    const next = args.shift();
    if (!next || next.startsWith("-"))
      throw new Failure(`Opcja ${flag} wymaga wartości.`);
    return next;
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-d" || arg === "--date") options.date = value(arg);
    else if (arg === "-n" || arg === "--next") options.offset = 1;
    else if (arg === "-a" || arg === "--account") options.account = value(arg);
    else if (arg === "--events") options.events = true;
    else if (arg === "--no-events") options.events = false;
    else if (arg === "-r" || arg === "--refresh") options.refresh = true;
    else if (arg === "--no-cache") options.cache = false;
    else if (arg === "--clear-cache") options.purge = true;
    else if (arg === "--no-color") ui.color = false;
    else
      throw new Failure(
        `Nieznana opcja: ${arg}. Użyj --help, aby zobaczyć listę opcji.`,
      );
  }
  if (
    options.date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(options.date) ||
      Number.isNaN(new Date(`${options.date}T12:00:00`).getTime()))
  ) {
    throw new Failure(
      "Data musi być poprawną datą w formacie RRRR-MM-DD, np. 2026-09-21.",
    );
  }
  return options;
};

const help =
  () => `Libruschedule${glyphs.dot}plan lekcji z dziennika Librus Synergia

Użycie:
  libruschedule [opcje]

Bez opcji program uruchamia się w trybie interaktywnym (menu, obsługa kont).

Opcje:
  -d, --date <RRRR-MM-DD>  pokaż tydzień zawierający podany dzień
  -n, --next               pokaż następny tydzień
  -a, --account <nazwa>    wybierz zapisane konto (nazwa lub login)
      --events             dociągnij szczegóły z terminarza
      --no-events          pomiń terminarz
  -r, --refresh            pomiń pamięć podręczną i pobierz dane na nowo
      --no-cache           nie czytaj i nie zapisuj pamięci podręcznej
      --clear-cache        wyczyść pamięć podręczną i zakończ
      --no-color           wyłącz kolory
  -h, --help               ta pomoc

Zmienne środowiskowe:
  LIBRUS_LOGIN, LIBRUS_PASSWORD - logowanie bez zapisanego konta

Plan jest zapisywany w pamięci podręcznej i odświeżany, gdy zmienią się
liczniki powiadomień w dzienniku albo minie czas ważności wpisu
(15 minut w godzinach lekcyjnych, 3 godziny poza nimi, 7 dni dla minionych tygodni).

Hasła trafiają do pęku kluczy systemu (Keychain, DPAPI, libsecret),
a gdy nie jest dostępny - do zaszyfrowanego pliku ${join(storePath(), "config.json")}
Pamięć podręczna: ${cacheFile()}`;

const pickAccount = (config, hint) => {
  if (config.accounts.length === 0) return null;
  if (hint) {
    const needle = hint.toLowerCase();
    const found = config.accounts.find(
      (entry) =>
        entry.label?.toLowerCase() === needle ||
        entry.login.toLowerCase() === needle,
    );
    if (!found)
      throw new Failure(
        `Nie znaleziono konta "${hint}". Dodaj je w menu lub sprawdź nazwę.`,
      );
    return found;
  }
  return (
    config.accounts.find((entry) => entry.id === config.active) ??
    config.accounts[0]
  );
};

const session = { id: null, client: null, profile: null };

const openSession = async (config, account) => {
  if (session.id === account.id && session.client) return session;
  let password = await vault.read(account, config.salt);
  let rescued = false;
  if (!password) {
    write(
      process.stdout,
      paint(
        `\nNie udało się odczytać hasła dla konta ${account.label || account.login}.\n`,
        "33",
      ),
    );
    password = await askSecret(`Hasło do konta ${account.login}`);
    rescued = true;
  }
  if (!password) throw new Failure("Hasło nie może być puste.");

  const client = await step(`Logowanie jako ${account.login}`, () =>
    connect(account.login, password),
  );
  const profile = await step("Pobieranie danych ucznia", () =>
    fetchProfile(client),
  );

  if (rescued) {
    const stored = await vault.save(account.login, password, config.salt);
    Object.assign(account, stored);
    await saveConfig(config);
  }

  session.id = account.id;
  session.client = client;
  session.profile = profile;
  return session;
};

const loadWeek = async (key, open, week, config, options) => {
  const useCache = options.cache !== false;
  const cache = useCache ? await readCache() : { entries: {} };
  const stored = cache.entries[key];
  const now = Date.now();

  if (
    !options.refresh &&
    stored?.timetable &&
    now - stored.fetchedAt < cacheLife(week)
  ) {
    return {
      ...stored,
      meta: {
        source: "cache",
        fetchedAt: stored.fetchedAt,
        eventsAt: stored.eventsAt,
      },
    };
  }

  try {
    const { client, profile } = await open();
    const signature = await step("Sprawdzanie zmian w dzienniku", () =>
      fetchSignature(client),
    );
    const timetable = await step(
      `Pobieranie planu ${week.from} - ${week.to}`,
      () => fetchTimetable(client, week),
    );
    const wanted = options.events ?? config.events;
    const reuse =
      !options.refresh &&
      wanted &&
      Array.isArray(stored?.events) &&
      Boolean(signature) &&
      signature === stored.signature &&
      now - stored.eventsAt < 86400000;
    const events = !wanted
      ? []
      : reuse
        ? stored.events
        : await step("Pobieranie terminarza", () => fetchEvents(client, week));

    const entry = {
      timetable,
      events,
      signature,
      profile: { ...profile, luckyDay: toIso(new Date()) },
      fetchedAt: now,
      eventsAt: reuse ? stored.eventsAt : now,
    };
    if (useCache) {
      cache.entries[key] = entry;
      await writeCache(cache);
    }
    return {
      ...entry,
      meta: {
        source: "network",
        fetchedAt: now,
        eventsAt: entry.eventsAt,
        reusedEvents: Boolean(reuse),
        previous: stored,
      },
    };
  } catch (error) {
    if (error instanceof Cancelled || !stored?.timetable) throw error;
    return {
      ...stored,
      meta: {
        source: "offline",
        fetchedAt: stored.fetchedAt,
        eventsAt: stored.eventsAt,
        reason: error.message,
      },
    };
  }
};

const rebuild = (entry, week) => {
  try {
    return entry?.timetable
      ? buildSchedule(entry.timetable, week, entry.events ?? [])
      : null;
  } catch {
    return null;
  }
};

const showPlan = async (key, open, week, config, options) => {
  const data = await loadWeek(key, open, week, config, options);
  const schedule = buildSchedule(data.timetable, week, data.events ?? []);
  const before = rebuild(data.meta.previous, week);
  const meta = {
    ...data.meta,
    compared: Boolean(before),
    changes: changesBetween(before, schedule),
  };
  const profile = data.profile ?? { name: "Uczeń" };
  const shown = {
    ...profile,
    lucky: profile.luckyDay === toIso(new Date()) ? profile.lucky : null,
  };
  write(process.stdout, `\n${render(schedule, shown, meta)}\n`);
};

const showWeek = async (config, account, options) => {
  const week = weekOf(options.date, options.offset);
  await showPlan(
    `${account.id}:${week.from}`,
    () => openSession(config, account),
    week,
    config,
    options,
  );
};

const addAccount = async (config) => {
  const login = await ask("Login Synergia");
  if (!login) throw new Failure("Login nie może być pusty.");
  if (config.accounts.some((entry) => entry.login === login))
    throw new Failure("To konto jest już zapisane.");
  const password = await askSecret("Hasło");
  if (!password) throw new Failure("Hasło nie może być puste.");

  const client = await step("Weryfikacja danych logowania", () =>
    connect(login, password),
  );
  const profile = await step("Pobieranie danych ucznia", () =>
    fetchProfile(client),
  );
  const label = await ask("Nazwa konta", profile.name);
  const stored = await vault.save(login, password, config.salt);

  const account = { id: randomUUID(), label, login, ...stored };
  config.accounts.push(account);
  config.active = account.id;
  await saveConfig(config);

  session.id = account.id;
  session.client = client;
  session.profile = profile;

  const where = {
    keychain: "pęku kluczy systemu",
    dpapi: "magazynie DPAPI systemu Windows",
    local: "zaszyfrowanym pliku konfiguracyjnym",
  }[stored.keeper];
  write(
    process.stdout,
    paint(
      `\n${glyphs.ok} Konto ${label} zapisane, hasło przechowywane w ${where}.\n`,
      "32",
    ),
  );
  return account;
};

const switchAccount = async (config) => {
  if (config.accounts.length === 0) return addAccount(config);
  const id = await choose(
    "Wybierz konto",
    config.accounts.map((entry) => ({
      label: `${entry.label || entry.login}${entry.id === config.active ? paint(" (aktywne)", "90") : ""}`,
      value: entry.id,
    })),
  );
  if (!id) return null;
  config.active = id;
  await saveConfig(config);
  const account = config.accounts.find((entry) => entry.id === id);
  write(
    process.stdout,
    paint(
      `\n${glyphs.ok} Aktywne konto: ${account.label || account.login}\n`,
      "32",
    ),
  );
  return account;
};

const removeAccount = async (config) => {
  if (config.accounts.length === 0)
    throw new Failure("Nie ma zapisanych kont.");
  const id = await choose(
    "Które konto usunąć?",
    config.accounts.map((entry) => ({
      label: entry.label || entry.login,
      value: entry.id,
    })),
  );
  if (!id) return null;
  const confirmed = await choose("Na pewno usunąć konto i zapisane hasło?", [
    { label: "Nie, wróć", value: false },
    { label: "Tak, usuń", value: true },
  ]);
  if (!confirmed) return null;

  const account = config.accounts.find((entry) => entry.id === id);
  await vault.forget(account);
  config.accounts = config.accounts.filter((entry) => entry.id !== id);
  if (config.active === id) config.active = config.accounts[0]?.id ?? null;
  if (session.id === id)
    Object.assign(session, { id: null, client: null, profile: null });
  await saveConfig(config);
  write(
    process.stdout,
    paint(
      `\n${glyphs.ok} Usunięto konto ${account.label || account.login}.\n`,
      "32",
    ),
  );
  return null;
};

const guard = async (task) => {
  try {
    await task();
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    write(
      process.stdout,
      `\n${paint("Błąd:", "31")} ${error instanceof Failure ? error.message : `nieoczekiwany problem (${error.message})`}\n`,
    );
  }
};

const menu = async (config, options) => {
  let account = pickAccount(config, options.account);
  while (!account) {
    try {
      account = await addAccount(config);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      write(
        process.stdout,
        `\n${paint("Błąd:", "31")} ${error instanceof Failure ? error.message : error.message}\n`,
      );
      const retry = await choose("Spróbować ponownie?", [
        { label: "Tak, wpisz dane jeszcze raz", value: true },
        { label: "Nie, zakończ", value: false },
      ]);
      if (!retry) return;
    }
  }

  for (;;) {
    const title = `Libruschedule${glyphs.dot}${account.label || account.login}${config.events ? "" : `${glyphs.dot}terminarz wyłączony`}`;
    const action = await choose(title, [
      { label: "Plan na bieżący tydzień", value: "current" },
      { label: "Plan na następny tydzień", value: "next" },
      { label: "Plan na wybrany dzień", value: "date" },
      { label: "Przełącz konto", value: "switch" },
      { label: "Dodaj konto", value: "add" },
      { label: "Usuń konto", value: "remove" },
      {
        label: config.events
          ? "Wyłącz pobieranie terminarza"
          : "Włącz pobieranie terminarza",
        value: "events",
      },
      { label: "Wyczyść pamięć podręczną", value: "purge" },
      { label: "Wyjście", value: "exit" },
    ]);

    if (!action || action === "exit") return;

    if (action === "current" || action === "next" || action === "date") {
      const date =
        action === "date"
          ? await ask("Data (RRRR-MM-DD)", toIso(new Date()))
          : null;
      let refresh = options.refresh;
      for (;;) {
        await guard(() =>
          showWeek(config, account, {
            ...options,
            date,
            refresh,
            offset: action === "next" ? 1 : 0,
          }),
        );
        const pressed = await pause(
          "Naciśnij r, aby pobrać na nowo, dowolny inny klawisz wraca do menu",
        );
        if (pressed !== "r") break;
        refresh = true;
      }
      continue;
    }

    if (action === "switch")
      await guard(
        async () => (account = (await switchAccount(config)) ?? account),
      );
    else if (action === "add")
      await guard(
        async () => (account = (await addAccount(config)) ?? account),
      );
    else if (action === "remove") {
      await guard(async () => {
        await removeAccount(config);
        account = pickAccount(config, null) ?? (await addAccount(config));
      });
    } else if (action === "events") {
      config.events = !config.events;
      await guard(() => saveConfig(config));
    } else if (action === "purge") {
      await guard(async () => {
        await dropCache();
        write(
          process.stdout,
          paint(`\n${glyphs.ok} Pamięć podręczna wyczyszczona.\n`, "32"),
        );
      });
    }
  }
};

const once = async (config, options) => {
  const login = process.env.LIBRUS_LOGIN;
  const password = process.env.LIBRUS_PASSWORD;
  if (login && password) {
    const week = weekOf(options.date, options.offset);
    const open = async () => {
      const client = await step(`Logowanie jako ${login}`, () =>
        connect(login, password),
      );
      const profile = await step("Pobieranie danych ucznia", () =>
        fetchProfile(client),
      );
      return { client, profile };
    };
    await showPlan(`env:${login}:${week.from}`, open, week, config, options);
    return;
  }
  const account = pickAccount(config, options.account);
  if (!account) {
    throw new Failure(
      "Brak zapisanych kont. Uruchom program w terminalu interaktywnym albo ustaw LIBRUS_LOGIN i LIBRUS_PASSWORD.",
    );
  }
  await showWeek(config, account, options);
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    write(process.stdout, `${help()}\n`);
    return;
  }
  if (options.purge) {
    await dropCache();
    write(process.stdout, `Pamięć podręczna wyczyszczona.\n`);
    return;
  }
  const config = await loadConfig();
  if (
    ui.interactive &&
    !options.date &&
    options.offset === 0 &&
    !process.env.LIBRUS_LOGIN
  )
    await menu(config, options);
  else await once(config, options);
};

const stop = () => {
  cursor(true);
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {}
};

process.on("SIGINT", () => {
  stop();
  write(process.stdout, "\nPrzerwano.\n");
  process.exit(130);
});

try {
  await main();
  stop();
} catch (error) {
  stop();
  if (error instanceof Cancelled) {
    write(process.stdout, "\nPrzerwano.\n");
    process.exit(130);
  }
  const message =
    error instanceof Failure
      ? error.message
      : `Wystąpił nieoczekiwany błąd: ${error?.message ?? error}`;
  write(process.stderr, `${paint("Błąd:", "31")} ${message}\n`);
  if (error?.cause?.message)
    write(process.stderr, paint(`Szczegóły: ${error.cause.message}\n`, "90"));
  process.exitCode = 1;
}
