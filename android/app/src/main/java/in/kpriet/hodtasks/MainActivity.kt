package `in`.kpriet.hodtasks

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.util.Calendar

/** Single-screen app with tabs: New, Review, All, Faculty, Settings. UI is built in code to keep the project small. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private var tab = "New"
    private var editingId: String? = null
    private val tabs = listOf("New", "Review", "All", "Faculty", "Settings")
    private val tabButtons = mutableMapOf<String, Button>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store.get(this)
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        Reminders.channel(this)
        SyncWorker.start(this)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val bar = LinearLayout(this)
        tabs.forEach { t -> bar.addView(Button(this).apply { text = t; isAllCaps = false; setOnClickListener { show(t) } }.also { tabButtons[t] = it }) }
        root.addView(HorizontalScrollView(this).apply { addView(bar) })
        status = TextView(this).apply { setPadding(24, 4, 24, 4); textSize = 12f; setBackgroundColor(Color.parseColor("#E8EEFB")) }
        root.addView(status)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 16, 24, 48) }
        root.addView(ScrollView(this).apply { addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        show("New")
    }

    override fun onResume() {
        super.onResume()
        SyncWorker.now(this); Reminders.scheduleAll(this)
        status.postDelayed({ refreshStatus(); if (tab != "New" && tab != "Settings") show(tab) }, 4000)
        refreshStatus()
    }

    private fun refreshStatus() {
        val p = store.pending()
        status.text = store.setting("status").ifEmpty { "Not synced yet" } + if (p > 0) " · $p change(s) waiting to upload" else ""
        val n = store.entries().count { it.optString("status") == "review" }
        tabButtons["Review"]?.text = if (n > 0) "Review ($n)" else "Review"
    }

    private fun changed() { SyncWorker.now(this); Reminders.scheduleAll(this); refreshStatus() }

    private fun show(t: String) {
        tab = t; content.removeAllViews()
        tabButtons.forEach { (k, b) -> b.setTypeface(null, if (k == t) Typeface.BOLD else Typeface.NORMAL) }
        when (t) { "New" -> newForm(editingId?.let { store.entry(it) }); "Review" -> list(true); "All" -> list(false); "Faculty" -> facultyPage(); else -> settingsPage() }
        refreshStatus()
    }

    // ---------------------------------------------------------------- helpers
    private fun label(s: String) = TextView(this).apply { text = s; textSize = 13f; setTextColor(Color.DKGRAY); setPadding(0, 18, 0, 2) }.also { content.addView(it) }
    private fun field(hint: String, value: String = "", lines: Int = 1, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint; setText(value); inputType = if (lines > 1) type or InputType.TYPE_TEXT_FLAG_MULTI_LINE else type
        if (lines > 1) { minLines = lines; gravity = Gravity.TOP }
    }.also { content.addView(it) }
    private fun button(s: String, parent: ViewGroup = content, fn: () -> Unit) = Button(this).apply { text = s; isAllCaps = false; setOnClickListener { fn() } }.also { parent.addView(it) }
    private fun row() = LinearLayout(this).also { content.addView(it) }
    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    // ---------------------------------------------------------------- new / edit entry
    private fun newForm(e: JSONObject?) {
        label("Category")
        val type = Spinner(this).apply { adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, TYPES) }
        content.addView(type); e?.let { type.setSelection(maxOf(0, TYPES.indexOf(it.optString("type")))) }
        label("Title  (type @INITIALS to assign)")
        val title = field("e.g. Prepare NBA file @RK", e?.optString("title") ?: "")
        label("Details")
        val details = field("Details", e?.optString("details") ?: "", 4)
        label("Date & time")
        val dr = row()
        val date = Button(this).apply { text = e?.optString("date")?.ifEmpty { null } ?: "Pick date"; isAllCaps = false }.also { dr.addView(it) }
        val time = Button(this).apply { text = e?.optString("time")?.ifEmpty { null } ?: "Pick time"; isAllCaps = false }.also { dr.addView(it) }
        date.setOnClickListener { pickDate { date.text = it } }
        time.setOnClickListener { pickTime { time.text = it } }
        label("Priority")
        val prios = listOf("Normal", "High", "Urgent", "Low")
        val prio = Spinner(this).apply { adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, prios) }
        content.addView(prio); e?.let { prio.setSelection(maxOf(0, prios.indexOf(it.optString("priority")))) }

        label("Assign to")
        val chosen = (e?.optString("faculty") ?: "").split(",").toMutableSet()
        val facBoxes = store.faculty().associate { f ->
            val i = f.optString("initials")
            i to CheckBox(this).apply { text = "$i · ${f.optString("name")}"; isChecked = i in chosen }.also { content.addView(it) }
        }
        if (facBoxes.isEmpty()) label("Add faculty in the Faculty tab first.")
        val watcher = object : TextWatcher {
            override fun afterTextChanged(s: Editable?) { Store.autoFaculty("${title.text} ${details.text}", store.faculty()).forEach { facBoxes[it]?.isChecked = true } }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        }
        title.addTextChangedListener(watcher); details.addTextChangedListener(watcher)

        label("Actions")
        val names = mapOf("calendar" to "Add to Google Calendar", "email" to "Send email", "whatsapp" to "Send WhatsApp", "reminder" to "Remind me (phone + desktop)")
        val acts0 = (e?.optString("actions") ?: "").split(",")
        val actBoxes = ACTIONS.associateWith { a -> CheckBox(this).apply { text = names[a]; isChecked = a in acts0 }.also { content.addView(it) } }
        label("Remind at")
        val rr = row()
        val remind = Button(this).apply { text = e?.optString("remindAt")?.replace("T", " ")?.ifEmpty { null } ?: "Same as date/time"; isAllCaps = false }.also { rr.addView(it) }
        remind.setOnClickListener { pickDate { d -> pickTime { t -> remind.text = "$d $t" } } }

        fun save(st: String) {
            if (title.text.isBlank()) return toast("Enter a title")
            val acts = actBoxes.filter { it.value.isChecked }.keys
            val fac = facBoxes.filter { it.value.isChecked }.keys
            if ((acts.contains("email") || acts.contains("whatsapp")) && fac.isEmpty()) return toast("Choose the faculty to send to")
            val d = date.text.toString().takeIf { it.first().isDigit() } ?: ""
            val r = remind.text.toString().takeIf { it.first().isDigit() }?.replace(" ", "T") ?: ""
            if ("reminder" in acts && d.isEmpty() && r.isEmpty()) return toast("Pick a date or a remind-at time")
            val rec = JSONObject().put("type", type.selectedItem.toString()).put("title", title.text.toString().trim())
                .put("details", details.text.toString().trim()).put("date", d)
                .put("time", time.text.toString().takeIf { it.first().isDigit() } ?: "").put("priority", prio.selectedItem.toString())
                .put("faculty", fac.joinToString(",")).put("actions", acts.joinToString(",")).put("remindAt", r).put("status", st)
            editingId?.let { rec.put("id", it) }
            store.saveEntry(rec); editingId = null; changed()
            toast(if (st == "review") "Saved for review" else "Approved — will run when online"); show("New")
        }
        val br = row()
        button("Save for review", br) { save("review") }
        button("Save & approve", br) { save("approved") }
        if (editingId != null) button("Cancel edit", br) { editingId = null; show("New") }
    }

    private fun pickDate(cb: (String) -> Unit) {
        val c = Calendar.getInstance()
        DatePickerDialog(this, { _, y, m, d -> cb("%04d-%02d-%02d".format(y, m + 1, d)) }, c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH)).show()
    }
    private fun pickTime(cb: (String) -> Unit) {
        val c = Calendar.getInstance()
        TimePickerDialog(this, { _, h, m -> cb("%02d:%02d".format(h, m)) }, c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE), true).show()
    }

    // ---------------------------------------------------------------- lists
    private fun list(review: Boolean) {
        val items = store.entries().filter { (it.optString("status") == "review") == review }
        if (items.isEmpty()) label(if (review) "Nothing waiting for review." else "No entries yet.")
        val fac = store.faculty().associateBy { it.optString("initials") }
        for (e in items) {
            val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(20, 16, 20, 16); setBackgroundColor(Color.parseColor("#F4F6FB")) }
            content.addView(card, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 16 })
            card.addView(TextView(this).apply { text = e.optString("title"); textSize = 16f; setTypeface(null, Typeface.BOLD) })
            val due = listOf(e.optString("date"), e.optString("time")).filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "No deadline" }
            card.addView(TextView(this).apply { text = "${e.optString("type")} · ${e.optString("priority")} · $due\nTo: ${e.optString("faculty").ifEmpty { "-" }} · Actions: ${e.optString("actions").ifEmpty { "-" }} · ${e.optString("status")}" })
            if (e.optString("details").isNotEmpty()) card.addView(TextView(this).apply { text = e.optString("details") })
            if (e.optString("log").isNotEmpty()) card.addView(TextView(this).apply { text = "✓ " + e.optString("log"); textSize = 12f; setTextColor(Color.parseColor("#1A7F4B")) })
            val br = LinearLayout(this).also { card.addView(it) }
            val id = e.optString("id")
            if (review) {
                button("Approve & send", br) { store.saveEntry(JSONObject().put("id", id).put("status", "approved")); changed(); show(tab) }
                button("Edit", br) { editingId = id; show("New") }
            } else {
                if (e.optString("status") != "done") button("Done", br) { store.saveEntry(JSONObject().put("id", id).put("status", "done")); changed(); show(tab) }
                e.optString("faculty").split(",").mapNotNull { fac[it] }.forEach { f ->
                    button("WhatsApp ${f.optString("initials")}", br) { whatsapp(e, f) }
                }
            }
            button("Delete", br) {
                AlertDialog.Builder(this).setMessage("Delete this entry?").setPositiveButton("Delete") { _, _ ->
                    store.saveEntry(JSONObject().put("id", id).put("deleted", "true")); changed(); show(tab) }.setNegativeButton("Cancel", null).show()
            }
        }
    }

    private fun whatsapp(e: JSONObject, f: JSONObject) {
        var p = f.optString("phone").filter { it.isDigit() }; if (p.length == 10) p = "91$p"
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=" + Uri.encode(Store.message(e, f)))))
    }

    // ---------------------------------------------------------------- faculty admin
    private fun facultyPage(edit: JSONObject? = null) {
        label(if (edit == null) "Add faculty" else "Edit faculty")
        val name = field("Full name", edit?.optString("name") ?: "")
        val ini = field("Initials (e.g. RK)", edit?.optString("initials") ?: "", type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        val phone = field("Phone", edit?.optString("phone") ?: "", type = InputType.TYPE_CLASS_PHONE)
        val email = field("Email", edit?.optString("email") ?: "", type = InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or InputType.TYPE_CLASS_TEXT)
        val br = row()
        button("Save", br) {
            val i = ini.text.toString().trim().uppercase()
            if (name.text.isBlank() || i.isEmpty() || email.text.isBlank()) return@button toast("Name, initials and email are required")
            if (store.faculty().any { it.optString("initials") == i && it.optString("id") != edit?.optString("id") }) return@button toast("Initials already used")
            store.saveFaculty(JSONObject().put("id", edit?.optString("id") ?: "").put("name", name.text.toString().trim()).put("initials", i)
                .put("phone", phone.text.toString().trim()).put("email", email.text.toString().trim()))
            changed(); content.removeAllViews(); facultyPage()
        }
        if (edit != null) {
            button("Delete", br) { store.saveFaculty(JSONObject(edit.toString()).put("deleted", "true")); changed(); content.removeAllViews(); facultyPage() }
            button("Cancel", br) { content.removeAllViews(); facultyPage() }
        }
        label("Faculty (tap to edit)")
        store.faculty().forEach { f ->
            content.addView(TextView(this).apply {
                text = "${f.optString("initials")} · ${f.optString("name")}\n${f.optString("phone")} · ${f.optString("email")}"
                setPadding(0, 14, 0, 14); setOnClickListener { content.removeAllViews(); facultyPage(f) }
            })
        }
    }

    // ---------------------------------------------------------------- settings
    private fun settingsPage() {
        label("Apps Script Web App URL")
        val url = field("https://script.google.com/macros/s/…/exec", store.setting("url"), type = InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_CLASS_TEXT)
        label("Token (from the Apps Script log after setup)")
        val token = field("token", store.setting("token"))
        button("Save & sync") {
            store.setSetting("url", url.text.toString().trim()); store.setSetting("token", token.text.toString().trim())
            store.setSetting("since", "0"); changed(); toast("Saved — syncing")
        }
        label("Entries waiting to upload: ${store.pending()}")
        if (Build.VERSION.SDK_INT >= 31) button("Allow exact reminder alarms") {
            startActivity(Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
        }
        content.addView(View(this), LinearLayout.LayoutParams(1, 40))
    }
}
