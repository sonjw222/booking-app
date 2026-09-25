package com.mwhabit.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.CalendarContract;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * "캘린더에 추가"(2026-09-26) — Android 표준 인텐트 방식. 앱이 캘린더 DB에 직접 쓰지 않고
 * READ/WRITE_CALENDAR 권한도 필요 없다(AndroidManifest.xml에는 이미 있는 FileProvider만 사용).
 * JS 쪽은 lib/calendarAdd.ts(jsName "CalendarEvent").
 *
 * addEvent(1건): CalendarContract ACTION_INSERT — 제목/시작/종료(또는 하루 종일)/위치/메모를 미리 채운
 *   시스템 캘린더 앱의 일정 추가 화면. chooser=true("다른 캘린더 앱 선택")면 Intent.createChooser로 감싸
 *   설치된 지원 앱(Google/Samsung/Outlook 등)을 시스템 chooser로 보여준다 — 앱 이름 하드코딩 없음.
 * openIcs(여러 건): 여러 VEVENT가 든 .ics를 FileProvider(cache)로 ACTION_VIEW(text/calendar). 시스템
 *   인텐트 INSERT는 한 번에 하나만 받기 때문. chooser=true면 createChooser.
 * Android는 결과(저장/취소)를 앱으로 돌려주지 않아 resolve는 "화면을 열었음"만 의미한다.
 */
@CapacitorPlugin(name = "CalendarEvent")
public class CalendarEventPlugin extends Plugin {

    @PluginMethod
    public void addEvent(PluginCall call) {
        String title = call.getString("title");
        Double startMs = call.getDouble("startMs");
        Double endMs = call.getDouble("endMs");
        if (title == null || startMs == null || endMs == null) {
            call.reject("title/startMs/endMs가 필요해요", "INVALID");
            return;
        }
        Boolean chooser = call.getBoolean("chooser", false);
        Boolean allDay = call.getBoolean("allDay", false);

        Intent insert = new Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, title)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs.longValue())
            // 하루 종일: endMs는 마지막 날의 다음 날 UTC 자정(DTEND exclusive) — JS(toNativePayload)가 계산.
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMs.longValue());
        if (Boolean.TRUE.equals(allDay)) insert.putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true);
        String location = call.getString("location");
        if (location != null && !location.isEmpty()) insert.putExtra(CalendarContract.Events.EVENT_LOCATION, location);
        String notes = call.getString("notes");
        if (notes != null && !notes.isEmpty()) insert.putExtra(CalendarContract.Events.DESCRIPTION, notes);

        launch(call, insert, Boolean.TRUE.equals(chooser));
    }

    @PluginMethod
    public void openIcs(PluginCall call) {
        String ics = call.getString("ics");
        String filename = call.getString("filename");
        if (ics == null || filename == null) {
            call.reject("ics/filename이 필요해요", "INVALID");
            return;
        }
        Boolean chooser = call.getBoolean("chooser", false);
        Context ctx = getContext();
        try {
            File dir = new File(ctx.getCacheDir(), "calendar");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("임시 파일을 만들 수 없어요", "IO");
                return;
            }
            // 경로 구분자 제거 + .ics 보장
            String safe = filename.replaceAll("[\\\\/:*?\"<>|]", "-");
            if (!safe.toLowerCase().endsWith(".ics")) safe = safe + ".ics";
            File file = new File(dir, safe);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(ics.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "text/calendar")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            view.setClipData(ClipData.newRawUri("calendar", uri));
            launch(call, view, Boolean.TRUE.equals(chooser));
        } catch (Exception e) {
            call.reject("캘린더 파일을 열 수 없어요", "IO");
        }
    }

    private void launch(PluginCall call, Intent intent, boolean chooser) {
        Intent launch = chooser ? Intent.createChooser(intent, "캘린더 앱 선택") : intent;
        if (chooser) launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(launch);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("일정을 추가할 수 있는 캘린더 앱이 없어요", "NO_CALENDAR_APP");
        }
    }
}
