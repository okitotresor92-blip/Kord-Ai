/**
 * Smart Message Scheduler for Kord (Node.js / CommonJS)
 * - Natural times (chrono-node) for simple: "7pm", "tomorrow 9am", "in 2 hours"
 * - Natural recurring (later.js) for: "every monday at 8am", "at 9:00 on Monday"
 * - Commands:
 *     !schedule <time-or-phrase> <message>        -> one-time (accepts HH:MM or natural)
 *     !repeat <daily|weekly|natural-phrase> <time-or-phrase> <message>
 *         examples:
 *           !repeat daily 09:00 Hello
 *           !repeat natural "every monday at 08:00" Team check-in
 *     !multi <time1,time2,... or natural-phrase> <message>
 *     !list
 *     !cancel all | !cancel <jobKey>
 *
 * Note: this stores jobs in memory (no persistence).
 */

const chrono = require("chrono-node");   // npm i chrono-node
const later = require("later");          // npm i @breejs/later  OR npm i later
later.date.localTime(); // use local timezone parsing

const scheduledJobs = {}; // key -> { type, timeStr, msg, nextRun (Date), timerId }

function genKey(prefix = "job") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function formatDate(d) {
  if (!d) return "unknown";
  return new Date(d).toLocaleString();
}

/** schedule a one-time Date object */
function scheduleOneTime(key, dateObj, msg, context) {
  const now = new Date();
  const ms = dateObj - now;
  if (ms <= 0) {
    // If in the past, send immediately
    context.send(msg);
    return;
  }

  const timer = setTimeout(() => {
    context.send(msg).catch(() => {});
    // cleanup
    delete scheduledJobs[key];
  }, ms);

  scheduledJobs[key] = { type: "once", timeStr: dateObj.toString(), msg, nextRun: dateObj, timerId: timer };
  return key;
}

/** schedule recurring using later.js text schedule or fixed interval (daily/weekly) */
function scheduleRecurringText(key, scheduleText, msg, context) {
  // later.parse.text produces a schedule object
  const sched = later.parse.text(scheduleText);
  if (sched.error && sched.error.length) {
    throw new Error("Could not parse recurring schedule text.");
  }

  // compute next occurrence
  const next = later.schedule(sched).next(1);
  if (!next) throw new Error("Could not compute next occurrence.");

  // function that sends then reschedules next occurrence
  function sendAndReschedule() {
    context.send(msg).catch(() => {});
    const nextDate = later.schedule(sched).next(1, new Date(Date.now() + 1000));
    if (nextDate) {
      const delay = nextDate - new Date();
      scheduledJobs[key].timerId = setTimeout(sendAndReschedule, delay);
      scheduledJobs[key].nextRun = nextDate;
    } else {
      // no next date => stop
      delete scheduledJobs[key];
    }
  }

  const delay = next - new Date();
  const timer = setTimeout(sendAndReschedule, delay);
  scheduledJobs[key] = { type: "recurring_text", timeStr: scheduleText, msg, nextRun: next, timerId: timer };
  return key;
}

