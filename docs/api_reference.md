# Mini Tracker Backend API Reference

**Base URL**: `http://localhost:8000` (or `PORT` environment variable, default `8080`)  
**Authentication**: JWT Token passed via `Authorization: Bearer <token>` header or `mini_session_jwt` HTTP-only cookie.  
**Content-Type**: `application/json` (unless fetching binary image or static assets).

---

## 📌 Summary Table

| Category | Method | Endpoint | Auth Required | Description |
|---|---|---|---|---|
| **Tracker Core** | `GET` | `/api/tracker/status` | No | Get tracker running status and accumulated elapsed time |
| | `POST` | `/api/tracker/toggle` | No | Start or pause desktop activity tracking |
| | `POST` | `/api/tracker/input` | No | Record user keystroke & mouse activity from client |
| **System & AI Config** | `GET` | `/api/config` | No | Retrieve app configuration (data dir, screenshot interval) |
| | `GET` | `/api/ai/models` | No | List supported Gemini & Gemma vision/analysis models |
| | `POST` | `/api/ai/analyze-batch` | Yes | Request server-side AI analysis for a batch of log IDs |
| | `POST` | `/api/ai/log-result` | Yes | Persist manual or client-side AI analysis result |
| | `POST` | `/api/ai/test` | Yes | Test Gemini API key & model connectivity |
| **Telemetry & Sync** | `POST` | `/api/telemetry/push` | Yes | Push client logs & input stats to backend |
| | `GET` | `/api/telemetry/pull` | Yes | Pull organization logs and team analytics |
| **Analytics & Data** | `GET` | `/api/stats` | Yes | Get aggregated productivity stats for date/range |
| | `GET` | `/api/logs` | Yes | Retrieve paginated activity logs with optional filtering |
| | `GET` | `/api/work-sessions`| Yes | Get discrete work sessions and active intervals |
| | `GET` | `/api/app-icon` | No | Fetch cached application icon (`?name=<app>`) |
| | `GET` | `/api/image` | Yes | Fetch full-resolution screenshot image (`?path=<abs_path>`) |
| **Organization & Users** | `POST` | `/api/org/register` | No | Register a new organization and admin account |
| | `POST` | `/api/auth/login` | No | Login with email and password to receive JWT |
| | `POST` | `/api/auth/logout` | No | Invalidate session cookie |
| | `GET` | `/api/auth/me` | Yes | Get current authenticated user profile and org details |
| | `GET` | `/api/org/members` | Yes | List organization members and pending invitations |
| | `POST` | `/api/org/invite` | Yes (Admin) | Send invitation to a new teammate |
| | `GET` | `/api/org/invite-info`| No | Get invitation metadata by token (`?token=<tok>`) |
| | `POST` | `/api/org/accept-invite`| No | Accept team invitation and set user password |
| | `GET` | `/api/org/usage` | Yes (Admin) | Get organization AI token & API usage summary |
| | `POST` | `/api/org/usage/reset` | Yes (Admin) | Reset organization monthly AI usage counts |
| | `GET` | `/api/user/usage` | Yes | Get personal AI token and analysis usage |
| | `POST` | `/api/org/settings` | Yes (Admin) | Save organization-level Gemini API key & default model |
| | `POST` | `/api/user/settings`| Yes | Save personal user Gemini API key |

---

## 1. Tracker Endpoints

### `GET /api/tracker/status`
Returns current tracking state and elapsed duration for the current day.
- **Request**: `GET http://localhost:8000/api/tracker/status`
- **Response `200 OK`**:
```json
{
  "active": true,
  "elapsed_seconds": 7925
}
```

### `POST /api/tracker/toggle`
Toggles active tracking between running and paused.
- **Request**: `POST http://localhost:8000/api/tracker/toggle`
- **Response `200 OK`**:
```json
{
  "active": false,
  "elapsed_seconds": 7994
}
```

### `POST /api/tracker/input`
Allows the desktop webview or client agent to report keyboard and mouse metrics.
- **Request**: `POST http://localhost:8000/api/tracker/input`
```json
{
  "total_keys": 10,
  "unique_keys": 6,
  "total_clicks": 3,
  "mouse_distance": 220
}
```
- **Response `200 OK`**:
```json
{
  "success": true
}
```

---

## 2. Authentication & Organization

