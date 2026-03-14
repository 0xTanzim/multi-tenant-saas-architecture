> **Portfolio Note:** Extracted from production system, sanitized for portfolio use.

---

# Mobile Development Guide — Capacitor Android Development

> Complete guide for building, testing, and developing the native Android app using Capacitor 8.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Development Setup](#3-development-setup)
4. [Running on Your Android Device](#4-running-on-your-android-device)
5. [Live Reload (Hot Reload on Device)](#5-live-reload-hot-reload-on-device)
6. [Using Android Studio](#6-using-android-studio)
7. [Firebase & Push Notifications](#7-firebase--push-notifications)
8. [Deep Linking](#8-deep-linking)
9. [Building APK / AAB for Distribution](#9-building-apk--aab-for-distribution)
10. [Debugging](#10-debugging)
11. [Common Issues & Troubleshooting](#11-common-issues--troubleshooting)
12. [Project Structure Reference](#12-project-structure-reference)
13. [Commands Cheat Sheet](#13-commands-cheat-sheet)

---

## 1. Architecture Overview

The platform uses **Remote URL Mode** — the native app is a thin WebView shell that loads the web app from a server URL.

```
┌──────────────────────────────────────┐
│          Android Device              │
│  ┌────────────────────────────────┐  │
│  │  Capacitor Native Shell        │  │
│  │  (StatusBar, SplashScreen,     │  │
│  │   Push, Deep Links, Keyboard)  │  │
│  │  ┌──────────────────────────┐  │  │
│  │  │  Android WebView         │  │  │
│  │  │  ┌────────────────────┐  │  │  │
│  │  │  │  Next.js App       │  │  │  │
│  │  │  │  (loaded from URL) │  │  │  │
│  │  │  │  + Serwist SW      │  │  │  │
│  │  │  └────────────────────┘  │  │  │
│  │  └──────────────────────────┘  │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
         │
         │ HTTP/HTTPS
         ▼
┌──────────────────────────────────────┐
│  Your Dev Machine / Server           │
│  ┌──────────────┐  ┌──────────────┐  │
│  │ Next.js :3001 │  │ NestJS :8444 │  │
│  └──────────────┘  └──────────────┘  │
└──────────────────────────────────────┘
```

**What this means:**

- The app loads `http://<your-ip>:3001` in development
- All Server Components, server actions, and API proxy work unchanged
- Native plugins (push notifications, status bar, splash screen) are available via JavaScript bridge
- Serwist service worker provides offline caching inside the WebView
- You do NOT need to run `next build` or `next export` — the app loads live from the dev server

---

## 2. Prerequisites

### Required Software

| Tool               | Version           | Purpose                    | Install                                                              |
| ------------------ | ----------------- | -------------------------- | -------------------------------------------------------------------- |
| **Android Studio** | Latest (Ladybug+) | Build tools, emulator, SDK | [developer.android.com/studio](https://developer.android.com/studio) |
| **JDK**            | 17+               | Android build system       | Bundled with Android Studio                                          |
| **Node.js**        | 20+               | Frontend/Backend           | Already installed                                                    |
| **pnpm**           | 9+                | Package manager            | Already installed                                                    |
| **adb**            | Latest            | USB debugging              | Bundled with Android Studio                                          |

### Install Android Studio

1. Download from [developer.android.com/studio](https://developer.android.com/studio)
2. Install and open Android Studio
3. Go to **Settings → Languages & Frameworks → Android SDK**
4. Under **SDK Platforms** tab, check:
   - **Android 15.0 (VanillaIceCream)** — API 36 (matches our `compileSdkVersion`)
   - **Android 14.0 (UpsideDownCake)** — API 34 (good for testing)
5. Under **SDK Tools** tab, check:
   - **Android SDK Build-Tools** (latest)
   - **Android SDK Command-line Tools**
   - **Android SDK Platform-Tools** (includes `adb`)
   - **Android Emulator** (optional — for emulator testing)
6. Click **Apply** and let it download

### Set Environment Variables

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/tools
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
```

Then reload:

```bash
source ~/.bashrc  # or source ~/.zshrc
```

Verify:

```bash
adb --version
# Should show: Android Debug Bridge version 1.0.41 (or higher)
```

---

## 3. Development Setup

### Step 1: Make Sure Servers Are Running

The Android app loads from your local dev server, so both servers must be running:

```bash
# Terminal 1 — Backend (port 8444)
pnpm --filter @app/api start:dev

# Terminal 2 — Frontend (port 3001)
pnpm --filter web dev
```

Verify they're up:

```bash
curl http://localhost:8444/health   # Should return 200
curl http://localhost:3001           # Should return HTML
```

### Step 2: Find Your Computer's IP Address

Your phone needs to connect to your computer over the local network.

```bash
# Linux
hostname -I | awk '{print $1}'

# macOS
ipconfig getifaddr en0
```

Example output: `192.168.1.105`

> **Important:** Your phone and computer MUST be on the same WiFi network.

### Step 3: Set the Capacitor Server URL

The app needs to know where your dev server is. Set the environment variable:

```bash
export CAPACITOR_LIVE_RELOAD_URL=http://192.168.1.105:3001
```

> Replace `192.168.1.105` with YOUR actual IP from Step 2.
> Do not use `localhost` on a physical device.

### Step 4: Sync Capacitor

After any web code or config change, sync to the native project:

```bash
cd apps/web
pnpm cap:sync
```

This copies:

- `capacitor.config.ts` → native project configuration
- Web assets → `android/app/src/main/assets/public/` (fallback only)
- Plugin configurations → native plugin wiring

---

## 4. Running on Your Android Device

### Step 1: Enable Developer Mode on Your Phone

1. Go to **Settings → About Phone**
2. Tap **Build Number** 7 times rapidly
3. You'll see "You are now a developer!"
4. Go back to **Settings → System → Developer Options**
5. Enable **USB Debugging**
6. (Optional) Enable **Stay Awake** — screen stays on while charging

### Step 2: Connect Your Phone via USB

1. Plug your phone into your computer with a USB cable
2. On your phone, a popup will ask: **"Allow USB debugging?"**
3. Tap **"Always allow from this computer"** → **OK**

### Step 3: Verify Connection

```bash
adb devices
```

Expected output:

```
List of devices attached
XXXXXXXXXX    device
```

If it shows `unauthorized`:

- Check your phone — approve the USB debugging prompt
- Run `adb devices` again

If it shows nothing:

- Try a different USB cable (data cables, not charge-only)
- Try a different USB port
- Check Developer Options is enabled

### Step 4: Run the App on Your Device

Make sure `CAPACITOR_LIVE_RELOAD_URL` is set to your computer's IP (not localhost), then:

```bash
cd apps/web

# Sync latest config
pnpm cap:sync

# Run on connected device
pnpm cap:run:android
```

This will:

1. Build the Android APK
2. Install it on your connected device
3. Launch the app

**First build takes 3-5 minutes.** Subsequent builds are much faster.

### What You'll See

1. **Splash screen** — Platform-themed coral background for 2 seconds
2. **Status bar** — Themed coral (#E07B54) with light text
3. **Your web app** — Loaded inside the native shell from your dev server

---

## 5. Live Reload (Hot Reload on Device)

Since we use Remote URL mode, **live reload works automatically!**

1. The app loads from `http://<your-ip>:3001`
2. Next.js Turbopack dev server handles hot module replacement
3. When you edit a file → your phone updates instantly (same as browser)

**No need to rebuild the APK for web changes!**

You only need to re-run `cap:sync` + `cap:run:android` when you:

- Change `capacitor.config.ts`
- Change `AndroidManifest.xml`
- Add/remove a Capacitor plugin
- Change native Java/Kotlin code

---

## 6. Using Android Studio

For more control over builds and debugging:

### Open in Android Studio

```bash
cd apps/web
pnpm cap:open:android
```

This opens the `apps/web/android` project in Android Studio.

### Run from Android Studio

1. Wait for Gradle sync to complete (bottom progress bar)
2. Select your device from the device dropdown (top toolbar)
3. Click the green **Run ▶** button (or `Shift+F10`)

### Why Use Android Studio?

- **Logcat** — See all app logs in real-time (filter by `Capacitor` or platform-branded logs)
- **Layout Inspector** — Debug WebView rendering
- **Profiler** — CPU, memory, network monitoring
- **APK Analyzer** — Check APK size and contents
- **Gradle management** — Build variants, dependencies

---

## 7. Firebase & Push Notifications

### Current Status: ✅ Already Configured

Firebase Cloud Messaging (FCM) is already set up:

| File                               | Status                                             |
| ---------------------------------- | -------------------------------------------------- |
| `android/app/google-services.json` | ✅ Present — Firebase project configured           |
| `android/build.gradle`             | ✅ Has `com.google.gms:google-services:4.4.4`      |
| `android/app/build.gradle`         | ✅ Applies `com.google.gms.google-services` plugin |
| `AndroidManifest.xml`              | ✅ Has `POST_NOTIFICATIONS` permission             |
| `capacitor-bridge.tsx`             | ✅ Auto-registers for push on native               |
| `use-native-push.ts`               | ✅ Handles FCM token → backend                     |
| Backend DTO                        | ✅ Accepts native `deviceToken`                    |

### Testing Push Notifications

1. **Run the app** on your device
2. **Log in** as any user
3. The app will automatically:
   - Request notification permission (Android 13+ shows a system dialog)
   - Get an FCM token from Firebase
   - Send it to the backend via `POST /push-subscriptions`
4. **Verify in backend logs** — look for the push subscription being created with `platform: 'android'`

### Sending a Test Push (Firebase Console)

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Navigate to your project, then **Messaging** → **New Campaign** → **Notifications**
3. Enter a title and body
4. Click **Send test message**
5. Enter the FCM token from your backend logs
6. Send — your phone should receive the notification

### Sending via Backend

The backend already supports sending push notifications. Any event that triggers a notification (booking confirmed, new message, etc.) will send to native devices automatically — the `firebase-admin` SDK handles FCM delivery.

---

## 8. Deep Linking

Deep links allow external URLs to open inside the app with a custom scheme.

### Configured Scheme

The `AndroidManifest.xml` has this intent-filter:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="platform" />
</intent-filter>
```

### Testing Deep Links

With the app installed on your device:

```bash
# Open a deep link via adb
adb shell am start -W -a android.intent.action.VIEW -d "platform://bookings" com.platform.app
```

The `capacitor-bridge.tsx` handles the `appUrlOpen` event and routes the URL to the correct page inside the app.

---

## 9. Building APK / AAB for Distribution

### Debug APK (for testing)

```bash
cd apps/web/android

# Build debug APK
./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

Install on a device:

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

### Release AAB (for Google Play Store)

```bash
cd apps/web/android

# Build release bundle (requires signing key)
./gradlew bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

> **Note:** Release builds require a signing keystore. See [Android Signing Guide](https://developer.android.com/studio/publish/app-signing) for setup.

### Setting Up a Signing Key (for Release)

```bash
# Generate a keystore (do this ONCE, save the keystore file securely)
keytool -genkey -v -keystore platform-release.keystore \
  -alias platform -keyalg RSA -keysize 2048 -validity 10000

# Move to a safe location
mv platform-release.keystore ~/keystores/
```

Add to `android/app/build.gradle`:

```gradle
android {
    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_PATH") ?: "platform-release.keystore")
            storePassword System.getenv("KEYSTORE_PASSWORD") ?: ""
            keyAlias System.getenv("KEY_ALIAS") ?: "platform"
            keyPassword System.getenv("KEY_PASSWORD") ?: ""
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

---

## 10. Debugging

### Chrome Remote Debugging (WebView)

This is the most powerful debugging tool — inspect your app's WebView like a regular Chrome tab:

1. Run the app on your device (must be a **debug** build)
2. Open Chrome on your computer
3. Navigate to `chrome://inspect/#devices`
4. Your device and WebView will appear under **Remote Target**
5. Click **inspect** — opens full Chrome DevTools (Console, Network, Elements, etc.)

> This only works when `webContentsDebuggingEnabled: true` is set in `capacitor.config.ts` (it's automatically enabled when using `http://` server URL in development).

### Android Studio Logcat

1. Open Android Studio → **Logcat** tab (bottom panel)
2. Filter by tag: `Capacitor` to see Capacitor-specific logs
3. Filter by package: `com.platform.app` to see only your app's logs

Common log tags:

- `Capacitor` — Plugin bridge communication
- `Capacitor/Plugin` — Plugin-specific logs
- `chromium` — WebView rendering logs
- `Firebase` — FCM token registration and message delivery

### ADB Logcat (Terminal)

```bash
# All logs from your app
adb logcat --pid=$(adb shell pidof -s com.platform.app)

# Filter for Capacitor logs
adb logcat -s Capacitor:V

# Filter for Firebase/FCM logs
adb logcat -s Firebase:V FirebaseMessaging:V
```

---

## 11. Common Issues & Troubleshooting

### "App shows blank white screen"

**Cause:** App can't reach your dev server.

**Fix:**

1. Check both servers are running (backend :8444, frontend :3001)
2. Verify `CAPACITOR_LIVE_RELOAD_URL` is set to your **computer's IP** (not `localhost`)
3. Phone and computer must be on the **same WiFi network**
4. Check your computer's firewall isn't blocking port 3001
5. Test from phone browser: open `http://<your-ip>:3001` — should load the web app

```bash
# Disable firewall temporarily (Linux)
sudo ufw allow 3001
sudo ufw allow 8444
```

### "Gradle sync failed" in Android Studio

**Fix:**

1. File → Invalidate Caches → Invalidate and Restart
2. If still failing:
   ```bash
   cd apps/web/android
   rm -rf .gradle build app/build
   ./gradlew clean
   ```

### "adb: device not found" or "no devices"

**Fix:**

1. Check Developer Options is enabled on your phone
2. Check USB cable is a **data cable** (not charge-only)
3. Try a different USB port on your computer
4. On your phone, revoke USB debugging permission (Settings → Developer Options → Revoke USB debugging authorizations)
5. Unplug and replug the cable — approval dialog should reappear
6. Run `adb devices` again

### "app installed but not launching"

**Fix:**

1. Check `pnpm cap:sync` completed without errors
2. Verify `CAPACITOR_LIVE_RELOAD_URL` env var is set
3. Run the app manually:
   ```bash
   adb shell am start -n com.platform.app/com.platform.app.MainActivity
   ```
4. Check Logcat for errors

### "Push notifications not working"

**Fix:**

1. Check Firebase credentials are valid in `android/app/google-services.json`
2. Verify `POST_NOTIFICATIONS` permission is in `AndroidManifest.xml`
3. On Android 13+, app must request notification permission — user must approve the system dialog
4. Check backend logs — notification subscription should show `platform: 'android'`
5. Test via Firebase Console → Messaging (see section 7)

---

## 12. Project Structure Reference

```
apps/web/
├── android/                              # Capacitor Android project
│   ├── app/
│   │   ├── build.gradle                  # App-level Gradle config
│   │   ├── google-services.json          # Firebase config
│   │   └── src/main/
│   │       ├── AndroidManifest.xml       # App manifest, permissions, intent filters
│   │       ├── java/com/platform/app/
│   │       │   └── MainActivity.kt       # Main activity (Capacitor entry point)
│   │       └── res/
│   │           ├── drawable/             # App icons, splash screens
│   │           └── values/               # Colors, strings
│   ├── build.gradle                      # Project-level Gradle config
│   └── gradle/
│       └── wrapper/gradle-wrapper.jar    # Gradle wrapper
├── capacitor.config.ts                   # Capacitor configuration
├── app.config.ts                         # Expo/Capacitor app config
└── pnpm-workspace.yaml                   # Workspace config
```

---

## 13. Commands Cheat Sheet

```bash
# Setup
pnpm install
cd apps/web
pnpm cap:init:android              # First-time Android setup

# Development
export CAPACITOR_LIVE_RELOAD_URL=http://<your-ip>:3001
pnpm --filter web dev              # Frontend dev server
pnpm --filter @app/api start:dev   # Backend dev server
pnpm cap:sync                       # Sync web assets to native
pnpm cap:run:android               # Build APK & run on device
pnpm cap:open:android              # Open in Android Studio

# Android Studio
pnpm cap:open:android              # Open project
# In Android Studio: Shift+F10 to run

# Debugging
chrome://inspect/#devices          # Chrome DevTools for WebView
adb devices                         # List connected devices
adb logcat -s Capacitor:V          # View Capacitor logs
adb shell am start -n com.platform.app/com.platform.app.MainActivity

# Building
cd apps/web/android
./gradlew assembleDebug             # Build debug APK
./gradlew bundleRelease             # Build release AAB

# Troubleshooting
adb devices                         # Check device connection
adb kill-server && adb start-server # Restart adb daemon
rm -rf .gradle build app/build      # Clear Gradle cache
```

---

**This guide covers the complete development workflow for building and testing the platform's Android app using Capacitor.**