/** schedule daily at HH:MM */
function scheduleDaily(key, hour, minute, msg, context) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  function sendAndRepeat() {
    context.send(msg).catch(() => {});
    // schedule next day
    const nextDate = new Date();
    nextDate.setDate(new Date().getDate() + 1);
    nextDate.setHours(hour, minute, 0, 0);
    const delay = nextDate - new Date();
    scheduledJobs[key].timerId = setTimeout(sendAndRepeat, delay);
    scheduledJobs[key].nextRun = nextDate;
  }

  const timer = setTimeout(sendAndRepeat, next - now);
  scheduledJobs[key] = { type: "daily", timeStr: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`, msg, nextRun: next, timerId: timer };
  return key;
}

/** parse either HH:MM or natural with chrono */
function parseTimeOrPhrase(token) {
  // check if token looks like HH:MM
  const hm = token.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const hour = parseInt(hm[1], 10);
    const minute = parseInt(hm[2], 10);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return { type: "date", date: target };
  }

  // else try chrono natural parse
  const parsed = chrono.parseDate(token, new Date(), { forwardDate: true });
  if (parsed) return { type: "date", date: parsed };

  // could not parse as a single date
  return { type: "unknown" };
}

module.exports = {
  name: "Smart NL Scheduler",
  description: "Schedule messages with natural language and recurring phrases (chrono-node + later.js).",

  async onMessage(context, message) {
    try {
      const raw = message.text?.trim();
      if (!raw) return;
      const lower = raw.toLowerCase();

      // === !schedule <time-or-phrase> <message>  (natural allowed) ===
      if (lower.startsWith("!schedule ")) {
        // allow quotes for multi-word time-phrases:
        // Example: !schedule "tomorrow 7pm" Good night
        const rest = raw.slice("!schedule ".length).trim();

        // if first token is quoted, extract it
        let firstToken = null;
        let msg = null;
        if (rest.startsWith('"')) {
          const endQuote = rest.indexOf('"', 1);
          if (endQuote > 0) {
            firstToken = rest.slice(1, endQuote);
            msg = rest.slice(endQuote + 1).trim();
          }
        } else {
          const parts = rest.split(" ");
          firstToken = parts[0];
          msg = parts.slice(1).join(" ");
        }

        if (!firstToken || !msg) return context.send("🕒 Usage: !schedule <time-or-phrase> <message>\nExamples:\n!schedule 08:30 Good morning\n!schedule \"tomorrow 7pm\" Good night");

        // try parse
        const parsed = parseTimeOrPhrase(firstToken);
        if (parsed.type === "date") {
          const key = genKey("once");
          scheduleOneTime(key, parsed.date, msg, context);
          return context.send(`✅ Scheduled once for ${formatDate(parsed.date)} (key: ${key})`);
        } else {
          // Maybe the user passed a longer natural phrase with spaces (not quoted) — try chrono on the whole rest before msg
          // Try to find a date inside rest (chrono.parse)
          const chronoResult = chrono.parse(rest, new Date(), { forwardDate: true });
          if (chronoResult && chronoResult.length > 0) {
            const dt = chronoResult[0].start.date();
            const textFound = chronoResult[0].text;
            // message likely after that text
            const after = rest.replace(textFound, "").trim();
            const finalMsg = after.length ? after : msg;
            const key = genKey("once");
            scheduleOneTime(key, dt, finalMsg, context);
            return context.send(`✅ Scheduled once for ${formatDate(dt)} (key: ${key})`);
          }
          return context.send("⚠️ Could not parse time. Try formats like `07:00`, `7pm`, `tomorrow 9am`, or wrap the phrase in quotes.");
        }
      }

      // === !repeat daily HH:MM message  OR  !repeat natural "<phrase>" message ===
      else if (lower.startsWith("!repeat ")) {
        const rest = raw.slice("!repeat ".length).trim();
        // check if user used prefix 'daily' or 'weekly'
        const tokens = rest.split(" ");
        const firstLower = tokens[0].toLowerCase();

        if (firstLower === "daily" || firstLower === "weekly") {
          // old style: !repeat daily 09:00 message
          if (tokens.length < 3) return context.send("🔁 Usage: !repeat daily|weekly HH:MM message OR !repeat natural \"every monday at 8am\" message");
          const timeToken = tokens[1];
          const msg = tokens.slice(2).join(" ");
          const hm = timeToken.match(/^(\d{1,2}):(\d{2})$/);
          if (!hm) return context.send("⚠️ For 'daily'/'weekly' please use HH:MM (e.g., 09:00).");
          const hour = parseInt(hm[1], 10), minute = parseInt(hm[2], 10);
          const key = genKey(firstLower);
          // schedule either daily or weekly as repeated daily
          if (firstLower === "daily") {
            scheduleDaily(key, hour, minute, msg, context);
            return context.send(`🔁 Daily scheduled at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} (key: ${key})`);
          } else {
            // for weekly use later.parse.text for "at HH:MM on <weekday>"
            const schedText = `at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} on ${new Date().toLocaleDateString('en-US', {weekday:'long'})}`; // placeholder
            // simpler: use later: e.g., "at 09:00 on Monday"
            // But we need weekday from user — we can't infer, so ask user to use 'natural' variant for weekdays.
            return context.send("⚠️ For weekly with weekdays please use the natural format: `!repeat natural \"every Monday at 08:00\" Message`");
          }
        }

        // support: !repeat natural "every monday at 8am" Message
        if (tokens[0].toLowerCase() === "natural") {
          // rest after 'natural'
          const after = rest.slice("natural".length).trim();
          // first quoted phrase is the schedule phrase
          if (!after.startsWith('"')) return context.send("🔁 Usage: !repeat natural \"every monday at 8am\" Your message");
          const endQuote = after.indexOf('"', 1);
          if (endQuote < 1) return context.send("🔁 Usage: !repeat natural \"every monday at 8am\" Your message");
          const phrase = after.slice(1, endQuote);
          const msg = after.slice(endQuote + 1).trim();
          if (!msg) return context.send("🔁 Please provide the message text after the quoted schedule phrase.");
          // schedule via later
          try {
            const key = genKey("nrec");
            scheduleRecurringText(key, phrase, msg, context);
            return context.send(`🔁 Recurring schedule set for phrase: "${phrase}" (key: ${key})`);
          } catch (e) {
            return context.send("⚠️ Could not parse recurring phrase. Try examples like: \"every monday at 8am\" or \"at 09:00 on Monday\"");
          }
        }

        return context.send("🔁 Usage examples:\n!repeat daily 09:00 Hello\n!repeat natural \"every monday at 08:00\" Team check-in");
      }

      // === !multi time1,time2,... message  (accepts HH:MM or quoted phrase list) ===
      else if (lower.startsWith("!multi ")) {
        const rest = raw.slice("!multi ".length).trim();

        // if quoted natural phrase for recurring, use later
        if (rest.startsWith('"')) {
          const endQuote = rest.indexOf('"', 1);
          if (endQuote < 1) return context.send("📅 Usage: !multi \"every day at 08:00\" Message  OR !multi 08:00,14:00 Message");
          const phrase = rest.slice(1, endQuote);
          const msg = rest.slice(endQuote + 1).trim();
          if (!msg) return context.send("📅 Please add message text after the quoted phrase.");
          const key = genKey("multi_natural");
          try {
            scheduleRecurringText(key, phrase, msg, context);
            return context.send(`📅 Multi recurring set: "${phrase}" (key: ${key})`);
          } catch (e) {
            return context.send("⚠️ Could not parse phrase. Try \"every day at 08:00\" or list times like 08:00,14:00");
          }
        }

        // else assume list of HH:MM times
        const parts = rest.split(" ");
        if (parts.length < 2) return context.send("📅 Usage: !multi 08:00,14:00,19:30 Message");
        const timesRaw = parts[0];
        const msg = parts.slice(1).join(" ");
        const times = timesRaw.split(",").map(t => t.trim());
        const keys = [];
        for (const t of times) {
          const hm = t.match(/^(\d{1,2}):(\d{2})$/);
          if (!hm) continue;
          const hour = parseInt(hm[1], 10), minute = parseInt(hm[2], 10);
          const key = genKey("multi");
          scheduleDaily(key, hour, minute, msg, context);
          keys.push(key);
        }
        if (keys.length === 0) return context.send("⚠️ No valid HH:MM times found.");
        return context.send(`📅 Multi daily set for ${times.join(", ")} (keys: ${keys.join(", ")})`);
      }

      // === !list ===
      else if (lower === "!list") {
        const keys = Object.keys(scheduledJobs);
        if (keys.length === 0) return context.send("📭 No active scheduled messages.");
        let out = "📋 Active scheduled messages:\n\n";
        for (const k of keys) {
          const s = scheduledJobs[k];
          out += `Key: ${k}\nType: ${s.type}\nNext: ${formatDate(s.nextRun)}\nTime/Rule: ${s.timeStr}\nMsg: ${s.msg}\n\n`;
        }
        return context.send(out);
      }

      // === !cancel ===
      else if (lower.startsWith("!cancel ")) {
        const target = raw.slice("!cancel ".length).trim();
        if (!target) return context.send("❌ Usage: !cancel all OR !cancel <jobKey>");
        if (target.toLowerCase() === "all") {
          Object.keys(scheduledJobs).forEach(k => {
            if (scheduledJobs[k].timerId) {
              clearTimeout(scheduledJobs[k].timerId);
            }
            delete scheduledJobs[k];
          });
          return context.send("🛑 All scheduled jobs cancelled.");
        } else {
          const job = scheduledJobs[target];
          if (!job) return context.send("⚠️ Job key not found.");
          if (job.timerId) clearTimeout(job.timerId);
          delete scheduledJobs[target];
          return context.send(`🛑 Cancelled job ${target}`);
        }
      }

      // fallback: ignore
    } catch (err) {
      console.error("Scheduler plugin error:", err);
      try { await context.send("⚠️ Scheduler error: " + (err.message || err)); } catch (e) {}
    }
  }
};
