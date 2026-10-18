package `in`.kpriet.hodtasks

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Syncs with the Sheet whenever there is internet: every 15 min, and right after each change. */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = try {
        val s = Store.get(applicationContext)
        s.setSetting("status", s.sync())
        Reminders.scheduleAll(applicationContext)
        Result.success()
    } catch (e: Exception) {
        Reminders.scheduleAll(applicationContext)
        Result.retry()
    }

    companion object {
        private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        fun start(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(net).build())
        }
        fun now(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork("sync-now", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(net).build())
        }
    }
}

object Reminders {
    const val CHANNEL = "reminders"

    fun scheduleAll(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val store = Store.get(ctx)
        val shown = store.setting("shown").split(",").toSet()
        val now = System.currentTimeMillis()
        for (e in store.entries()) {
            val id = e.optString("id")
            val active = "reminder" in e.optString("actions") && e.optString("status") !in listOf("done", "cancelled")
            val at = store.setting("snooze_$id").toLongOrNull() ?: Store.reminderTime(e)
            val pi = pending(ctx, id, e.optString("title"), e.optString("details"))
            if (!active || at == null || id in shown) { am.cancel(pi); continue }
            val t = maxOf(at, now + 2000)
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
        }
    }

    fun pending(ctx: Context, id: String, title: String, details: String): PendingIntent {
        val i = Intent(ctx, ReminderReceiver::class.java).putExtra("id", id).putExtra("title", title).putExtra("details", details)
        return PendingIntent.getBroadcast(ctx, id.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun channel(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH))
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val store = Store.get(ctx)
        when (intent.action) {
            "DONE" -> { store.saveEntry(JSONObject().put("id", id).put("status", "done")); SyncWorker.now(ctx) }
            "SNOOZE" -> {
                store.setSetting("snooze_$id", (System.currentTimeMillis() + 10 * 60000).toString())
                store.setSetting("snooze_$id", "")
                store.setSetting("shown", store.setting("shown").split(",").filter { it != id }.joinToString(","))
                Reminders.scheduleAll(ctx)
            }
            else -> {
                val e = store.entry(id)
                if (e != null && e.optString("status") in listOf("done", "cancelled")) return
                store.setSetting("snooze_$id", "")
                store.setSetting("shown", (store.setting("shown").split(",") + id).filter { it.isNotEmpty() }.distinct().joinToString(","))
                Reminders.channel(ctx)
                fun act(a: String, code: Int) = PendingIntent.getBroadcast(ctx, id.hashCode() + code,
                    Intent(intent).setAction(a), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
                val n = NotificationCompat.Builder(ctx, Reminders.CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentTitle("⏰ " + intent.getStringExtra("title"))
                    .setContentText(intent.getStringExtra("details"))
                    .setStyle(NotificationCompat.BigTextStyle().bigText(intent.getStringExtra("details")))
                    .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setDefaults(NotificationCompat.DEFAULT_ALL).setAutoCancel(true).setContentIntent(open)
                    .addAction(0, "Done", act("DONE", 1)).addAction(0, "Snooze 10 min", act("SNOOZE", 2))
                    .build()
                try { NotificationManagerCompat.from(ctx).notify(id.hashCode(), n) } catch (_: SecurityException) { }
            }
        }
        if (intent.action != null) NotificationManagerCompat.from(ctx).cancel(id.hashCode())
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Reminders.scheduleAll(ctx); SyncWorker.start(ctx)
    }
}