### `POST /api/org/register`
Creates a new organization and initializes the owner account.
- **Request**: `POST http://localhost:8000/api/org/register`
```json
{
  "name": "Acme Inc",
  "full_name": "John Doe",
  "email": "john@acme.com",
  "password": "SecurePassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "user": {
    "id": 1,
    "email": "john@acme.com",
    "name": "John Doe",
    "role": "owner",
    "org_id": 1
  },
  "organization": {
    "id": 1,
    "name": "Acme Inc",
    "slug": "acme-inc"
  },
  "token": "eyJhbGciOiJIUzI1NiIsIn..."
}
```

### `POST /api/auth/login`
Authenticates a user and issues a signed JWT token and session cookie.
- **Request**: `POST http://localhost:8000/api/auth/login`
```json
{
  "email": "john@acme.com",
  "password": "SecurePassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "user": {
    "id": 1,
    "email": "john@acme.com",
    "role": "owner",
    "org_id": 1
  },
  "token": "eyJhbGciOiJIUzI1NiIsIn..."
}
```

### `GET /api/auth/me`
Retrieves authenticated user details.
- **Headers**: `Authorization: Bearer <token>`
- **Response `200 OK`**:
```json
{
  "user": {
    "id": 1,
    "email": "john@acme.com",
    "name": "John Doe",
    "role": "owner",
    "org_id": 1
  },
  "organization": {
    "id": 1,
    "name": "Acme Inc"
  }
}
```

---

## 3. Team & Invitations

### `POST /api/org/invite`
Invites a new member to the organization (Admin/Owner only).
- **Request**: `POST http://localhost:8000/api/org/invite`
```json
{
  "email": "sarah@acme.com",
  "role": "member"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "invitation_token": "893662e03b1bfb724ab3f26812c725d2"
}
```

### `GET /api/org/invite-info?token=<token>`
Fetches invitation details prior to accepting.
- **Response `200 OK`**:
```json
{
  "email": "sarah@acme.com",
  "org_name": "Acme Inc",
  "role": "member"
}
```

### `POST /api/org/accept-invite`
Accepts invitation and sets user password.
- **Request**: `POST http://localhost:8000/api/org/accept-invite`
```json
{
  "token": "893662e03b1bfb724ab3f26812c725d2",
  "name": "Sarah Connor",
  "password": "NewSecurePassword123!"
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "user": {
    "id": 2,
    "email": "sarah@acme.com",
    "role": "member",
    "org_id": 1
  },
  "token": "eyJhbGciOiJIUzI1NiIsIn..."
}
```

---

## 4. Analytics & Logs

### `GET /api/stats`
Fetches aggregate productivity statistics.
- **Parameters**: `date=YYYY-MM-DD` (optional, defaults to today)
- **Response `200 OK`**:
```json
{
  "date": "2026-11-15",
  "total_minutes": 117,
  "productive_minutes": 115,
  "unproductive_minutes": 2,
  "avg_entropy_score": 0.88,
  "top_category": "Coding"
}
```

### `GET /api/logs`
Fetches paginated logs.
- **Parameters**:
  - `date`: `YYYY-MM-DD`
  - `page`: default `1`
  - `page_size`: default `50`
- **Response `200 OK`**:
```json
{
  "logs": [
    {
      "id": 105,
      "timestamp": "2026-11-15T12:00:00Z",
      "app_name": "Code",
      "window_title": "MiniTracker — main.go",
      "is_productive": true,
      "ai_category": "Coding",
      "productive_score": 95
    }
  ],
  "page": 1,
  "page_size": 50,
  "total": 1
}
```

---

## 5. Telemetry & Sync

### `POST /api/telemetry/push`
Pushes desktop activity batches to server database.
- **Request**:
```json
{
  "logs": [
    {
      "timestamp": "2026-11-15T12:00:00Z",
      "app_name": "vscode",
      "window_title": "main.go - MiniTracker",
      "total_keys": 42,
      "unique_keys": 12,
      "total_clicks": 5,
      "mouse_distance": 250,
      "entropy_score": 0.85
    }
  ]
}
```
- **Response `200 OK`**:
```json
{
  "success": true,
  "synced_count": 1
}
```

### `GET /api/telemetry/pull?days=1`
Pulls server changes and logs back to desktop client.
- **Response `200 OK`**:
```json
{
  "success": true,
  "logs": [...]
}
```
