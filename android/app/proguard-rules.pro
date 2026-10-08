# R8 규칙(release: minifyEnabled/shrinkResources). 기본은 AGP의 proguard-android-optimize.txt + 각 라이브러리가 싣고 오는 consumer 규칙이다.
# 여기에는 "그것만으로 부족한 것"만 좁게 추가한다 — 광범위한 `-keep class **` 류는 난독화/축소를 무력화하므로 넣지 않는다.
#
# 이미 보장되는 것(이 파일에서 따로 지키지 않는다):
#  - Capacitor: @CapacitorPlugin 클래스와 `extends com.getcapacitor.Plugin` 전체(앱의 GoogleSignIn/CalendarEvent/AppSettings/AndroidStatusBarBackground 플러그인 포함)와
#    @PluginMethod 메서드 — node_modules/@capacitor/android/capacitor/proguard-rules.pro (consumerProguardFiles)
#  - 매니페스트에 선언된 컴포넌트(MainActivity, MwhabitMessagingService, FileProvider) — AGP가 자동 keep
#  - Firebase Messaging, androidx.credentials / credentials-play-services-auth / googleid — 각 AAR의 consumer 규칙

# 크래시 스택트레이스 복원(Play Console은 AAB에 포함된 mapping.txt로 deobfuscate): 줄 번호는 남기고 원본 파일명만 숨긴다.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
