package `in`.kpriet.hodtasks

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

val TYPES = listOf("Things to do", "New idea", "Assignment", "Delegation of duty", "Other role", "Event", "Reminder")
val ACTIONS = listOf("calendar", "email", "whatsapp", "reminder")

/** Offline copy of the Google Sheet plus an outbox of unsent changes, kept as JSON files. */
class Store private constructor(private val ctx: Context) {
    private val file = File(ctx.filesDir, "store.json")
    private var root: JSONObject = load()

    private fun load(): JSONObject = try { JSONObject(file.readText()) } catch (e: Exception) { JSONObject() }

    @Synchronized private fun save() {
        val tmp = File(ctx.filesDir, "store.tmp"); tmp.writeText(root.toString()); tmp.renameTo(file)
    }

    private fun obj(k: String): JSONObject = root.optJSONObject(k) ?: JSONObject().also { root.put(k, it) }
    private fun outbox(): JSONArray = root.optJSONArray("outbox") ?: JSONArray().also { root.put("outbox", it) }

    fun setting(k: String) = obj("meta").optString(k, "")
    @Synchronized fun setSetting(k: String, v: String) { obj("meta").put(k, v); save() }

    private fun list(k: String) = obj(k).let { o -> o.keys().asSequence().map { o.getJSONObject(it) } }
        .filter { it.optString("deleted") != "true" }.toList()

    fun entries() = list("entries").sortedByDescending { it.optLong("created") }
    fun faculty() = list("faculty").sortedBy { it.optString("initials") }
    fun entry(id: String): JSONObject? = obj("entries").optJSONObject(id)

    @Synchronized fun saveEntry(changes: JSONObject): JSONObject {
        val now = System.currentTimeMillis()
        if (!changes.has("id")) { changes.put("id", UUID.randomUUID().toString().replace("-", "")); changes.put("created", now) }
        changes.put("updated", now); changes.put("device", "android")
        val merged = entry(changes.getString("id")) ?: JSONObject()
        changes.keys().forEach { merged.put(it, changes.get(it)) }
        obj("entries").put(merged.getString("id"), merged)
        outbox().put(JSONObject().put("op", "upsertEntry").put("entry", changes))
        save(); return merged
    }

    @Synchronized fun saveFaculty(f: JSONObject) {
        if (f.optString("id").isEmpty()) f.put("id", UUID.randomUUID().toString().replace("-", ""))
        f.put("initials", f.optString("initials").trim().uppercase()); f.put("updated", System.currentTimeMillis())
        obj("faculty").put(f.getString("id"), f)
        outbox().put(JSONObject().put("op", "upsertFaculty").put("faculty", f))
        save()
    }

    fun pending() = outbox().length()

    /** Upload outbox, download changes. Throws when offline. */
    fun sync(): String {
        val url = setting("url"); val token = setting("token")
        if (url.isEmpty() || token.isEmpty()) return "Set the Sheet URL and token in Settings"
        val ops: JSONArray; val sent: Int
        synchronized(this) { ops = JSONArray(outbox().toString()); sent = ops.length() }
        val since = setting("since").ifEmpty { "0" }
        val res = if (sent > 0) {
            post(url, JSONObject().put("token", token).put("device", "android").put("since", since.toLong()).put("ops", ops).toString())
        } else {
            get(url + (if ("?" in url) "&" else "?") + "token=" + URLEncoder.encode(token, "UTF-8") + "&since=" + since)
        }
        val out = JSONObject(res)
        if (!out.optBoolean("ok")) throw RuntimeException(out.optString("error", "Server error"))
        synchronized(this) {
            val box = outbox(); val rest = JSONArray()
            for (i in sent until box.length()) rest.put(box.get(i))
            root.put("outbox", rest)
            merge("faculty", out.optJSONArray("faculty")); merge("entries", out.optJSONArray("entries"))
            obj("meta").put("since", out.optLong("serverTime").toString())
            save()
        }
        return "Synced " + SimpleDateFormat("HH:mm", Locale.US).format(Date())
    }

    private fun merge(k: String, rows: JSONArray?) {
        rows ?: return
        val table = obj(k)
        for (i in 0 until rows.length()) {
            val r = rows.getJSONObject(i); val mine = table.optJSONObject(r.getString("id"))
            if (mine != null && mine.optLong("updated") > r.optString("updated").toLongOrNull() ?: 0L) continue
            table.put(r.getString("id"), r)
        }
    }

    // Apps Script replies to POST with a redirect that must be fetched with GET.
    private fun post(url: String, body: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false; c.requestMethod = "POST"; c.doOutput = true
        c.connectTimeout = 20000; c.readTimeout = 60000
        c.setRequestProperty("Content-Type", "text/plain;charset=utf-8")
        c.outputStream.use { it.write(body.toByteArray()) }
        val code = c.responseCode
        if (code in 300..399) return get(c.getHeaderField("Location"))
        return c.inputStream.bufferedReader().readText()
    }

    private fun get(url: String): String {
        var u = url
        repeat(5) {
            val c = URL(u).openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false; c.connectTimeout = 20000; c.readTimeout = 60000
            if (c.responseCode in 300..399) { u = c.getHeaderField("Location"); return@repeat }
            return c.inputStream.bufferedReader().readText()
        }
        throw RuntimeException("Too many redirects")
    }

    companion object {
        @Volatile private var inst: Store? = null
        fun get(ctx: Context) = inst ?: synchronized(this) { inst ?: Store(ctx.applicationContext).also { inst = it } }

        fun parseTime(s: String?): Long? {
            val m = Regex("""(\d{4})-(\d{2})-(\d{2})(?:[T ]+(\d{1,2}):(\d{2}))?""").find(s ?: "") ?: return null
            val (y, mo, d, h, mi) = m.destructured
            val cal = java.util.Calendar.getInstance()
            cal.set(y.toInt(), mo.toInt() - 1, d.toInt(), h.ifEmpty { "9" }.toInt(), mi.ifEmpty { "0" }.toInt(), 0)
            cal.set(java.util.Calendar.MILLISECOND, 0)
            return cal.timeInMillis
        }

        fun reminderTime(e: JSONObject): Long? =
            parseTime(e.optString("remindAt").ifEmpty { e.optString("date") + " " + e.optString("time") })

        fun autoFaculty(text: String, faculty: List<JSONObject>): List<String> = faculty.map { it.optString("initials") }
            .filter { i -> i.isNotEmpty() && (Regex("@" + Regex.escape(i) + "(?![A-Za-z0-9])", RegexOption.IGNORE_CASE).containsMatchIn(text) ||
                (i.length >= 2 && Regex("(?<![A-Za-z0-9@])" + Regex.escape(i) + "(?![A-Za-z0-9])").containsMatchIn(text))) }

        fun message(e: JSONObject, f: JSONObject): String {
            val due = listOf(e.optString("date"), e.optString("time")).filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "No deadline" }
            return "Dear ${f.optString("name")},\n\nYou have been assigned the following by the HoD, BME:\n\n" +
                "Category: ${e.optString("type")}\nTitle: ${e.optString("title")}\nDue: $due\nPriority: ${e.optString("priority", "Normal")}\n" +
                (if (e.optString("details").isNotEmpty()) "\nDetails:\n${e.optString("details")}\n" else "") +
                "\nRegards,\nHoD – Biomedical Engineering\nKPRIET"
        }
    }
}
