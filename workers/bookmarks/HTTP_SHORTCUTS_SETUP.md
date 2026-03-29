# Android HTTP Shortcuts Setup

Save bookmarks from your Android phone's share sheet using the [HTTP Shortcuts](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts) app.

## Setup

1. Install **HTTP Shortcuts** from Play Store
2. Open the app, tap **+** to create a new shortcut
3. Configure:

| Field | Value |
|-------|-------|
| Name | Save Bookmark |
| Method | POST |
| URL | `https://bookmarks.leanwf1117.workers.dev/bookmarks` |

4. Under **Request Headers**, add:

| Header | Value |
|--------|-------|
| Content-Type | `application/json` |
| Authorization | `Bearer <your-api-key>` |

5. Under **Request Body**, select JSON and enter:

```json
{
  "url": "{url}"
}
```

> `{url}` is a built-in variable that HTTP Shortcuts populates from the shared URL.

6. Under **Trigger & Shortcuts**, enable **Show in Share Sheet**

## Usage

1. Open any URL in your browser (Chrome, Firefox, etc.)
2. Tap **Share**
3. Select **HTTP Shortcuts** > **Save Bookmark**
4. The shortcut sends the URL to your Worker, which auto-fetches the title and saves it

## Verification

After sharing a URL, verify it was saved:

```bash
blogctl list
```

Or check the live page at https://jeffrey-lean.com/bookmarks/
