package com.mwhabit.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.CalendarContract;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "캘린더에 추가"(2026-09-26) — Android 표준 일정 추가 인텐트(CalendarContract ACTION_INSERT).
 * 제목/시작/종료/위치/메모를 미리 채운 시스템 캘린더 앱의 일정 추가 화면을 띄운다 — 사용자가 그
 * 화면에서 저장을 눌러야 확정되므로 앱이 캘린더 DB에 직접 쓰지 않고, READ/WRITE_CALENDAR 권한도
 * 필요 없다(AndroidManifest.xml 변경 없음). JS 쪽은 lib/calendarAdd.ts(jsName "CalendarEvent").
 *
 * chooser=false: 기본 캘린더 — 기본 앱이 지정돼 있으면 바로 그 앱, 없으면 시스템이 앱 선택 창을 띄운다.
 * chooser=true : "다른 캘린더 앱 선택" — 같은 인텐트를 Intent.createChooser로 감싸 항상 시스템 chooser로
 *                설치된 지원 앱(Google/Samsung/Outlook 등)을 보여준다. 앱 이름을 하드코딩하지 않는다.
 * Android는 결과(저장/취소)를 앱으로 돌려주지 않으므로 resolve는 "화면을 열었음"만 의미한다.
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

        Intent insert = new Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, title)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, startMs.longValue())
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, endMs.longValue());
        String location = call.getString("location");
        if (location != null && !location.isEmpty()) insert.putExtra(CalendarContract.Events.EVENT_LOCATION, location);
        String notes = call.getString("notes");
        if (notes != null && !notes.isEmpty()) insert.putExtra(CalendarContract.Events.DESCRIPTION, notes);

        Intent launch = Boolean.TRUE.equals(chooser) ? Intent.createChooser(insert, "캘린더 앱 선택") : insert;
        try {
            getActivity().startActivity(launch);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("일정을 추가할 수 있는 캘린더 앱이 없어요", "NO_CALENDAR_APP");
        }
    }
}
