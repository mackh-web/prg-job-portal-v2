"""PRG Job Portal — FastAPI backend (Supabase edition).

Migrated from MongoDB + custom JWT auth to:
- Supabase Auth (auth.users) for authentication
- Postgres (via asyncpg) for all application data
- profiles table (1:1 with auth.users) holds name/roles/department/status/theme

Business logic (permissions, workflows, prep bay conflicts, dual-approval
Ideal Prep, fault lifecycle, notifications, audit log) is preserved from the
original Mongo implementation as closely as possible.
"""

from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import json
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta, date
from typing import List, Optional, Any, Dict

import asyncpg
import httpx
import jwt
from jwt import PyJWKClient, PyJWKClientError
import resend
from types import SimpleNamespace
from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, Query, status, UploadFile, File
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator
from pywebpush import webpush, WebPushException

# ---------------------------------------------------------------------------
# Config / Setup
# ---------------------------------------------------------------------------
DATABASE_URL = os.environ["DATABASE_URL"]                      # Supabase Postgres connection string
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]         # Settings -> API Keys -> Secret keys (replaces service_role)
SUPABASE_JWKS_URL = os.environ["SUPABASE_JWKS_URL"]             # Settings -> API -> JWT Keys -> JWKS URL (asymmetric signing)

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM = os.environ.get("RESEND_FROM_EMAIL", "PRG Portal <onboarding@resend.dev>")

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT") or "mailto:admin@prg.com"
if not VAPID_SUBJECT.startswith(("mailto:", "https:")):
    VAPID_SUBJECT = f"mailto:{VAPID_SUBJECT}"

if RESEND_API_KEY and not RESEND_API_KEY.endswith("PLACEHOLDER_REPLACE_ME"):
    resend.api_key = RESEND_API_KEY
    RESEND_ENABLED = True
else:
    RESEND_ENABLED = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
logger = logging.getLogger("prg")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ROLES = ["Crew Member", "Project Manager", "Account Manager",
         "Operations Manager", "Service Department", "Administrator"]
DEPARTMENTS = ["Lighting", "Video", "Rigging", "Automation", "Audio"]
# Departments eligible for per-bay booking assignment (matches the Crew Chief department set)
BAY_DEPARTMENTS = ["Lighting", "Video", "Rigging", "Automation"]
# Department is only meaningful for Project Manager / Crew Member roles, and each has its own allowed set
PM_DEPARTMENTS = ["Lighting", "Video", "Rigging"]
CREW_MEMBER_DEPARTMENTS = ["Lighting", "Video", "Rigging", "Automation", "Audio"]


def validate_department_for_roles(roles: List[str], department: Optional[str]) -> Optional[str]:
    """A user's department is only meaningful if they hold Project Manager
    and/or Crew Member — otherwise it's forced to None. Raises HTTPException
    if an explicitly-set department isn't valid for the roles held."""
    is_pm = "Project Manager" in roles
    is_crew = "Crew Member" in roles
    if not is_pm and not is_crew:
        if department:
            raise HTTPException(400, "Department can only be set for Project Manager or Crew Member roles")
        return None
    allowed = set()
    if is_pm:
        allowed.update(PM_DEPARTMENTS)
    if is_crew:
        allowed.update(CREW_MEMBER_DEPARTMENTS)
    if department and department not in allowed:
        raise HTTPException(400, f"Invalid department for this role — allowed: {', '.join(sorted(allowed))}")
    return department

JOB_STATUSES = ["Quote", "Reservation", "Order", "Complete", "Cancelled"]
FAULT_STATUSES = ["Open", "Under Assessment", "In Repair", "Awaiting Parts", "Parts Received", "Repaired", "Closed"]
# Under Assessment / Awaiting Parts / Parts Received are set automatically by
# the system (engineer assignment, parts ordered/received) — never manually.
FAULT_AUTO_ONLY_STATUSES = {"Under Assessment", "Awaiting Parts", "Parts Received"}
FAULT_SEVERITY = ["Low", "Medium", "High", "Critical"]

PREP_BAYS = [
    "Prep Bay 0", "Prep Bay 1", "Prep Bay 2", "Prep Bay 3",
    "Prep Bay 4 (Small GS)", "Prep Bay 5 (Small GS)",
    "Prep Bay 6", "Prep Bay 7", "Prep Bay 8", "Prep Bay 9",
    "Prep Bay 10 (Large GS)", "Prep Bay 11", "The Bridge",
]

LOCKOUT_MAX_ATTEMPTS = 5
LOCKOUT_WINDOW_SECONDS = 15 * 60

# ---------------------------------------------------------------------------
# DB pool + Supabase client
# ---------------------------------------------------------------------------
pool: Optional[asyncpg.Pool] = None
supabase: Optional["SupabaseAuthClient"] = None
_jwks_client = PyJWKClient(SUPABASE_JWKS_URL, cache_keys=True)


class _SupabaseAdminAuth:
    """Wraps Supabase's GoTrue Admin REST endpoints (/auth/v1/admin/users)."""

    def __init__(self, http: httpx.AsyncClient):
        self._http = http

    async def create_user(self, payload: Dict) -> SimpleNamespace:
        r = await self._http.post("/auth/v1/admin/users", json=payload)
        if r.status_code == 422 and "email_exists" in r.text:
            # Auth user already exists (e.g. orphaned from a prior partial
            # seed/cold-start) — look it up rather than treating this as fatal.
            existing = await self.get_user_by_email(payload["email"])
            if existing:
                return existing
        if r.status_code >= 400:
            raise Exception(f"Supabase admin create_user failed: {r.status_code} {r.text}")
        data = r.json()
        return SimpleNamespace(user=SimpleNamespace(id=data["id"], email=data.get("email")))

    async def get_user_by_email(self, email: str) -> Optional[SimpleNamespace]:
        r = await self._http.get("/auth/v1/admin/users", params={"email": email})
        if r.status_code >= 400:
            return None
        data = r.json()
        users = data.get("users", data if isinstance(data, list) else [])
        for u in users:
            if (u.get("email") or "").lower() == email.lower():
                return SimpleNamespace(user=SimpleNamespace(id=u["id"], email=u.get("email")))
        return None

    async def update_user_by_id(self, user_id: str, payload: Dict) -> SimpleNamespace:
        r = await self._http.put(f"/auth/v1/admin/users/{user_id}", json=payload)
        if r.status_code >= 400:
            raise Exception(f"Supabase admin update_user_by_id failed: {r.status_code} {r.text}")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    async def delete_user(self, user_id: str) -> None:
        r = await self._http.delete(f"/auth/v1/admin/users/{user_id}")
        if r.status_code >= 400:
            raise Exception(f"Supabase admin delete_user failed: {r.status_code} {r.text}")


class SupabaseAuthError(Exception):
    def __init__(self, status_code: int, error_code: str):
        self.status_code = status_code
        self.error_code = error_code
        super().__init__(f"Supabase authentication HTTP {status_code}: {error_code}")


class _SupabaseAuth:
    """Wraps Supabase's GoTrue token endpoints (/auth/v1/token)."""

    def __init__(self, http: httpx.AsyncClient):
        self._http = http
        self.admin = _SupabaseAdminAuth(http)

    async def sign_in_with_password(self, payload: Dict) -> SimpleNamespace:
        r = await self._http.post("/auth/v1/token?grant_type=password", json=payload)
        if r.status_code >= 400:
            try:
                body = r.json()
                code = body.get("error_code") or body.get("code") or body.get("error") or ""
            except ValueError:
                code = ""
            raise SupabaseAuthError(r.status_code, str(code))
        return self._session_response(r.json())

    async def refresh_session(self, refresh_token: str) -> SimpleNamespace:
        r = await self._http.post("/auth/v1/token?grant_type=refresh_token", json={"refresh_token": refresh_token})
        if r.status_code >= 400:
            raise Exception(f"Supabase refresh_session failed: {r.status_code} {r.text}")
        return self._session_response(r.json())

    @staticmethod
    def _session_response(data: Dict) -> SimpleNamespace:
        user = data.get("user") or {}
        session = SimpleNamespace(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_in=data.get("expires_in", 3600),
        )
        return SimpleNamespace(user=SimpleNamespace(id=user.get("id"), email=user.get("email")), session=session)


class SupabaseAuthClient:
    """Minimal replacement for supabase-py's async client, talking directly to
    Supabase's GoTrue REST API via httpx. supabase-py's client-side key-format
    validation currently rejects the new sb_secret_... key format (raises
    SupabaseException("Invalid API key") before any network call is even
    made) — this bypasses that bug entirely by calling the REST API ourselves."""

    def __init__(self, url: str, secret_key: str):
        self._http = httpx.AsyncClient(
            base_url=url.rstrip("/"),
            headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
            timeout=15.0,
        )
        self.auth = _SupabaseAuth(self._http)

    async def aclose(self) -> None:
        await self._http.aclose()


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Decode jsonb/json columns straight into Python objects."""
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Vercel's Python runtime uses Fluid compute, so a warm function instance
    can serve multiple requests — this pool persists across those, but stays
    small since many concurrent instances may each hold their own pool against
    Supabase's connection limit. Use the Transaction pooler connection string
    (port 6543) for DATABASE_URL in serverless environments."""
    global pool, supabase
    pool = await asyncpg.create_pool(
        dsn=DATABASE_URL, init=_init_connection, min_size=0, max_size=3, statement_cache_size=0
    )
    supabase = SupabaseAuthClient(SUPABASE_URL, SUPABASE_SECRET_KEY)
    # Never mutate production accounts or demo data during a serverless cold start.
    # Bootstrap/migration is an explicit operator action, not a request side effect.
    yield
    if pool:
        await pool.close()
    if supabase:
        await supabase.aclose()


app = FastAPI(title="PRG Job Portal API", lifespan=lifespan)
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS or [FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def fetch(query: str, *args) -> List[asyncpg.Record]:
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def fetchrow(query: str, *args) -> Optional[asyncpg.Record]:
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def execute(query: str, *args) -> str:
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)


def rec(r: Optional[asyncpg.Record]) -> Optional[Dict]:
    return dict(r) if r is not None else None


def recs(rows: List[asyncpg.Record]) -> List[Dict]:
    return [dict(r) for r in rows]


def iso(dt: Any) -> Any:
    """Normalize datetime/date objects to isoformat strings for JSON responses."""
    if isinstance(dt, (datetime, date)):
        return dt.isoformat()
    return dt


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

# ---------------------------------------------------------------------------
# Helpers — bay conflicts
# ---------------------------------------------------------------------------
def date_ranges_overlap(a_start, a_end, b_start, b_end) -> bool:
    try:
        return a_start < b_end and a_end > b_start
    except TypeError:
        return False


async def bay_conflicts(job_id: Optional[str], prep_date, ship_date, bays: List[str], exclude_manual_id: Optional[str] = None) -> Dict[str, List[Dict[str, str]]]:
    if not bays or not prep_date or not ship_date:
        return {}
    query = """
        select id, name, prep_date, ship_date, prep_bays
        from jobs
        where prep_bays && $1::text[]
          and ($2::uuid is null or id != $2)
    """
    rows = await fetch(query, bays, job_id)
    conflicts: Dict[str, List[Dict[str, str]]] = {}
    for other in rows:
        if not other["prep_date"] or not other["ship_date"]:
            continue
        if not date_ranges_overlap(prep_date, ship_date, other["prep_date"], other["ship_date"]):
            continue
        for bay in bays:
            if bay in (other["prep_bays"] or []):
                conflicts.setdefault(bay, []).append({
                    "job_id": str(other["id"]), "job_name": other["name"],
                    "prep_date": iso(other["prep_date"]), "ship_date": iso(other["ship_date"]),
                    "manual": False,
                })

    manual_query = """
        select id, bay, label, start_date, end_date from manual_bookings
        where bay = any($1::text[]) and ($2::uuid is null or id != $2)
    """
    manual_rows = await fetch(manual_query, bays, exclude_manual_id)
    for m in manual_rows:
        if not date_ranges_overlap(prep_date, ship_date, m["start_date"], m["end_date"]):
            continue
        conflicts.setdefault(m["bay"], []).append({
            "job_id": str(m["id"]), "job_name": m["label"],
            "prep_date": iso(m["start_date"]), "ship_date": iso(m["end_date"]),
            "manual": True,
        })
    return conflicts

# ---------------------------------------------------------------------------
# Auth helpers (Supabase)
# ---------------------------------------------------------------------------
def validate_password_strength(pw: str) -> Optional[str]:
    if len(pw) < 8:
        return "Password must be at least 8 characters."
    if not any(c.isupper() for c in pw):
        return "Password must contain an uppercase letter."
    if not any(c.islower() for c in pw):
        return "Password must contain a lowercase letter."
    if not any(c.isdigit() for c in pw):
        return "Password must contain a number."
    if not any(not c.isalnum() for c in pw):
        return "Password must contain a special character."
    return None


def sanitize_user(u: Dict) -> Dict:
    if not u:
        return u
    return {
        "id": str(u.get("id")),
        "name": u.get("name"),
        "nickname": u.get("nickname"),
        "email": u.get("email"),
        "roles": u.get("roles", []),
        "department": u.get("department"),
        "status": u.get("status", "active"),
        "theme": u.get("theme", "dark"),
        "dashboard_view": u.get("dashboard_view", "standard"),
        "created_at": iso(u.get("created_at")),
        "last_login": iso(u.get("last_login")),
    }


def set_auth_cookies(response: Response, access: str, refresh: str, access_max_age: int, refresh_max_age: int) -> None:
    # Frontend and API are same-origin; Lax prevents unnecessary cross-site cookies.
    common = {"httponly": True, "secure": True, "samesite": "lax", "path": "/"}
    response.set_cookie("access_token", access, max_age=access_max_age, **common)
    response.set_cookie("refresh_token", refresh, max_age=refresh_max_age, **common)


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")


async def get_current_user(request: Request) -> Dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        payload = jwt.decode(token, signing_key.key, algorithms=["ES256", "RS256", "HS256"], audience="authenticated")
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except (jwt.InvalidTokenError, jwt.PyJWKClientError, KeyError, ValueError):
        raise HTTPException(401, "Invalid token")
    user = rec(await fetchrow("select * from profiles where id = $1", payload["sub"]))
    if not user:
        raise HTTPException(401, "User not found")
    if user.get("status") == "disabled":
        raise HTTPException(403, "Account disabled")
    return user


def require_roles(*allowed: str):
    async def dep(user: Dict = Depends(get_current_user)) -> Dict:
        roles = set(user.get("roles", []))
        if "Administrator" in roles:
            return user
        if roles.intersection(allowed):
            return user
        raise HTTPException(403, "Insufficient permissions")
    return dep


def user_can_view_job(user: Dict, job: Dict) -> bool:
    roles = set(user.get("roles", []))
    if roles.intersection({"Administrator", "Operations Manager"}):
        return True
    uid = str(user["id"])
    if "Project Manager" in roles and job.get("project_manager_id") and str(job["project_manager_id"]) == uid:
        return True
    if "Account Manager" in roles and job.get("account_manager_id") and str(job["account_manager_id"]) == uid:
        return True
    crew_ids = [str(c["user_id"]) for c in job.get("crew", [])]
    if uid in crew_ids:
        return True
    return False


# Roles allowed to browse the unfiltered job list (matches the frontend's "canSeeAll" toggle visibility)
CAN_VIEW_ALL_JOBS_ROLES = {"Administrator", "Operations Manager", "Project Manager"}


def job_involves_user(user: Dict, job: Dict) -> bool:
    """Used for the 'mine' scope filter — true only if the user is personally
    listed on this job as crew member, crew chief, project manager, or account
    manager. Unlike user_can_view_job, this does NOT blanket-approve
    Administrator/Operations Manager, so their own 'mine' view is meaningful."""
    uid = str(user["id"])
    roles = set(user.get("roles", []))
    if "Project Manager" in roles and job.get("project_manager_id") and str(job["project_manager_id"]) == uid:
        return True
    if "Account Manager" in roles and job.get("account_manager_id") and str(job["account_manager_id"]) == uid:
        return True
    crew_ids = [str(c["user_id"]) for c in job.get("crew", [])]
    if uid in crew_ids:
        return True
    return False


def is_job_crew_chief(user_id: str, job: Dict) -> bool:
    """True if the user is designated crew chief for ANY department on this
    job. Prep Adds and Ideal Prep are job-level (not per-department)
    submissions, so this checks chief status across all departments rather
    than one specific department."""
    uid = str(user_id)
    return any(str(c["user_id"]) == uid and c.get("is_crew_chief") for c in job.get("crew", []))


async def log_audit(user: Dict, action: str, related: str = "", extra: Optional[Dict] = None) -> None:
    await execute(
        "insert into audit_log (user_id, user_name, action, related, extra, date) values ($1,$2,$3,$4,$5,$6)",
        user["id"], user.get("name"), action, related, extra or {}, datetime.now(timezone.utc),
    )


async def notify_users(user_ids: List[str], title: str, message: str, link: str = "", type_: str = "info", related_job: Optional[str] = None) -> None:
    user_ids = [u for u in user_ids if u]
    if not user_ids:
        return
    for uid in user_ids:
        await execute(
            "insert into notifications (user_id, type, title, message, link, related_job, read, created_at) "
            "values ($1,$2,$3,$4,$5,$6,false,$7)",
            uid, type_, title, message, link, related_job, datetime.now(timezone.utc),
        )
    subs = await fetch("select * from push_subscriptions where user_id = any($1::uuid[])", user_ids)
    for s in subs:
        try:
            webpush(
                subscription_info=s["subscription"],
                data=json.dumps({"title": title, "body": message, "link": link}),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
            )
        except WebPushException as e:
            logger.warning("web push failed: %s", e)
            if e.response and e.response.status_code in (404, 410):
                await execute("delete from push_subscriptions where id = $1", s["id"])


async def send_email(to: str, subject: str, html: str) -> None:
    if not RESEND_ENABLED:
        logger.info("[EMAIL DISABLED] To: %s | Subj: %s | %s", to, subject, html[:200])
        return
    try:
        resend.Emails.send({"from": RESEND_FROM, "to": [to], "subject": subject, "html": html})
    except Exception as e:
        logger.warning("resend send failed: %s", e)

# ---------------------------------------------------------------------------
# Models (unchanged from original)
# ---------------------------------------------------------------------------
class LoginIn(BaseModel):
    email: EmailStr
    password: str

class InviteIn(BaseModel):
    name: str
    email: EmailStr
    roles: List[str]
    department: Optional[str] = None

    @field_validator("roles")
    @classmethod
    def _roles(cls, v):
        for r in v:
            if r not in ROLES:
                raise ValueError(f"Unknown role: {r}")
        return v

class AcceptInviteIn(BaseModel):
    token: str
    password: str

class ForgotPasswordIn(BaseModel):
    email: EmailStr

class ResetPasswordIn(BaseModel):
    token: str
    password: str

class UpdateProfileIn(BaseModel):
    nickname: Optional[str] = None
    theme: Optional[str] = None
    department: Optional[str] = None

class UpdateUserIn(BaseModel):
    roles: Optional[List[str]] = None
    department: Optional[str] = None
    status: Optional[str] = None
    name: Optional[str] = None

class JobUpdateIn(BaseModel):
    name: Optional[str] = None
    winhits_number: Optional[str] = None
    project_manager_id: Optional[str] = None
    account_manager_id: Optional[str] = None
    production_manager: Optional[str] = None
    prep_date: Optional[str] = None
    ship_date: Optional[str] = None
    show_dates: Optional[List[str]] = None
    return_date: Optional[str] = None
    notes: Optional[str] = None
    hotel_details: Optional[str] = None
    travel_details: Optional[str] = None
    prep_bays: Optional[List[str]] = None
    client_details: Optional[str] = None
    status: Optional[str] = None

class JobCreateIn(BaseModel):
    name: str
    winhits_number: Optional[str] = None
    project_manager_id: Optional[str] = None
    account_manager_id: Optional[str] = None
    production_manager: Optional[str] = None
    prep_date: Optional[str] = None
    ship_date: Optional[str] = None
    show_dates: List[str] = []
    return_date: Optional[str] = None
    status: str = "Quote"
    notes: Optional[str] = ""
    hotel_details: Optional[str] = ""
    travel_details: Optional[str] = ""
    client_details: Optional[str] = ""

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        if v not in JOB_STATUSES:
            raise ValueError(f"Invalid status: {v}")
        return v

class BayAssignment(BaseModel):
    bay: str
    department: Optional[str] = None

class BayBookingIn(BaseModel):
    job_id: str
    bays: List[BayAssignment]

class ManualBookingIn(BaseModel):
    bays: List[str]
    label: str
    department: Optional[str] = None
    start_date: str
    end_date: str

class ManualBookingEditIn(BaseModel):
    bay: str
    label: str
    department: Optional[str] = None
    start_date: str
    end_date: str

class CrewAssignmentIn(BaseModel):
    user_id: str
    department: Optional[str] = None
    is_crew_chief: bool = False

class PrepAddIn(BaseModel):
    items: List[Dict[str, Any]]
    notes: Optional[str] = ""

class PrepAddDecisionIn(BaseModel):
    decision: str
    comments: Optional[str] = ""

class IdealPrepIn(BaseModel):
    equipment_requirements: str
    timeline: List[Dict[str, str]] = []
    special_requirements: Optional[str] = ""
    notes: Optional[str] = ""

class IdealPrepDecisionIn(BaseModel):
    decision: str
    comments: Optional[str] = ""

class FaultIn(BaseModel):
    job_id: str
    equipment_barcode: str
    description: str
    can_be_used: bool
    photos: List[str] = []
    videos: List[str] = []
    additional_comments: Optional[str] = ""

class FaultReportEditIn(BaseModel):
    description: Optional[str] = None
    can_be_used: Optional[bool] = None
    photos: Optional[List[str]] = None
    videos: Optional[List[str]] = None
    additional_comments: Optional[str] = None

class FaultUpdateIn(BaseModel):
    status: Optional[str] = None
    severity: Optional[str] = None
    assigned_engineer_id: Optional[str] = None
    reopen: Optional[bool] = None

class FaultCommentIn(BaseModel):
    comment: str

class FaultTimeLogIn(BaseModel):
    hours: float
    description: str
    log_date: Optional[str] = None

    @field_validator("hours")
    @classmethod
    def _positive_hours(cls, v):
        if v <= 0:
            raise ValueError("Hours must be greater than 0")
        return v

class FaultPartIn(BaseModel):
    part_name: str
    quantity: int = 1
    cost: Optional[float] = None
    order_date: Optional[str] = None
    status: str = "Ordered"
    notes: Optional[str] = ""

    @field_validator("quantity")
    @classmethod
    def _positive_qty(cls, v):
        if v <= 0:
            raise ValueError("Quantity must be greater than 0")
        return v

    @field_validator("cost")
    @classmethod
    def _non_negative_cost(cls, v):
        if v is not None and v < 0:
            raise ValueError("Cost cannot be negative")
        return v

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        if v not in ("Ordered", "Received", "Cancelled"):
            raise ValueError("Invalid status")
        return v

class FaultPartUpdateIn(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v):
        if v is not None and v not in ("Ordered", "Received", "Cancelled"):
            raise ValueError("Invalid status")
        return v

class ContactIn(BaseModel):
    label: str
    name: str
    phone: str
    email: Optional[str] = ""

class WifiIn(BaseModel):
    ssid: str
    password: str
    instructions: Optional[str] = ""

class MapZone(BaseModel):
    id: str
    label: str
    x: int
    y: int
    w: int
    h: int
    color: str
    notes: Optional[str] = ""

    @field_validator("w", "h")
    @classmethod
    def _positive_size(cls, v):
        if v <= 0:
            raise ValueError("Width and height must be greater than 0")
        return v

    @field_validator("x", "y")
    @classmethod
    def _non_negative_position(cls, v):
        if v < 0:
            raise ValueError("Position cannot be negative")
        return v

class MapZonesIn(BaseModel):
    zones: List[MapZone]
    map_width: int = 700
    map_height: int = 340

    @field_validator("map_width", "map_height")
    @classmethod
    def _min_canvas_size(cls, v):
        if v < 300:
            raise ValueError("Map canvas must be at least 300 units")
        return v

class EquipmentSpecsIn(BaseModel):
    weight_kg: Optional[float] = None
    width_cm: Optional[float] = None
    height_cm: Optional[float] = None
    depth_cm: Optional[float] = None

    @field_validator("weight_kg", "width_cm", "height_cm", "depth_cm")
    @classmethod
    def _non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value cannot be negative")
        return v

class PushSubscribeIn(BaseModel):
    subscription: Dict[str, Any]

# ---------------------------------------------------------------------------
# Job helpers — attach denormalized names + crew, matching old Mongo shape
# ---------------------------------------------------------------------------
JOB_SELECT = """
    select j.*,
           pm.name as project_manager, am.name as account_manager
    from jobs j
    left join profiles pm on pm.id = j.project_manager_id
    left join profiles am on am.id = j.account_manager_id
"""

# Faults never stored the reporter's name or job name directly (only
# reported_by / job_id foreign keys) — this join populates both, since the
# frontend displays f.reported_by_name and f.job_name on every fault card.
FAULT_SELECT = """
    select f.*, p.name as reported_by_name, j.name as job_name
    from faults f
    left join profiles p on p.id = f.reported_by
    left join jobs j on j.id = f.job_id
"""


async def get_job_crew(job_id: str) -> List[Dict]:
    rows = await fetch(
        "select jc.user_id, p.name as user_name, jc.department, jc.is_crew_chief "
        "from job_crew jc join profiles p on p.id = jc.user_id where jc.job_id = $1",
        job_id,
    )
    return [
        {"user_id": str(r["user_id"]), "user_name": r["user_name"], "department": r["department"],
         "is_crew_chief": r["is_crew_chief"]}
        for r in rows
    ]


async def get_job_bay_departments(job_id: str) -> Dict[str, str]:
    """Returns {bay_name: department} for whichever of this job's bays have a
    department assigned via the admin/ops 'Book Bays' feature."""
    rows = await fetch("select bay, department from job_bay_assignments where job_id = $1", job_id)
    return {r["bay"]: r["department"] for r in rows if r["department"]}


async def hydrate_job(row: Dict) -> Dict:
    job = dict(row)
    job["id"] = str(job["id"])
    if job.get("project_manager_id"):
        job["project_manager_id"] = str(job["project_manager_id"])
    if job.get("account_manager_id"):
        job["account_manager_id"] = str(job["account_manager_id"])
    job["prep_date"] = iso(job.get("prep_date"))
    job["ship_date"] = iso(job.get("ship_date"))
    job["return_date"] = iso(job.get("return_date"))
    job["show_dates"] = [iso(d) for d in (job.get("show_dates") or [])]
    job["created_at"] = iso(job.get("created_at"))
    job["updated_at"] = iso(job.get("updated_at"))
    job["crew"] = await get_job_crew(job["id"])
    job["bay_departments"] = await get_job_bay_departments(job["id"])
    return job


# ---------------------------------------------------------------------------
# Batched job hydration — used by list-returning endpoints (list_jobs, dashboard,
# global_search) to avoid the N+1 query pattern of calling hydrate_job() once
# per job. Each of these does a constant number of queries regardless of how
# many jobs are being hydrated, by using `= any($1::uuid[])` batch lookups.
# ---------------------------------------------------------------------------
async def get_jobs_crew_batch(job_ids: List[str]) -> Dict[str, List[Dict]]:
    if not job_ids:
        return {}
    rows = await fetch(
        "select jc.job_id, jc.user_id, p.name as user_name, jc.department, jc.is_crew_chief "
        "from job_crew jc join profiles p on p.id = jc.user_id where jc.job_id = any($1::uuid[])",
        job_ids,
    )
    result = {jid: [] for jid in job_ids}
    for r in rows:
        result[str(r["job_id"])].append({
            "user_id": str(r["user_id"]), "user_name": r["user_name"],
            "department": r["department"], "is_crew_chief": r["is_crew_chief"],
        })
    return result


async def get_jobs_bay_departments_batch(job_ids: List[str]) -> Dict[str, Dict[str, str]]:
    if not job_ids:
        return {}
    rows = await fetch("select job_id, bay, department from job_bay_assignments where job_id = any($1::uuid[])", job_ids)
    result = {jid: {} for jid in job_ids}
    for r in rows:
        if r["department"]:
            result[str(r["job_id"])][r["bay"]] = r["department"]
    return result


async def get_jobs_indicators_batch(job_ids: List[str]) -> Dict[str, Dict[str, str]]:
    """Batch-computes the documents/prep_adds/ideal_prep/faults indicator
    colors for many jobs in 4 queries total, instead of 4 queries PER job."""
    if not job_ids:
        return {}
    docs_rows = await fetch("select job_id, count(*) as c from documents where job_id = any($1::uuid[]) group by job_id", job_ids)
    docs_count = {str(r["job_id"]): r["c"] for r in docs_rows}

    prep_rows = await fetch(
        "select job_id, status, count(*) as c from prep_adds where job_id = any($1::uuid[]) group by job_id, status",
        job_ids,
    )
    prep_any: Dict[str, int] = {}
    prep_pending: Dict[str, int] = {}
    for r in prep_rows:
        jid = str(r["job_id"])
        prep_any[jid] = prep_any.get(jid, 0) + r["c"]
        if r["status"] == "Pending":
            prep_pending[jid] = prep_pending.get(jid, 0) + r["c"]

    ideal_rows = await fetch(
        "select distinct on (job_id) job_id, status from ideal_prep where job_id = any($1::uuid[]) order by job_id, version desc",
        job_ids,
    )
    ideal_status = {str(r["job_id"]): r["status"] for r in ideal_rows}

    fault_rows = await fetch(
        "select job_id, count(*) as c from faults where job_id = any($1::uuid[]) and status != 'Closed' group by job_id",
        job_ids,
    )
    open_faults = {str(r["job_id"]): r["c"] for r in fault_rows}

    result = {}
    for jid in job_ids:
        ideal_state = "grey"
        latest = ideal_status.get(jid)
        if latest == "Approved":
            ideal_state = "green"
        elif latest == "Pending":
            ideal_state = "amber"
        result[jid] = {
            "documents": "green" if docs_count.get(jid) else "grey",
            "prep_adds": "amber" if prep_pending.get(jid) else ("green" if prep_any.get(jid) else "grey"),
            "ideal_prep": ideal_state,
            "faults": "red" if open_faults.get(jid) else "grey",
        }
    return result


async def hydrate_jobs_batch(rows: List[Dict]) -> List[Dict]:
    """Batched equivalent of calling hydrate_job() once per row — brings the
    query count down from O(N) to a small constant, and also attaches
    `indicators` so the frontend no longer needs a separate per-card fetch."""
    jobs = []
    for row in rows:
        job = dict(row)
        job["id"] = str(job["id"])
        if job.get("project_manager_id"):
            job["project_manager_id"] = str(job["project_manager_id"])
        if job.get("account_manager_id"):
            job["account_manager_id"] = str(job["account_manager_id"])
        job["prep_date"] = iso(job.get("prep_date"))
        job["ship_date"] = iso(job.get("ship_date"))
        job["return_date"] = iso(job.get("return_date"))
        job["show_dates"] = [iso(d) for d in (job.get("show_dates") or [])]
        job["created_at"] = iso(job.get("created_at"))
        job["updated_at"] = iso(job.get("updated_at"))
        jobs.append(job)

    job_ids = [j["id"] for j in jobs]
    crew_map = await get_jobs_crew_batch(job_ids)
    bay_map = await get_jobs_bay_departments_batch(job_ids)
    indicator_map = await get_jobs_indicators_batch(job_ids)

    for j in jobs:
        j["crew"] = crew_map.get(j["id"], [])
        j["bay_departments"] = bay_map.get(j["id"], {})
        ind = indicator_map.get(j["id"], {})
        j["indicators"] = {
            "crew": "green" if j["crew"] else "grey",
            "documents": ind.get("documents", "grey"),
            "prep_adds": ind.get("prep_adds", "grey"),
            "ideal_prep": ind.get("ideal_prep", "grey"),
            "faults": ind.get("faults", "grey"),
            "travel": "green" if j.get("hotel_details") and j.get("travel_details") else "amber",
        }
    return jobs


def redact_job_for_user(job: Dict, user: Dict) -> Dict:
    roles = set(user.get("roles", []))
    out = dict(job)
    if "Crew Member" in roles and not roles.intersection({"Project Manager", "Account Manager", "Operations Manager", "Administrator"}):
        out.pop("account_manager", None)
        out.pop("account_manager_id", None)
        out.pop("production_manager", None)
        out.pop("client_details", None)
    return out

# ---------------------------------------------------------------------------
# Startup / Seed
# ---------------------------------------------------------------------------
async def seed_data() -> None:
    """Called once by `lifespan` on each cold start. Idempotent — every insert
    below is guarded by an existence check, so warm re-invocation is a no-op
    beyond a handful of SELECTs."""
    admin_email = os.environ["ADMIN_EMAIL"].lower()
    admin_password = os.environ["ADMIN_PASSWORD"]
    admin_name = os.environ.get("ADMIN_NAME", "Mack H")

    existing = rec(await fetchrow("select * from profiles where email = $1", admin_email))
    if not existing:
        created = await supabase.auth.admin.create_user({
            "email": admin_email, "password": admin_password, "email_confirm": True,
        })
        admin_id = created.user.id
        await execute(
            "insert into profiles (id, name, email, roles, department, status, theme, created_at) "
            "values ($1,$2,$3,$4,$5,'active','dark',$6)",
            admin_id, admin_name, admin_email, ["Administrator", "Project Manager"], None, datetime.now(timezone.utc),
        )
        logger.info("Seeded admin user: %s", admin_email)
    else:
        # Existing accounts are never modified by bootstrap. In particular,
        # password and role changes must be explicit authenticated operations.
        logger.info("Admin account already exists; leaving unchanged")

    total_users = (await fetchrow("select count(*) as c from profiles"))["c"]
    if total_users < 2:
        demo = [
            ("Jenny Ops", "jenny.ops@prg.com", ["Operations Manager"], None),
            ("Tom Crew", "tom.crew@prg.com", ["Crew Member"], "Lighting"),
            ("Sam Account", "sam.account@prg.com", ["Account Manager"], None),
            ("Ravi Service", "ravi.service@prg.com", ["Service Department"], None),
            ("Alex PM", "alex.pm@prg.com", ["Project Manager"], None),
            ("Chris Crew", "chris.crew@prg.com", ["Crew Member"], "Video"),
        ]
        for name, email, roles, dept in demo:
            created = await supabase.auth.admin.create_user({
                "email": email.lower(), "password": "Password1!", "email_confirm": True,
            })
            await execute(
                "insert into profiles (id, name, email, roles, department, status, theme, created_at) "
                "values ($1,$2,$3,$4,$5,'active','dark',$6)",
                created.user.id, name, email.lower(), roles, dept, datetime.now(timezone.utc),
            )
        logger.info("Seeded demo users")

    if (await fetchrow("select count(*) as c from jobs"))["c"] == 0:
        pm = rec(await fetchrow("select * from profiles where email = $1", admin_email))
        alex = rec(await fetchrow("select * from profiles where email = $1", "alex.pm@prg.com"))
        sam = rec(await fetchrow("select * from profiles where email = $1", "sam.account@prg.com"))
        tom = rec(await fetchrow("select * from profiles where email = $1", "tom.crew@prg.com"))
        chris = rec(await fetchrow("select * from profiles where email = $1", "chris.crew@prg.com"))
        today = datetime.now(timezone.utc).date()

        def d(days: int):
            return today + timedelta(days=days)

        sample_jobs = [
            {"name": "Coldplay Wembley 2026", "winhits": "WH-2026-001", "pm": pm, "am": sam, "status": "Order", "prep": -2, "ship": 3, "show": [7, 8, 9], "ret": 12},
            {"name": "Glastonbury Main Stage", "winhits": "WH-2026-014", "pm": alex, "am": sam, "status": "Order", "prep": 4, "ship": 10, "show": [15, 16, 17, 18], "ret": 22},
            {"name": "BBC Studios Awards Night", "winhits": "WH-2026-022", "pm": pm, "am": sam, "status": "Reservation", "prep": 14, "ship": 20, "show": [24], "ret": 26},
            {"name": "Corporate Product Launch — Google", "winhits": "WH-2026-041", "pm": alex, "am": sam, "status": "Quote", "prep": 30, "ship": 34, "show": [37], "ret": 40},
            {"name": "Royal Albert Hall Symphony", "winhits": "WH-2026-055", "pm": pm, "am": sam, "status": "Order", "prep": 1, "ship": 6, "show": [8], "ret": 10},
            {"name": "Adele Las Vegas Residency", "winhits": "WH-2026-072", "pm": alex, "am": sam, "status": "Complete", "prep": -30, "ship": -25, "show": [-22, -21, -20], "ret": -15},
        ]
        for s in sample_jobs:
            job_id = rec(await fetchrow(
                "insert into jobs (name, winhits_number, project_manager_id, account_manager_id, production_manager, "
                "prep_date, ship_date, show_dates, return_date, status, notes, hotel_details, "
                "travel_details, prep_bays, client_details, source, created_at, updated_at) "
                "values ($1,$2,$3,$4,'Lena Prod',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'SharePoint',$15,$15) "
                "returning id",
                s["name"], s["winhits"],
                s["pm"]["id"] if s["pm"] else None, s["am"]["id"] if s["am"] else None,
                d(s["prep"]), d(s["ship"]), [d(x) for x in s["show"]], d(s["ret"]),
                s["status"], "Standard prep. Confirm truck load times.",
                "Premier Inn — Longbridge, breakfast 6am.",
                "Depart depot 07:30. 2x van, 1x tour bus.",
                ["Bay 3"] if s["status"] == "Order" else [],
                "Client: Live Nation. On-site contact TBC.",
                datetime.now(timezone.utc),
            ))["id"]
            if chris:
                await execute(
                    "insert into job_crew (job_id, user_id, department, is_crew_chief) values ($1,$2,$3,false) on conflict do nothing",
                    job_id, chris["id"], chris.get("department"),
                )
            if tom:
                # Tom is seeded as the Lighting crew chief on these demo jobs (replaces the old jobs.crew_chief_id concept)
                await execute(
                    "insert into job_crew (job_id, user_id, department, is_crew_chief) values ($1,$2,$3,true) on conflict do nothing",
                    job_id, tom["id"], tom.get("department") or "Lighting",
                )
        logger.info("Seeded jobs")

    if (await fetchrow("select count(*) as c from equipment"))["c"] == 0:
        fixtures = [
            ("Robe MegaPointe", 60), ("Martin MAC Aura XB", 40), ("Chauvet Rogue R2X", 30),
            ("Clay Paky Sharpy", 25), ("Elation Fuze SFX", 20), ("GLP JDC-1", 15),
            ("Chain Motor 1T CM Lodestar", 80), ("Prolyte H30V Truss 3m", 100),
            ("Barco E2 Screen Management", 4), ("Blackmagic ATEM 4 M/E", 6),
        ]
        counter = 100001
        rows_to_insert = []
        for fixture, count in fixtures:
            for _ in range(count):
                rows_to_insert.append((f"PRG-{counter:06d}", fixture))
                counter += 1
        async with pool.acquire() as conn:
            await conn.executemany(
                "insert into equipment (barcode, fixture_type, created_at) values ($1,$2, now())",
                rows_to_insert,
            )
        logger.info("Seeded %d equipment records", len(rows_to_insert))

    contacts_count = (await fetchrow("select count(*) as c from contacts"))["c"]
    if contacts_count == 0:
        await execute(
            "update building_info set wifi = $1 where id = 'singleton'",
            {"ssid": "PRG-Guest", "password": "Welcome2PRG!", "instructions": "Accept terms on the captive portal."},
        )
        seed_contacts = [
            ("Reception", "Front Desk", "+44 121 000 0001", "reception@prg.com"),
            ("Security", "Security Desk", "+44 121 000 0002", "security@prg.com"),
            ("Warehouse", "Warehouse Office", "+44 121 000 0003", "warehouse@prg.com"),
            ("Operations", "Ops Duty", "+44 121 000 0004", "operations@prg.com"),
            ("Facilities", "Facilities Team", "+44 121 000 0005", "facilities@prg.com"),
            ("First Aider", "First Aid On-call", "+44 121 000 0006", "firstaid@prg.com"),
        ]
        async with pool.acquire() as conn:
            await conn.executemany(
                "insert into contacts (label, name, phone, email) values ($1,$2,$3,$4)",
                seed_contacts,
            )
        logger.info("Seeded building info")


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------
async def check_lockout(identifier: str) -> None:
    doc = rec(await fetchrow("select * from login_attempts where identifier = $1", identifier))
    if not doc:
        return
    now = datetime.now(timezone.utc)
    # A completed lockout or an expired failure window must not persist forever.
    if (doc.get("locked_until") and doc["locked_until"] <= now) or (
        doc.get("last_attempt") and doc["last_attempt"] + timedelta(seconds=LOCKOUT_WINDOW_SECONDS) <= now
    ):
        await execute("delete from login_attempts where identifier = $1", identifier)
        return
    if doc.get("count", 0) >= LOCKOUT_MAX_ATTEMPTS and doc.get("locked_until") and doc["locked_until"] > now:
        raise HTTPException(429, "Too many failed attempts. Try again later.", headers={"Retry-After": str(max(1, int((doc["locked_until"] - now).total_seconds())))})


async def record_failed_login(identifier: str) -> None:
    # Atomic increment avoids losing attempts when concurrent requests arrive.
    now = datetime.now(timezone.utc)
    await execute("""
        insert into login_attempts (identifier, count, last_attempt, locked_until)
        values ($1, 1, $2, null)
        on conflict (identifier) do update set
          count = case when login_attempts.last_attempt < $2 - interval '15 minutes'
                       or (login_attempts.locked_until is not null and login_attempts.locked_until <= $2)
                       then 1 else login_attempts.count + 1 end,
          last_attempt = $2,
          locked_until = case when login_attempts.last_attempt < $2 - interval '15 minutes'
                                or (login_attempts.locked_until is not null and login_attempts.locked_until <= $2)
                              then null
                              when login_attempts.count + 1 >= $3
                              then $2 + interval '15 minutes'
                              else null end
    """, identifier, now, LOCKOUT_MAX_ATTEMPTS)


async def clear_failed_login(identifier: str) -> None:
    await execute("delete from login_attempts where identifier = $1", identifier)


@api.post("/auth/login")
async def login(payload: LoginIn, request: Request, response: Response):
    ident = f"{request.client.host if request.client else 'x'}:{payload.email.lower()}"
    await check_lockout(ident)
    try:
        result = await supabase.auth.sign_in_with_password({"email": payload.email.lower(), "password": payload.password})
    except SupabaseAuthError as exc:
        if exc.status_code in (400, 401, 422) and exc.error_code in ("invalid_credentials", "invalid_grant", ""):
            await record_failed_login(ident)
            raise HTTPException(401, "Invalid email or password")
        if exc.status_code == 429:
            raise HTTPException(429, "Authentication temporarily rate limited; please try later.")
        logger.warning("Supabase authentication rejected request: HTTP %s, code %s", exc.status_code, exc.error_code)
        raise HTTPException(503, "Authentication service temporarily unavailable")
    except (httpx.HTTPError, ValueError):
        logger.exception("Supabase authentication request failed")
        raise HTTPException(503, "Authentication service temporarily unavailable")
    if not result.session:
        await record_failed_login(ident)
        raise HTTPException(401, "Invalid email or password")
    user = rec(await fetchrow("select * from profiles where id = $1", result.user.id))
    if not user:
        raise HTTPException(401, "Invalid email or password")
    if user.get("status") == "disabled":
        raise HTTPException(403, "Account disabled")
    await clear_failed_login(ident)
    await execute("update profiles set last_login = $2 where id = $1", user["id"], datetime.now(timezone.utc))
    session = result.session
    set_auth_cookies(response, session.access_token, session.refresh_token,
                      session.expires_in, 60 * 60 * 24 * 30)
    await log_audit(user, "login")
    user["last_login"] = datetime.now(timezone.utc)
    return {"user": sanitize_user(user)}


@api.post("/auth/logout")
async def logout(response: Response, user: Dict = Depends(get_current_user)):
    clear_auth_cookies(response)
    await log_audit(user, "logout")
    return {"ok": True}


@api.get("/auth/me")
async def me(user: Dict = Depends(get_current_user)):
    return sanitize_user(user)


@api.post("/auth/refresh")
async def refresh(request: Request, response: Response):
    tok = request.cookies.get("refresh_token")
    if not tok:
        raise HTTPException(401, "No refresh token")
    try:
        result = await supabase.auth.refresh_session(tok)
        session = result.session
        set_auth_cookies(response, session.access_token, session.refresh_token,
                          session.expires_in, 60 * 60 * 24 * 30)
        return {"ok": True}
    except Exception:
        raise HTTPException(401, "Invalid refresh token")


@api.post("/auth/forgot-password")
async def forgot_password(payload: ForgotPasswordIn):
    user = rec(await fetchrow("select * from profiles where email = $1", payload.email.lower()))
    if user:
        token = secrets.token_urlsafe(32)
        await execute(
            "insert into password_reset_tokens (token, user_id, expires_at, used, created_at) "
            "values ($1,$2,$3,false,$4)",
            token, user["id"], datetime.now(timezone.utc) + timedelta(hours=1), datetime.now(timezone.utc),
        )
        link = f"{FRONTEND_URL}/reset-password?token={token}"
        await send_email(user["email"], "PRG Portal — reset your password",
            f"<p>Hi {user.get('name')},</p><p>Reset your password: <a href='{link}'>{link}</a></p><p>This link expires in 1 hour.</p>")
    return {"ok": True}


@api.post("/auth/reset-password")
async def reset_password(payload: ResetPasswordIn):
    err = validate_password_strength(payload.password)
    if err:
        raise HTTPException(400, err)
    tok = rec(await fetchrow("select * from password_reset_tokens where token = $1 and used = false", payload.token))
    if not tok:
        raise HTTPException(400, "Invalid or used token")
    if tok["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(400, "Token expired")
    await supabase.auth.admin.update_user_by_id(str(tok["user_id"]), {"password": payload.password})
    await execute("update password_reset_tokens set used = true where token = $1", payload.token)
    return {"ok": True}


@api.post("/auth/accept-invitation")
async def accept_invitation(payload: AcceptInviteIn):
    err = validate_password_strength(payload.password)
    if err:
        raise HTTPException(400, err)
    inv = rec(await fetchrow("select * from invitations where token = $1 and used = false", payload.token))
    if not inv:
        raise HTTPException(400, "Invalid or used invitation")
    if inv["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(400, "Invitation expired")
    existing = rec(await fetchrow("select * from profiles where email = $1", inv["email"]))
    if existing:
        raise HTTPException(400, "User already exists")
    created = await supabase.auth.admin.create_user({
        "email": inv["email"], "password": payload.password, "email_confirm": True,
    })
    await execute(
        "insert into profiles (id, name, email, roles, department, status, theme, created_at) "
        "values ($1,$2,$3,$4,$5,'active','dark',$6)",
        created.user.id, inv["name"], inv["email"], inv["roles"], inv.get("department"), datetime.now(timezone.utc),
    )
    await execute("update invitations set used = true, used_at = $2 where token = $1", payload.token, datetime.now(timezone.utc))
    return {"ok": True, "email": inv["email"]}


@api.get("/auth/invitation/{token}")
async def get_invitation(token: str):
    inv = rec(await fetchrow("select * from invitations where token = $1 and used = false", token))
    if not inv or inv["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(404, "Invitation not found or expired")
    return {"name": inv["name"], "email": inv["email"], "roles": inv["roles"], "department": inv.get("department")}


@api.get("/auth/vapid-public-key")
async def vapid_public_key():
    return {"key": VAPID_PUBLIC_KEY}

# ---------------------------------------------------------------------------
# Users / Invitations
# ---------------------------------------------------------------------------
@api.get("/users")
async def list_users(user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Administrator", "Project Manager", "Operations Manager"}):
        raise HTTPException(403, "Forbidden")
    users = recs(await fetch("select * from profiles order by created_at"))
    return [sanitize_user(u) for u in users]


@api.get("/users/{user_id}")
async def get_user(user_id: str, user: Dict = Depends(require_roles("Project Manager", "Operations Manager"))):
    u = rec(await fetchrow("select * from profiles where id = $1", user_id))
    if not u:
        raise HTTPException(404, "Not found")
    return sanitize_user(u)


@api.post("/users/invite")
async def invite_user(payload: InviteIn, user: Dict = Depends(get_current_user)):
    inviter_roles = set(user.get("roles", []))
    if not inviter_roles.intersection({"Administrator", "Project Manager"}):
        raise HTTPException(403, "Only Admin or Project Manager may invite users")
    if "Administrator" not in inviter_roles:
        if not set(payload.roles).issubset({"Crew Member"}):
            raise HTTPException(403, "Project Managers may only invite Crew Members")
    existing = rec(await fetchrow("select * from profiles where email = $1", payload.email.lower()))
    if existing:
        raise HTTPException(400, "User with that email exists")
    department = validate_department_for_roles(payload.roles, payload.department)
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=7)
    await execute(
        "insert into invitations (token, name, email, roles, department, invited_by, created_at, expires_at, used) "
        "values ($1,$2,$3,$4,$5,$6,$7,$8,false)",
        token, payload.name, payload.email.lower(), payload.roles, department,
        user["id"], datetime.now(timezone.utc), expires,
    )
    link = f"{FRONTEND_URL}/accept-invitation?token={token}"
    logger.info("[INVITE] %s -> %s", payload.email, link)
    await send_email(payload.email, "PRG Portal — you're invited",
        f"<p>Hi {payload.name},</p><p>You've been invited to join the PRG Job Portal. "
        f"Set your password here: <a href='{link}'>{link}</a></p><p>This link expires in 7 days.</p>")
    await log_audit(user, "invite_user", payload.email, {"roles": payload.roles})
    return {"ok": True, "invitation_link": link}


@api.patch("/users/{user_id}")
async def update_user(user_id: str, payload: UpdateUserIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    target = rec(await fetchrow("select * from profiles where id = $1", user_id))
    if not target:
        raise HTTPException(404, "Not found")
    updates: Dict[str, Any] = {}
    if payload.name is not None:
        updates["name"] = payload.name
    if payload.roles is not None:
        if "Administrator" not in roles:
            if set(target.get("roles", [])).intersection({"Administrator", "Project Manager"}) or set(payload.roles).intersection({"Administrator", "Project Manager"}):
                raise HTTPException(403, "Only Admin can change Admin/PM roles")
            if not set(payload.roles).issubset({"Crew Member"}):
                raise HTTPException(403, "PMs may only assign the Crew Member role")
        updates["roles"] = payload.roles
    final_roles = payload.roles if payload.roles is not None else target.get("roles", [])
    if payload.department is not None:
        updates["department"] = validate_department_for_roles(final_roles, payload.department)
    elif payload.roles is not None and target.get("department"):
        try:
            validate_department_for_roles(final_roles, target["department"])
        except HTTPException:
            updates["department"] = None
    if payload.status is not None:
        if "Administrator" not in roles and "Project Manager" not in roles:
            raise HTTPException(403, "Forbidden")
        updates["status"] = payload.status
    if updates:
        set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
        await execute(f"update profiles set {set_clause} where id = $1", user_id, *updates.values())
        await log_audit(user, "update_user", user_id, updates)
    updated = rec(await fetchrow("select * from profiles where id = $1", user_id))
    return sanitize_user(updated)


@api.delete("/users/{user_id}")
async def delete_user(user_id: str, user: Dict = Depends(require_roles("Administrator"))):
    await supabase.auth.admin.delete_user(user_id)
    await execute("delete from profiles where id = $1", user_id)
    await log_audit(user, "delete_user", user_id)
    return {"ok": True}


@api.patch("/profile")
async def update_profile(payload: UpdateProfileIn, user: Dict = Depends(get_current_user)):
    updates: Dict[str, Any] = {}
    if payload.nickname is not None:
        updates["nickname"] = payload.nickname.strip() or None
    if payload.theme is not None and payload.theme in ("dark", "light"):
        updates["theme"] = payload.theme
    if payload.department is not None:
        updates["department"] = validate_department_for_roles(user.get("roles", []), payload.department)
    if updates:
        set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
        await execute(f"update profiles set {set_clause} where id = $1", user["id"], *updates.values())
    updated = rec(await fetchrow("select * from profiles where id = $1", user["id"]))
    return sanitize_user(updated)


@api.get("/invitations")
async def list_invitations(user: Dict = Depends(require_roles("Project Manager"))):
    inv = recs(await fetch("select * from invitations order by created_at desc"))
    for i in inv:
        i["id"] = str(i["id"])
        i["expires_at"] = iso(i["expires_at"])
        i["created_at"] = iso(i["created_at"])
        i["used_at"] = iso(i.get("used_at"))
    return inv


@api.delete("/invitations/{invitation_id}")
async def delete_invitation(invitation_id: str, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Administrator", "Project Manager"}):
        raise HTTPException(403, "Only Admin or Project Manager may delete invitations")
    inv = rec(await fetchrow("select * from invitations where id = $1", invitation_id))
    if not inv:
        raise HTTPException(404, "Invitation not found")
    if inv.get("used"):
        raise HTTPException(400, "Invitation already accepted — cannot delete")
    if "Administrator" not in roles:
        crew_only = set(inv.get("roles", [])).issubset({"Crew Member"})
        if str(inv.get("invited_by")) != str(user["id"]) and not crew_only:
            raise HTTPException(403, "Project Managers may only delete Crew invitations or invitations they created")
    await execute("delete from invitations where id = $1", invitation_id)
    await log_audit(user, "delete_invitation", invitation_id, {"email": inv.get("email"), "roles": inv.get("roles")})
    return {"ok": True}

# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
@api.post("/jobs")
async def create_job(payload: JobCreateIn, user: Dict = Depends(require_roles("Administrator"))):
    """Admin-only: manually create a job, mainly for testing purposes
    (real jobs normally arrive via the SharePoint import)."""
    def parse_date(s: Optional[str]):
        if not s:
            return None
        try:
            return date.fromisoformat(s)
        except ValueError:
            raise HTTPException(400, f"Invalid date '{s}' — use YYYY-MM-DD")

    prep_d = parse_date(payload.prep_date)
    ship_d = parse_date(payload.ship_date)
    return_d = parse_date(payload.return_date)
    show_ds = [parse_date(s) for s in payload.show_dates if s]

    if payload.project_manager_id:
        pm = rec(await fetchrow("select id from profiles where id = $1", payload.project_manager_id))
        if not pm:
            raise HTTPException(400, "Unknown project_manager_id")
    if payload.account_manager_id:
        am = rec(await fetchrow("select id from profiles where id = $1", payload.account_manager_id))
        if not am:
            raise HTTPException(400, "Unknown account_manager_id")

    row = rec(await fetchrow(
        "insert into jobs (name, winhits_number, project_manager_id, account_manager_id, production_manager, "
        "prep_date, ship_date, show_dates, return_date, status, notes, hotel_details, travel_details, "
        "prep_bays, client_details, source, created_at, updated_at) "
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}',$14,'Manual',$15,$15) returning id",
        payload.name, payload.winhits_number, payload.project_manager_id, payload.account_manager_id,
        payload.production_manager, prep_d, ship_d, show_ds, return_d, payload.status,
        payload.notes or "", payload.hotel_details or "", payload.travel_details or "",
        payload.client_details or "", datetime.now(timezone.utc),
    ))
    await log_audit(user, "create_job", str(row["id"]), {"name": payload.name})
    result_row = rec(await fetchrow(JOB_SELECT + " where j.id = $1", row["id"]))
    return await hydrate_job(result_row)


@api.get("/jobs")
async def list_jobs(
    status_filter: Optional[str] = Query(None, alias="status"),
    scope: Optional[str] = Query("mine"),
    user: Dict = Depends(get_current_user),
):
    roles = set(user.get("roles", []))
    query = JOB_SELECT
    args = []
    if status_filter:
        query += " where j.status = $1"
        args.append(status_filter)
    query += " order by j.prep_date asc"
    rows = recs(await fetch(query, *args))
    jobs = await hydrate_jobs_batch(rows)
    if not (scope == "all" and roles.intersection(CAN_VIEW_ALL_JOBS_ROLES)):
        jobs = [j for j in jobs if job_involves_user(user, j)]
    return [redact_job_for_user(j, user) for j in jobs]


@api.get("/jobs/{job_id}")
async def get_job(job_id: str, user: Dict = Depends(get_current_user)):
    row = rec(await fetchrow(JOB_SELECT + " where j.id = $1", job_id))
    if not row:
        raise HTTPException(404, "Job not found")
    j = await hydrate_job(row)
    if not user_can_view_job(user, j):
        raise HTTPException(403, "Forbidden")
    return redact_job_for_user(j, user)


@api.patch("/jobs/{job_id}")
async def update_job(job_id: str, payload: JobUpdateIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Project Manager", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    j = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not j:
        raise HTTPException(404, "Not found")
    is_admin = "Administrator" in roles
    if not is_admin and (not j.get("project_manager_id") or str(j["project_manager_id"]) != str(user["id"])):
        raise HTTPException(403, "Only the assigned PM can edit this job")

    ADMIN_ONLY_FIELDS = {"name", "winhits_number", "project_manager_id", "account_manager_id",
                         "production_manager", "prep_date", "ship_date", "show_dates", "return_date"}
    raw = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not is_admin and set(raw).intersection(ADMIN_ONLY_FIELDS):
        raise HTTPException(403, "Only an Administrator can change job name, dates, or PM/AM assignment")

    updates: Dict[str, Any] = {}
    for k, v in raw.items():
        if k in ("prep_date", "ship_date", "return_date"):
            try:
                updates[k] = date.fromisoformat(v)
            except ValueError:
                raise HTTPException(400, f"Invalid date '{v}' — use YYYY-MM-DD")
        elif k == "show_dates":
            try:
                updates[k] = [date.fromisoformat(s) for s in v]
            except ValueError:
                raise HTTPException(400, "Invalid date in show_dates — use YYYY-MM-DD")
        else:
            updates[k] = v

    if "project_manager_id" in updates:
        pm = rec(await fetchrow("select id from profiles where id = $1", updates["project_manager_id"]))
        if not pm:
            raise HTTPException(400, "Unknown project_manager_id")
    if "account_manager_id" in updates:
        am = rec(await fetchrow("select id from profiles where id = $1", updates["account_manager_id"]))
        if not am:
            raise HTTPException(400, "Unknown account_manager_id")

    if "prep_bays" in updates:
        invalid = [b for b in updates["prep_bays"] if b not in PREP_BAYS]
        if invalid:
            raise HTTPException(400, f"Unknown prep bay(s): {', '.join(invalid)}")
        conflicts = await bay_conflicts(job_id, j.get("prep_date"), j.get("ship_date"), updates["prep_bays"])
        if conflicts:
            summary = "; ".join(
                f"{bay} blocked by " + ", ".join(
                    (f"{c['job_name']} (manual booking)" if c.get("manual") else c["job_name"]) for c in confl
                )
                for bay, confl in conflicts.items()
            )
            raise HTTPException(409, f"Prep bay conflict — {summary}")

    updates["updated_at"] = datetime.now(timezone.utc)
    set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    await execute(f"update jobs set {set_clause} where id = $1", job_id, *updates.values())
    if "prep_bays" in updates:
        await execute(
            "delete from job_bay_assignments where job_id = $1 and not (bay = any($2::text[]))",
            job_id, updates["prep_bays"],
        )
    await log_audit(user, "update_job", job_id, {k: str(v) for k, v in updates.items()})
    row = rec(await fetchrow(JOB_SELECT + " where j.id = $1", job_id))
    return await hydrate_job(row)


@api.delete("/jobs/{job_id}")
async def delete_job(job_id: str, user: Dict = Depends(require_roles("Administrator"))):
    j = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not j:
        raise HTTPException(404, "Not found")
    # notifications.related_job has no ON DELETE rule, so clear it first to
    # avoid a foreign key violation — everything else (documents, prep_adds,
    # ideal_prep, job_crew, job_bay_assignments) cascades automatically, and
    # faults.job_id is ON DELETE SET NULL so fault records survive.
    await execute("update notifications set related_job = null where related_job = $1", job_id)
    await execute("delete from jobs where id = $1", job_id)
    await log_audit(user, "delete_job", job_id, {"name": j.get("name")})
    return {"ok": True}


@api.post("/prep-bays/booking")
async def book_bays(payload: BayBookingIn, user: Dict = Depends(require_roles("Administrator", "Operations Manager"))):
    """Admin/Ops-only: allocate prep bays to a job, optionally tagging each
    bay with a department. Unlike the plain PM bay picker on Job Details,
    this can set a department per bay."""
    j = rec(await fetchrow("select * from jobs where id = $1", payload.job_id))
    if not j:
        raise HTTPException(404, "Job not found")
    bay_names = [b.bay for b in payload.bays]
    invalid = [b for b in bay_names if b not in PREP_BAYS]
    if invalid:
        raise HTTPException(400, f"Unknown prep bay(s): {', '.join(invalid)}")
    for b in payload.bays:
        if b.department and b.department not in BAY_DEPARTMENTS:
            raise HTTPException(400, f"Unknown department: {b.department}")
    conflicts = await bay_conflicts(payload.job_id, j.get("prep_date"), j.get("ship_date"), bay_names)
    if conflicts:
        summary = "; ".join(
            f"{bay} blocked by " + ", ".join(
                (f"{c['job_name']} (manual booking)" if c.get("manual") else c["job_name"]) for c in confl
            )
            for bay, confl in conflicts.items()
        )
        raise HTTPException(409, f"Prep bay conflict — {summary}")
    await execute(
        "update jobs set prep_bays = $2, updated_at = $3 where id = $1",
        payload.job_id, bay_names, datetime.now(timezone.utc),
    )
    await execute("delete from job_bay_assignments where job_id = $1", payload.job_id)
    for b in payload.bays:
        if b.department:
            await execute(
                "insert into job_bay_assignments (job_id, bay, department) values ($1,$2,$3)",
                payload.job_id, b.bay, b.department,
            )
    await log_audit(user, "book_bays", payload.job_id, {"bays": bay_names})
    row = rec(await fetchrow(JOB_SELECT + " where j.id = $1", payload.job_id))
    return await hydrate_job(row)


@api.get("/prep-bays/bookings")
async def prep_bays_bookings(year: int, month: int, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Administrator", "Project Manager", "Operations Manager"}):
        raise HTTPException(403, "Forbidden")
    if month < 1 or month > 12:
        raise HTTPException(400, "Invalid month")
    month_start = f"{year:04d}-{month:02d}-01"
    month_end_next = f"{year + 1:04d}-01-01" if month == 12 else f"{year:04d}-{month + 1:02d}-01"
    month_start_d = date(year, month, 1)
    month_end_next_d = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    rows = recs(await fetch(
        "select id, name, winhits_number, prep_date, ship_date, status, prep_bays from jobs "
        "where prep_bays != '{}' and prep_date < $2::date and ship_date > $1::date",
        month_start_d, month_end_next_d,
    ))
    job_ids = [str(j["id"]) for j in rows]
    bay_dept_map = await get_jobs_bay_departments_batch(job_ids)

    manual_rows = recs(await fetch(
        "select * from manual_bookings where start_date < $2::date and end_date > $1::date",
        month_start_d, month_end_next_d,
    ))

    return {
        "bays": PREP_BAYS,
        "month_start": month_start,
        "month_end_next": month_end_next,
        "bookings": [
            {
                "job_id": str(j["id"]), "job_name": j["name"], "winhits_number": j.get("winhits_number"),
                "prep_date": iso(j["prep_date"]), "ship_date": iso(j["ship_date"]), "status": j.get("status"),
                "prep_bays": j.get("prep_bays", []), "bay_departments": bay_dept_map.get(str(j["id"]), {}),
            }
            for j in rows
        ],
        "manual_bookings": [
            {
                "id": str(m["id"]), "bay": m["bay"], "label": m["label"], "department": m.get("department"),
                "start_date": iso(m["start_date"]), "end_date": iso(m["end_date"]),
                "created_by_name": m.get("created_by_name"),
            }
            for m in manual_rows
        ],
    }


@api.post("/prep-bays/manual-booking")
async def create_manual_booking(payload: ManualBookingIn, user: Dict = Depends(require_roles("Administrator", "Operations Manager"))):
    """Book a bay for a date range without linking it to any job — for
    maintenance, equipment testing, or other operational blocks."""
    if not payload.label.strip():
        raise HTTPException(400, "Label is required")
    invalid = [b for b in payload.bays if b not in PREP_BAYS]
    if invalid:
        raise HTTPException(400, f"Unknown prep bay(s): {', '.join(invalid)}")
    if payload.department and payload.department not in BAY_DEPARTMENTS:
        raise HTTPException(400, f"Unknown department: {payload.department}")
    try:
        start_d = date.fromisoformat(payload.start_date)
        end_d = date.fromisoformat(payload.end_date)
    except ValueError:
        raise HTTPException(400, "Invalid date — use YYYY-MM-DD")
    if start_d > end_d:
        raise HTTPException(400, "Start date must be before end date")

    conflicts = await bay_conflicts(None, start_d, end_d, payload.bays)
    if conflicts:
        summary = "; ".join(
            f"{bay} blocked by " + ", ".join(
                (f"{c['job_name']} (manual booking)" if c.get("manual") else c["job_name"]) for c in confl
            )
            for bay, confl in conflicts.items()
        )
        raise HTTPException(409, f"Prep bay conflict — {summary}")

    created_ids = []
    for bay in payload.bays:
        row = rec(await fetchrow(
            "insert into manual_bookings (bay, label, department, start_date, end_date, created_by, created_by_name) "
            "values ($1,$2,$3,$4,$5,$6,$7) returning id",
            bay, payload.label.strip(), payload.department, start_d, end_d, user["id"], user.get("name"),
        ))
        created_ids.append(str(row["id"]))
    await log_audit(user, "create_manual_booking", extra={"bays": payload.bays, "label": payload.label})
    return {"ok": True, "ids": created_ids}


@api.patch("/prep-bays/manual-booking/{booking_id}")
async def update_manual_booking(booking_id: str, payload: ManualBookingEditIn, user: Dict = Depends(require_roles("Administrator", "Operations Manager"))):
    existing = rec(await fetchrow("select * from manual_bookings where id = $1", booking_id))
    if not existing:
        raise HTTPException(404, "Not found")
    if not payload.label.strip():
        raise HTTPException(400, "Label is required")
    if payload.bay not in PREP_BAYS:
        raise HTTPException(400, f"Unknown prep bay: {payload.bay}")
    if payload.department and payload.department not in BAY_DEPARTMENTS:
        raise HTTPException(400, f"Unknown department: {payload.department}")
    try:
        start_d = date.fromisoformat(payload.start_date)
        end_d = date.fromisoformat(payload.end_date)
    except ValueError:
        raise HTTPException(400, "Invalid date — use YYYY-MM-DD")
    if start_d > end_d:
        raise HTTPException(400, "Start date must be before end date")

    conflicts = await bay_conflicts(None, start_d, end_d, [payload.bay], exclude_manual_id=booking_id)
    if conflicts:
        summary = "; ".join(
            f"{bay} blocked by " + ", ".join(
                (f"{c['job_name']} (manual booking)" if c.get("manual") else c["job_name"]) for c in confl
            )
            for bay, confl in conflicts.items()
        )
        raise HTTPException(409, f"Prep bay conflict — {summary}")

    await execute(
        "update manual_bookings set bay = $2, label = $3, department = $4, start_date = $5, end_date = $6 where id = $1",
        booking_id, payload.bay, payload.label.strip(), payload.department, start_d, end_d,
    )
    await log_audit(user, "update_manual_booking", booking_id, {"bay": payload.bay, "label": payload.label})
    return {"ok": True}


@api.delete("/prep-bays/manual-booking/{booking_id}")
async def delete_manual_booking(booking_id: str, user: Dict = Depends(require_roles("Administrator", "Operations Manager"))):
    await execute("delete from manual_bookings where id = $1", booking_id)
    await log_audit(user, "delete_manual_booking", booking_id)
    return {"ok": True}


@api.get("/prep-bays")
async def list_prep_bays(user: Dict = Depends(get_current_user)):
    return {"bays": PREP_BAYS}


@api.get("/prep-bays/availability")
async def prep_bays_availability(prep_date: str, ship_date: str, exclude_job_id: Optional[str] = None, exclude_manual_id: Optional[str] = None, user: Dict = Depends(get_current_user)):
    try:
        prep_date_d = date.fromisoformat(prep_date)
        ship_date_d = date.fromisoformat(ship_date)
    except ValueError:
        raise HTTPException(400, "prep_date and ship_date must be ISO format dates (YYYY-MM-DD)")
    conflicts = await bay_conflicts(exclude_job_id, prep_date_d, ship_date_d, PREP_BAYS, exclude_manual_id=exclude_manual_id)
    result = []
    for bay in PREP_BAYS:
        confl = conflicts.get(bay, [])
        result.append({"bay": bay, "available": len(confl) == 0, "conflicts": confl})
    return result


@api.post("/jobs/{job_id}/crew")
async def assign_crew(job_id: str, payload: CrewAssignmentIn, user: Dict = Depends(require_roles("Project Manager"))):
    j = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not j:
        raise HTTPException(404, "Not found")
    u = rec(await fetchrow("select * from profiles where id = $1", payload.user_id))
    if not u:
        raise HTTPException(404, "User not found")
    if "Crew Member" not in set(u.get("roles", [])):
        raise HTTPException(400, "Only users with the Crew Member role may be assigned as crew")
    department = payload.department or u.get("department")
    if payload.is_crew_chief:
        if not department:
            raise HTTPException(400, "A department is required to assign a crew chief")
        if department not in DEPARTMENTS:
            raise HTTPException(400, f"Unknown department: {department}")
        # Only one crew chief per department per job — demote any existing one first
        await execute(
            "update job_crew set is_crew_chief = false where job_id = $1 and department = $2 and is_crew_chief = true",
            job_id, department,
        )
    await execute(
        "insert into job_crew (job_id, user_id, department, is_crew_chief) values ($1,$2,$3,$4) "
        "on conflict (job_id, user_id) do update set department = $3, is_crew_chief = $4",
        job_id, u["id"], department, payload.is_crew_chief,
    )
    await log_audit(user, "assign_crew", job_id, {"user_id": str(u["id"]), "department": department, "is_crew_chief": payload.is_crew_chief})
    title = "New job assignment" if not payload.is_crew_chief else "New job assignment — Crew Chief"
    message = f"You have been assigned to {j['name']}" + (f" as {department} Crew Chief" if payload.is_crew_chief else "")
    await notify_users([str(u["id"])], title, message, f"/jobs/{job_id}", "job")
    return {"ok": True}


@api.delete("/jobs/{job_id}/crew/{user_id}")
async def remove_crew(job_id: str, user_id: str, user: Dict = Depends(require_roles("Project Manager"))):
    await execute("delete from job_crew where job_id = $1 and user_id = $2", job_id, user_id)
    await log_audit(user, "remove_crew", job_id, {"user_id": user_id})
    return {"ok": True}


@api.get("/jobs/{job_id}/status-indicators")
async def job_status_indicators(job_id: str, user: Dict = Depends(get_current_user)):
    row = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not row:
        raise HTTPException(404, "Not found")
    j = await hydrate_job(row)
    if not user_can_view_job(user, j):
        raise HTTPException(404, "Not found")
    docs_count = (await fetchrow("select count(*) as c from documents where job_id = $1", job_id))["c"]
    prep_pending = (await fetchrow("select count(*) as c from prep_adds where job_id = $1 and status = 'Pending'", job_id))["c"]
    prep_any = (await fetchrow("select count(*) as c from prep_adds where job_id = $1", job_id))["c"]
    ideal = recs(await fetch("select * from ideal_prep where job_id = $1 order by version desc limit 1", job_id))
    ideal_state = "grey"
    if ideal:
        latest = ideal[0]
        if latest["status"] == "Approved":
            ideal_state = "green"
        elif latest["status"] == "Pending":
            ideal_state = "amber"
    open_faults = (await fetchrow("select count(*) as c from faults where job_id = $1 and status != 'Closed'", job_id))["c"]
    return {
        "crew": "green" if j.get("crew") else "grey",
        "documents": "green" if docs_count else "grey",
        "prep_adds": "amber" if prep_pending else ("green" if prep_any else "grey"),
        "ideal_prep": ideal_state,
        "faults": "red" if open_faults else "grey",
        "travel": "green" if j.get("hotel_details") and j.get("travel_details") else "amber",
    }

# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------
class DocumentIn(BaseModel):
    document_type: str
    department: Optional[str] = None
    file_name: str
    file_url: str


def hydrate_doc(d: Dict) -> Dict:
    d = dict(d)
    d["id"] = str(d["id"])
    d["job_id"] = str(d["job_id"])
    if d.get("uploaded_by"):
        d["uploaded_by"] = str(d["uploaded_by"])
    d["upload_date"] = iso(d.get("upload_date"))
    return d


@api.get("/jobs/{job_id}/documents")
async def list_documents(job_id: str, user: Dict = Depends(get_current_user)):
    row = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not row:
        raise HTTPException(404, "Not found")
    j = await hydrate_job(row)
    if not user_can_view_job(user, j):
        raise HTTPException(404, "Not found")
    docs = [hydrate_doc(d) for d in recs(await fetch("select * from documents where job_id = $1", job_id))]
    roles = set(user.get("roles", []))
    if roles == {"Crew Member"}:
        docs = [d for d in docs if d["document_type"] == "Drawing" and (not user.get("department") or d.get("department") == user.get("department"))]
    if "Account Manager" in roles and not roles.intersection({"Project Manager", "Operations Manager", "Administrator"}):
        docs = [d for d in docs if d["document_type"] not in ("RAMS", "Motor Certificate", "LOLER")]
    return docs


@api.post("/jobs/{job_id}/documents")
async def add_document(job_id: str, payload: DocumentIn, user: Dict = Depends(require_roles("Project Manager"))):
    j = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not j:
        raise HTTPException(404, "Not found")
    row = rec(await fetchrow(
        "insert into documents (job_id, document_type, department, file_name, file_url, uploaded_by, upload_date) "
        "values ($1,$2,$3,$4,$5,$6,$7) returning *",
        job_id, payload.document_type, payload.department, payload.file_name, payload.file_url,
        user["id"], datetime.now(timezone.utc),
    ))
    await log_audit(user, "upload_document", job_id, {"file_name": payload.file_name})
    crew = await get_job_crew(job_id)
    crew_ids = [c["user_id"] for c in crew]
    await notify_users(crew_ids, "New document", f"{payload.file_name} uploaded for {j['name']}", f"/jobs/{job_id}", "document", job_id)
    return hydrate_doc(row)


@api.delete("/jobs/{job_id}/documents/{doc_id}")
async def delete_document(job_id: str, doc_id: str, user: Dict = Depends(require_roles("Project Manager"))):
    await execute("delete from documents where id = $1 and job_id = $2", doc_id, job_id)
    await log_audit(user, "delete_document", job_id, {"doc_id": doc_id})
    return {"ok": True}

# ---------------------------------------------------------------------------
# Prep Adds
# ---------------------------------------------------------------------------
def hydrate_prep_add(p: Dict, history: List[Dict]) -> Dict:
    p = dict(p)
    p["id"] = str(p["id"])
    p["job_id"] = str(p["job_id"])
    if p.get("submitted_by"):
        p["submitted_by_id"] = str(p.pop("submitted_by"))
    if p.get("decision_by"):
        p["decision_by_id"] = str(p.pop("decision_by"))
    p["submission_date"] = iso(p.get("submission_date"))
    p["decision_date"] = iso(p.get("decision_date"))
    p["history"] = [
        {"date": iso(h["date"]), "user": h["user_name"], "action": h["action"], "items": h.get("items"), "notes": h.get("notes")}
        for h in history
    ]
    return p


@api.get("/jobs/{job_id}/prep-adds")
async def list_prep_adds(job_id: str, user: Dict = Depends(get_current_user)):
    row = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not row:
        raise HTTPException(404, "Not found")
    j = await hydrate_job(row)
    if not user_can_view_job(user, j):
        raise HTTPException(404, "Not found")
    roles = set(user.get("roles", []))
    if not roles.intersection({"Crew Member", "Project Manager", "Operations Manager", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    preps = recs(await fetch("select * from prep_adds where job_id = $1 order by submission_date desc", job_id))
    out = []
    for p in preps:
        hist = recs(await fetch("select * from prep_add_history where prep_add_id = $1 order by date", p["id"]))
        out.append(hydrate_prep_add(p, hist))
    return out


@api.post("/jobs/{job_id}/prep-adds")
async def create_prep_add(job_id: str, payload: PrepAddIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    j = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not j:
        raise HTTPException(404, "Not found")
    crew = await get_job_crew(job_id)
    is_chief = any(str(c["user_id"]) == str(user["id"]) and c.get("is_crew_chief") for c in crew)
    if not (is_chief or roles.intersection({"Project Manager", "Administrator"})):
        raise HTTPException(403, "Only this job's crew chief, the assigned Project Manager, or an Administrator may submit Prep Adds")
    today = datetime.now(timezone.utc).date()
    if not (j.get("prep_date") and j.get("ship_date") and j["prep_date"] <= today <= j["ship_date"]):
        raise HTTPException(400, "Prep Adds can only be submitted while this job is between its prep and ship dates")
    row = rec(await fetchrow(
        "insert into prep_adds (job_id, submitted_by, submission_date, items, notes, status) "
        "values ($1,$2,$3,$4,$5,'Pending') returning *",
        job_id, user["id"], datetime.now(timezone.utc), payload.items, payload.notes or "",
    ))
    await execute(
        "insert into prep_add_history (prep_add_id, date, user_name, action, items, notes) values ($1,$2,$3,'submitted',$4,$5)",
        row["id"], datetime.now(timezone.utc), user.get("name"), payload.items, payload.notes or "",
    )
    await log_audit(user, "submit_prep_add", job_id, {"prep_add_id": str(row["id"])})
    if j.get("project_manager_id"):
        await notify_users([str(j["project_manager_id"])], "New Prep Add", f"{user['name']} submitted a Prep Add on {j['name']}", f"/jobs/{job_id}?tab=prep-adds", "prep-add", job_id)
    hist = recs(await fetch("select * from prep_add_history where prep_add_id = $1 order by date", row["id"]))
    return hydrate_prep_add(row, hist)


@api.patch("/prep-adds/{prep_id}")
async def edit_prep_add(prep_id: str, payload: PrepAddIn, user: Dict = Depends(get_current_user)):
    """Lets the original submitter amend their own Prep Add in place, but only
    while it's still Pending — locked as soon as the Project Manager decides."""
    doc = rec(await fetchrow("select * from prep_adds where id = $1", prep_id))
    if not doc:
        raise HTTPException(404, "Not found")
    if not doc.get("submitted_by") or str(doc["submitted_by"]) != str(user["id"]):
        raise HTTPException(403, "Only the original submitter may edit this Prep Add")
    if doc["status"] != "Pending":
        raise HTTPException(400, "This Prep Add has already been decided and can no longer be edited")
    await execute(
        "update prep_adds set items = $2, notes = $3 where id = $1",
        prep_id, payload.items, payload.notes or "",
    )
    await execute(
        "insert into prep_add_history (prep_add_id, date, user_name, action, items, notes) values ($1,$2,$3,'edited',$4,$5)",
        prep_id, datetime.now(timezone.utc), user.get("name"), payload.items, payload.notes or "",
    )
    await log_audit(user, "edit_prep_add", str(doc["job_id"]), {"prep_add_id": prep_id})
    row = rec(await fetchrow("select * from prep_adds where id = $1", prep_id))
    hist = recs(await fetch("select * from prep_add_history where prep_add_id = $1 order by date", prep_id))
    return hydrate_prep_add(row, hist)


@api.post("/prep-adds/{prep_id}/decision")
async def decide_prep_add(prep_id: str, payload: PrepAddDecisionIn, user: Dict = Depends(require_roles("Project Manager"))):
    if payload.decision not in ("Approved", "Rejected"):
        raise HTTPException(400, "Invalid decision")
    doc = rec(await fetchrow("select * from prep_adds where id = $1", prep_id))
    if not doc:
        raise HTTPException(404, "Not found")
    j = rec(await fetchrow("select * from jobs where id = $1", doc["job_id"]))
    roles = set(user.get("roles", []))
    if "Administrator" not in roles and (not j.get("project_manager_id") or str(j["project_manager_id"]) != str(user["id"])):
        raise HTTPException(403, "Only assigned PM may approve")
    await execute(
        "update prep_adds set status=$2, decision_by=$3, decision_date=$4, approval_notes=$5 where id=$1",
        prep_id, payload.decision, user["id"], datetime.now(timezone.utc), payload.comments or "",
    )
    await execute(
        "insert into prep_add_history (prep_add_id, date, user_name, action, notes) values ($1,$2,$3,$4,$5)",
        prep_id, datetime.now(timezone.utc), user.get("name"), payload.decision.lower(), payload.comments,
    )
    await log_audit(user, f"prep_add_{payload.decision.lower()}", str(doc["job_id"]), {"prep_id": prep_id})
    if doc.get("submitted_by"):
        job_name = j["name"] if j else ""
        await notify_users([str(doc["submitted_by"])], f"Prep Add {payload.decision}", f"Your Prep Add on {job_name} was {payload.decision.lower()}", f"/jobs/{doc['job_id']}?tab=prep-adds", "prep-add", str(doc["job_id"]))
    return {"ok": True}

# ---------------------------------------------------------------------------
# Ideal Prep
# ---------------------------------------------------------------------------
def hydrate_ideal_prep(p: Dict, approvals: List[Dict]) -> Dict:
    p = dict(p)
    p["id"] = str(p["id"])
    p["job_id"] = str(p["job_id"])
    if p.get("submitted_by"):
        p["submitted_by_id"] = str(p.pop("submitted_by"))
    p["submitted_date"] = iso(p.get("submitted_date"))
    p["approvals"] = [
        {"role": a["role"], "user_id": str(a["user_id"]) if a.get("user_id") else None,
         "user_name": a.get("user_name"), "decision": a["decision"], "date": iso(a["date"]), "comments": a.get("comments")}
        for a in approvals
    ]
    return p


@api.get("/jobs/{job_id}/ideal-prep")
async def list_ideal_prep(job_id: str, user: Dict = Depends(get_current_user)):
    row = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not row:
        raise HTTPException(404, "Not found")
    j = await hydrate_job(row)
    if not user_can_view_job(user, j):
        raise HTTPException(404, "Not found")
    ips = recs(await fetch("select * from ideal_prep where job_id = $1 order by version desc", job_id))
    out = []
    for ip in ips:
        approvals = recs(await fetch(
            "select a.*, p.name as user_name from ideal_prep_approvals a left join profiles p on p.id = a.user_id "
            "where a.ideal_prep_id = $1", ip["id"]))
        out.append(hydrate_ideal_prep(ip, approvals))
    return out


@api.post("/jobs/{job_id}/ideal-prep")
async def submit_ideal_prep(job_id: str, payload: IdealPrepIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    j = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not j:
        raise HTTPException(404, "Not found")
    crew = await get_job_crew(job_id)
    is_chief = any(str(c["user_id"]) == str(user["id"]) and c.get("is_crew_chief") for c in crew)
    if not (is_chief or "Administrator" in roles):
        raise HTTPException(403, "Only this job's crew chief or an Administrator may submit Ideal Prep")
    if j.get("prep_date"):
        deadline = datetime.combine(j["prep_date"] - timedelta(days=2), datetime.min.time(), tzinfo=timezone.utc).replace(hour=14)
        if datetime.now(timezone.utc) > deadline:
            raise HTTPException(400, "Ideal Prep amendment deadline has passed")
    existing_pending = rec(await fetchrow(
        "select ip.id from ideal_prep ip "
        "where ip.job_id = $1 and ip.submitted_by = $2 and ip.status = 'Pending' "
        "and not exists (select 1 from ideal_prep_approvals a where a.ideal_prep_id = ip.id and a.role = any($3::text[])) "
        "order by ip.version desc limit 1",
        job_id, user["id"], ["Project Manager", "Administrator"],
    ))
    if existing_pending:
        raise HTTPException(400, "You already have a pending Ideal Prep submission awaiting a decision — edit that one instead of submitting a new version")
    max_version = (await fetchrow("select coalesce(max(version), 0) as v from ideal_prep where job_id = $1", job_id))["v"]
    version_num = max_version + 1
    row = rec(await fetchrow(
        "insert into ideal_prep (job_id, version, submitted_by, submitted_date, equipment_requirements, timeline, "
        "special_requirements, notes, status) values ($1,$2,$3,$4,$5,$6,$7,$8,'Pending') returning *",
        job_id, version_num, user["id"], datetime.now(timezone.utc), payload.equipment_requirements,
        payload.timeline, payload.special_requirements or "", payload.notes or "",
    ))
    await log_audit(user, "submit_ideal_prep", job_id, {"version": version_num})
    recipients = []
    if j.get("project_manager_id"):
        recipients.append(str(j["project_manager_id"]))
    ops = recs(await fetch("select id from profiles where roles @> array['Operations Manager']::text[]"))
    recipients.extend(str(o["id"]) for o in ops)
    await notify_users(recipients, "New Ideal Prep", f"{user['name']} submitted Ideal Prep v{version_num} for {j['name']}", f"/jobs/{job_id}?tab=ideal-prep", "ideal-prep", job_id)
    return hydrate_ideal_prep(row, [])


@api.patch("/ideal-prep/{ip_id}")
async def edit_ideal_prep(ip_id: str, payload: IdealPrepIn, user: Dict = Depends(get_current_user)):
    """Lets the original submitter amend their own Ideal Prep in place, instead
    of creating a new version — but only while it's still Pending and no
    Project Manager (or Administrator, who can decide on a PM's behalf) has
    recorded a decision yet. This is the same 'PM-equivalent' rule already
    used to compute overall approval status in decide_ideal_prep."""
    doc = rec(await fetchrow("select * from ideal_prep where id = $1", ip_id))
    if not doc:
        raise HTTPException(404, "Not found")
    if not doc.get("submitted_by") or str(doc["submitted_by"]) != str(user["id"]):
        raise HTTPException(403, "Only the original submitter may edit this Ideal Prep")
    if doc["status"] != "Pending":
        raise HTTPException(400, "This Ideal Prep has already been decided and can no longer be edited")
    pm_decided = rec(await fetchrow(
        "select 1 from ideal_prep_approvals where ideal_prep_id = $1 and role = any($2::text[])",
        ip_id, ["Project Manager", "Administrator"],
    ))
    if pm_decided:
        raise HTTPException(400, "A Project Manager has already made a decision — this can no longer be edited")
    await execute(
        "update ideal_prep set equipment_requirements = $2, timeline = $3, special_requirements = $4, notes = $5 where id = $1",
        ip_id, payload.equipment_requirements, payload.timeline, payload.special_requirements or "", payload.notes or "",
    )
    await log_audit(user, "edit_ideal_prep", str(doc["job_id"]), {"ip_id": ip_id})
    row = rec(await fetchrow("select * from ideal_prep where id = $1", ip_id))
    approvals = recs(await fetch(
        "select a.*, p.name as user_name from ideal_prep_approvals a left join profiles p on p.id = a.user_id "
        "where a.ideal_prep_id = $1", ip_id))
    return hydrate_ideal_prep(row, approvals)


@api.post("/ideal-prep/{ip_id}/decision")
async def decide_ideal_prep(ip_id: str, payload: IdealPrepDecisionIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Project Manager", "Operations Manager", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    doc = rec(await fetchrow("select * from ideal_prep where id = $1", ip_id))
    if not doc:
        raise HTTPException(404, "Not found")
    j = rec(await fetchrow("select * from jobs where id = $1", doc["job_id"]))
    approver_role = None
    if "Project Manager" in roles and j.get("project_manager_id") and str(j["project_manager_id"]) == str(user["id"]):
        approver_role = "Project Manager"
    elif "Operations Manager" in roles:
        approver_role = "Operations Manager"
    elif "Administrator" in roles:
        approver_role = "Administrator"
    else:
        raise HTTPException(403, "Not authorised to approve")
    existing = rec(await fetchrow("select * from ideal_prep_approvals where ideal_prep_id = $1 and role = $2", ip_id, approver_role))
    if existing:
        raise HTTPException(400, f"Already decided by {approver_role}")
    await execute(
        "insert into ideal_prep_approvals (ideal_prep_id, role, user_id, decision, date, comments) values ($1,$2,$3,$4,$5,$6)",
        ip_id, approver_role, user["id"], payload.decision, datetime.now(timezone.utc), payload.comments,
    )
    approvals = recs(await fetch("select * from ideal_prep_approvals where ideal_prep_id = $1", ip_id))
    if any(a["decision"] == "Rejected" for a in approvals):
        new_status = "Rejected"
    else:
        pm_ok = any(a["role"] in ("Project Manager", "Administrator") and a["decision"] == "Approved" for a in approvals)
        ops_ok = any(a["role"] in ("Operations Manager", "Administrator") and a["decision"] == "Approved" for a in approvals)
        new_status = "Approved" if pm_ok and ops_ok else "Pending"
    await execute("update ideal_prep set status = $2 where id = $1", ip_id, new_status)
    await log_audit(user, f"ideal_prep_{payload.decision.lower()}", str(doc["job_id"]), {"ip_id": ip_id, "as_role": approver_role})
    if doc.get("submitted_by"):
        await notify_users([str(doc["submitted_by"])], f"Ideal Prep — {approver_role} {payload.decision}", f"v{doc['version']} for {j['name'] if j else ''}", f"/jobs/{doc['job_id']}?tab=ideal-prep", "ideal-prep", str(doc["job_id"]))
    return {"ok": True, "status": new_status}

# ---------------------------------------------------------------------------
# Faults
# ---------------------------------------------------------------------------
def hydrate_fault(f: Dict, comments: List[Dict]) -> Dict:
    f = dict(f)
    f["id"] = str(f["id"])
    f["job_id"] = str(f["job_id"]) if f.get("job_id") else None
    if f.get("reported_by"):
        f["reported_by_id"] = str(f.pop("reported_by"))
    if f.get("assigned_engineer_id"):
        f["assigned_engineer_id"] = str(f["assigned_engineer_id"])
    f["created_at"] = iso(f.get("created_at"))
    f["closed_at"] = iso(f.get("closed_at"))
    f["last_edited_at"] = iso(f.get("last_edited_at"))
    f["comments"] = [
        {"id": str(c["id"]), "created_by": c.get("created_by_name"), "created_by_id": str(c["created_by"]) if c.get("created_by") else None,
         "comment": c["comment"], "date": iso(c["date"])}
        for c in comments
    ]
    return f


@api.get("/faults")
async def list_faults(user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    query = FAULT_SELECT + " where f.status != 'Closed'"
    args = []
    if not roles.intersection({"Service Department", "Operations Manager", "Administrator", "Project Manager"}):
        args.append(user["id"])
        query += f" and f.reported_by = ${len(args)}"
    query += " order by f.created_at desc"
    rows = recs(await fetch(query, *args))
    if "Project Manager" in roles and not roles.intersection({"Administrator", "Operations Manager", "Service Department"}):
        pm_jobs = recs(await fetch("select id from jobs where project_manager_id = $1", user["id"]))
        allowed = {str(j["id"]) for j in pm_jobs}
        rows = [d for d in rows if d.get("job_id") and str(d["job_id"]) in allowed]
    out = []
    for f in rows:
        comments = recs(await fetch(
            "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
            "where c.fault_id = $1 order by c.date", f["id"]))
        out.append(hydrate_fault(f, comments))
    return out


@api.get("/faults/archive")
async def list_fault_archive(user: Dict = Depends(get_current_user)):
    """Closed faults move here from the main list — viewable by all Service
    Department members (not just Admin/Ops/PM as the main list restricts for
    non-privileged reporters), since this is their shared repair history."""
    roles = set(user.get("roles", []))
    if not roles.intersection({"Service Department", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    rows = recs(await fetch(FAULT_SELECT + " where f.status = 'Closed' order by f.closed_at desc limit 500"))
    out = []
    for f in rows:
        comments = recs(await fetch(
            "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
            "where c.fault_id = $1 order by c.date", f["id"]))
        out.append(hydrate_fault(f, comments))
    return out


@api.get("/jobs/{job_id}/faults")
async def list_job_faults(job_id: str, user: Dict = Depends(get_current_user)):
    row = rec(await fetchrow("select * from jobs where id = $1", job_id))
    if not row:
        raise HTTPException(404, "Not found")
    j = await hydrate_job(row)
    if not user_can_view_job(user, j):
        raise HTTPException(404, "Not found")
    rows = recs(await fetch(FAULT_SELECT + " where f.job_id = $1 order by f.created_at desc", job_id))
    out = []
    for f in rows:
        comments = recs(await fetch(
            "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
            "where c.fault_id = $1 order by c.date", f["id"]))
        out.append(hydrate_fault(f, comments))
    return out


@api.post("/faults")
async def create_fault(payload: FaultIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Crew Member", "Service Department", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    equipment = rec(await fetchrow("select * from equipment where barcode = $1", payload.equipment_barcode))
    if not equipment:
        raise HTTPException(400, "Unknown equipment barcode")
    j = rec(await fetchrow("select * from jobs where id = $1", payload.job_id))
    if not j:
        raise HTTPException(404, "Job not found — faults must be reported against a specific job")
    row = rec(await fetchrow(
        "insert into faults (job_id, equipment_barcode, fixture_type, description, can_be_used, photos, videos, "
        "additional_comments, reported_by, status, created_at) "
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Open',$10) returning *",
        payload.job_id, payload.equipment_barcode, equipment["fixture_type"], payload.description,
        payload.can_be_used, payload.photos, payload.videos, payload.additional_comments or "",
        user["id"], datetime.now(timezone.utc),
    ))
    row["reported_by_name"] = user.get("name")
    row["job_name"] = j.get("name")
    await log_audit(user, "create_fault", str(row["id"]), {"barcode": payload.equipment_barcode})
    services = recs(await fetch(
        "select id from profiles where roles && array['Service Department','Operations Manager']::text[]"))
    recipients = [str(s["id"]) for s in services]
    if j.get("project_manager_id"):
        recipients.append(str(j["project_manager_id"]))
    await notify_users(recipients, "New fault reported", f"{equipment['fixture_type']} ({payload.equipment_barcode})", f"/faults/{row['id']}", "fault", payload.job_id)
    return hydrate_fault(row, [])


@api.get("/faults/{fault_id}")
async def get_fault(fault_id: str, user: Dict = Depends(get_current_user)):
    f = rec(await fetchrow(FAULT_SELECT + " where f.id = $1", fault_id))
    if not f:
        raise HTTPException(404, "Not found")
    comments = recs(await fetch(
        "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
        "where c.fault_id = $1 order by c.date", fault_id))
    return hydrate_fault(f, comments)


@api.patch("/faults/{fault_id}/report")
async def edit_fault_report(fault_id: str, payload: FaultReportEditIn, user: Dict = Depends(get_current_user)):
    f = rec(await fetchrow(FAULT_SELECT + " where f.id = $1", fault_id))
    if not f:
        raise HTTPException(404, "Not found")
    roles = set(user.get("roles", []))
    is_reporter = f.get("reported_by") and str(f["reported_by"]) == str(user["id"])
    is_admin = "Administrator" in roles
    if not (is_reporter or is_admin):
        raise HTTPException(403, "Only the reporter may amend this report")
    if f.get("severity"):
        raise HTTPException(400, "Report is locked — a severity has already been assigned")
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        comments = recs(await fetch(
            "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
            "where c.fault_id = $1 order by c.date", fault_id))
        return hydrate_fault(f, comments)
    updates["last_edited_at"] = datetime.now(timezone.utc)
    updates["last_edited_by"] = user.get("name")
    set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    await execute(f"update faults set {set_clause} where id = $1", fault_id, *updates.values())
    await log_audit(user, "edit_fault_report", fault_id, {k: str(v) for k, v in updates.items()})
    updated = rec(await fetchrow(FAULT_SELECT + " where f.id = $1", fault_id))
    comments = recs(await fetch(
        "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
        "where c.fault_id = $1 order by c.date", fault_id))
    return hydrate_fault(updated, comments)


@api.patch("/faults/{fault_id}")
async def update_fault(fault_id: str, payload: FaultUpdateIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Service Department", "Operations Manager", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    f = rec(await fetchrow(FAULT_SELECT + " where f.id = $1", fault_id))
    if not f:
        raise HTTPException(404, "Not found")
    updates: Dict[str, Any] = {}
    if payload.status:
        if payload.status not in FAULT_STATUSES:
            raise HTTPException(400, "Invalid status")
        if payload.status in FAULT_AUTO_ONLY_STATUSES:
            raise HTTPException(400, f"'{payload.status}' is set automatically by the system and cannot be chosen manually")
        if payload.status == "Closed":
            has_both = {"Service Department", "Operations Manager"}.issubset(roles)
            if not (has_both or "Administrator" in roles):
                raise HTTPException(403, "Closing a fault requires both Service Department and Operations Manager roles")
        updates["status"] = payload.status
        if payload.status == "Closed":
            updates["closed_at"] = datetime.now(timezone.utc)
    if payload.severity:
        if payload.severity not in FAULT_SEVERITY:
            raise HTTPException(400, "Invalid severity")
        updates["severity"] = payload.severity
    if payload.assigned_engineer_id:
        is_admin = "Administrator" in roles
        has_both = {"Service Department", "Operations Manager"}.issubset(roles)
        is_self = str(payload.assigned_engineer_id) == str(user["id"])
        can_self_assign = "Service Department" in roles and is_self

        if not (is_admin or has_both or can_self_assign):
            raise HTTPException(403, "Service Department users may only assign faults to themselves — assigning to others requires both Service Department and Operations Manager roles")

        if not is_admin and not is_self:
            target = rec(await fetchrow("select roles from profiles where id = $1", payload.assigned_engineer_id))
            if not target or "Service Department" not in (target.get("roles") or []):
                raise HTTPException(400, "Assigned engineer must hold the Service Department role")

        updates["assigned_engineer_id"] = payload.assigned_engineer_id
        # First assignment automatically moves a fault out of Open into Under
        # Assessment — but don't regress a fault that's already progressed further.
        if f.get("status") == "Open" and "status" not in updates:
            updates["status"] = "Under Assessment"
    if payload.reopen:
        updates["status"] = "Open"
        updates["closed_at"] = None
    if updates:
        set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
        await execute(f"update faults set {set_clause} where id = $1", fault_id, *updates.values())
        await log_audit(user, "update_fault", fault_id, {k: str(v) for k, v in updates.items()})
    updated = rec(await fetchrow(FAULT_SELECT + " where f.id = $1", fault_id))
    comments = recs(await fetch(
        "select c.*, p.name as created_by_name from fault_comments c left join profiles p on p.id = c.created_by "
        "where c.fault_id = $1 order by c.date", fault_id))
    return hydrate_fault(updated, comments)


@api.post("/faults/{fault_id}/comments")
async def add_fault_comment(fault_id: str, payload: FaultCommentIn, user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    if not roles.intersection({"Service Department", "Operations Manager", "Administrator"}):
        raise HTTPException(403, "Forbidden")
    row = rec(await fetchrow(
        "insert into fault_comments (fault_id, created_by, comment, date) values ($1,$2,$3,$4) returning *",
        fault_id, user["id"], payload.comment, datetime.now(timezone.utc),
    ))
    return {"id": str(row["id"]), "created_by": user.get("name"), "created_by_id": str(user["id"]), "comment": row["comment"], "date": iso(row["date"])}


# ---------------------------------------------------------------------------
# Fault time logs & parts ordered — internal-only (Service Department,
# Operations Manager, Account Manager, Project Manager, Administrator).
# Deliberately NOT included in get_fault()'s response, so the reporting user
# (or anyone else) never sees this data unless they hold one of those roles,
# even by inspecting the main fault payload.
# ---------------------------------------------------------------------------
FAULT_LOG_VIEW_ROLES = {"Service Department", "Operations Manager", "Account Manager", "Project Manager"}


def require_fault_log_view(user: Dict = Depends(get_current_user)) -> Dict:
    roles = set(user.get("roles", []))
    if "Administrator" in roles or roles.intersection(FAULT_LOG_VIEW_ROLES):
        return user
    raise HTTPException(403, "Forbidden")


def require_fault_log_edit(user: Dict = Depends(get_current_user)) -> Dict:
    roles = set(user.get("roles", []))
    if "Administrator" in roles or "Service Department" in roles:
        return user
    raise HTTPException(403, "Forbidden")


@api.get("/faults/{fault_id}/time-logs")
async def list_fault_time_logs(fault_id: str, user: Dict = Depends(require_fault_log_view)):
    rows = recs(await fetch("select * from fault_time_logs where fault_id = $1 order by log_date desc, created_at desc", fault_id))
    for r in rows:
        r["id"] = str(r["id"])
        r["fault_id"] = str(r["fault_id"])
        r["user_id"] = str(r["user_id"]) if r.get("user_id") else None
        r["log_date"] = iso(r["log_date"])
        r["created_at"] = iso(r["created_at"])
    return rows


@api.post("/faults/{fault_id}/time-logs")
async def create_fault_time_log(fault_id: str, payload: FaultTimeLogIn, user: Dict = Depends(require_fault_log_edit)):
    fault = rec(await fetchrow("select id from faults where id = $1", fault_id))
    if not fault:
        raise HTTPException(404, "Fault not found")
    log_date = date.fromisoformat(payload.log_date) if payload.log_date else datetime.now(timezone.utc).date()
    row = rec(await fetchrow(
        "insert into fault_time_logs (fault_id, user_id, user_name, hours, description, log_date) "
        "values ($1,$2,$3,$4,$5,$6) returning *",
        fault_id, user["id"], user.get("name"), payload.hours, payload.description, log_date,
    ))
    await log_audit(user, "add_fault_time_log", fault_id, {"hours": payload.hours})
    row["id"] = str(row["id"])
    row["fault_id"] = str(row["fault_id"])
    row["user_id"] = str(row["user_id"]) if row.get("user_id") else None
    row["log_date"] = iso(row["log_date"])
    row["created_at"] = iso(row["created_at"])
    return row


@api.delete("/faults/{fault_id}/time-logs/{log_id}")
async def delete_fault_time_log(fault_id: str, log_id: str, user: Dict = Depends(require_fault_log_edit)):
    await execute("delete from fault_time_logs where id = $1 and fault_id = $2", log_id, fault_id)
    await log_audit(user, "delete_fault_time_log", log_id)
    return {"ok": True}


@api.get("/faults/{fault_id}/parts")
async def list_fault_parts(fault_id: str, user: Dict = Depends(require_fault_log_view)):
    rows = recs(await fetch("select * from fault_parts_ordered where fault_id = $1 order by created_at desc", fault_id))
    for r in rows:
        r["id"] = str(r["id"])
        r["fault_id"] = str(r["fault_id"])
        r["created_by"] = str(r["created_by"]) if r.get("created_by") else None
        r["order_date"] = iso(r["order_date"])
        r["created_at"] = iso(r["created_at"])
    return rows


@api.post("/faults/{fault_id}/parts")
async def create_fault_part(fault_id: str, payload: FaultPartIn, user: Dict = Depends(require_fault_log_edit)):
    fault = rec(await fetchrow("select * from faults where id = $1", fault_id))
    if not fault:
        raise HTTPException(404, "Fault not found")
    order_date = date.fromisoformat(payload.order_date) if payload.order_date else datetime.now(timezone.utc).date()
    row = rec(await fetchrow(
        "insert into fault_parts_ordered (fault_id, part_name, quantity, cost, order_date, status, notes, created_by, created_by_name) "
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *",
        fault_id, payload.part_name, payload.quantity, payload.cost, order_date, payload.status, payload.notes or "",
        user["id"], user.get("name"),
    ))
    # Ordering a part (still pending) automatically flags the fault as
    # waiting on parts — unless it's already closed.
    if payload.status == "Ordered" and fault.get("status") != "Closed":
        await execute("update faults set status = 'Awaiting Parts' where id = $1", fault_id)
    await log_audit(user, "add_fault_part", fault_id, {"part_name": payload.part_name})
    row["id"] = str(row["id"])
    row["fault_id"] = str(row["fault_id"])
    row["created_by"] = str(row["created_by"]) if row.get("created_by") else None
    row["order_date"] = iso(row["order_date"])
    row["created_at"] = iso(row["created_at"])
    return row


@api.patch("/faults/{fault_id}/parts/{part_id}")
async def update_fault_part(fault_id: str, part_id: str, payload: FaultPartUpdateIn, user: Dict = Depends(require_fault_log_edit)):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if updates:
        set_clause = ", ".join(f"{k} = ${i + 3}" for i, k in enumerate(updates))
        row = rec(await fetchrow(
            f"update fault_parts_ordered set {set_clause} where id = $1 and fault_id = $2 returning *",
            part_id, fault_id, *updates.values(),
        ))
    else:
        row = rec(await fetchrow("select * from fault_parts_ordered where id = $1 and fault_id = $2", part_id, fault_id))
    if not row:
        raise HTTPException(404, "Not found")
    # Once every part for this fault is Received (none still Ordered), the
    # fault automatically moves to Parts Received — unless already closed.
    if updates.get("status") == "Received":
        fault = rec(await fetchrow("select * from faults where id = $1", fault_id))
        still_pending = rec(await fetchrow(
            "select 1 from fault_parts_ordered where fault_id = $1 and status = 'Ordered'", fault_id
        ))
        if fault and fault.get("status") != "Closed" and not still_pending:
            await execute("update faults set status = 'Parts Received' where id = $1", fault_id)
    await log_audit(user, "update_fault_part", part_id, updates)
    row["id"] = str(row["id"])
    row["fault_id"] = str(row["fault_id"])
    row["created_by"] = str(row["created_by"]) if row.get("created_by") else None
    row["order_date"] = iso(row["order_date"])
    row["created_at"] = iso(row["created_at"])
    return row


@api.delete("/faults/{fault_id}/parts/{part_id}")
async def delete_fault_part(fault_id: str, part_id: str, user: Dict = Depends(require_fault_log_edit)):
    await execute("delete from fault_parts_ordered where id = $1 and fault_id = $2", part_id, fault_id)
    await log_audit(user, "delete_fault_part", part_id)
    return {"ok": True}


@api.delete("/faults/{fault_id}")
async def delete_fault(fault_id: str, user: Dict = Depends(require_roles("Administrator"))):
    existing = rec(await fetchrow("select * from faults where id = $1", fault_id))
    if not existing:
        raise HTTPException(404, "Not found")
    await execute("delete from faults where id = $1", fault_id)
    await log_audit(user, "delete_fault", fault_id, {"equipment_barcode": existing.get("equipment_barcode")})
    return {"ok": True}

# ---------------------------------------------------------------------------
# Equipment
# ---------------------------------------------------------------------------
@api.get("/equipment/search")
async def search_equipment(q: str = "", user: Dict = Depends(get_current_user)):
    pattern = f"%{q}%" if q else "%"
    rows = recs(await fetch(
        "select * from equipment where barcode ilike $1 or fixture_type ilike $1 "
        "order by fixture_type, barcode limit 500",
        pattern,
    ))
    for r in rows:
        r["id"] = str(r["id"])
        r["created_at"] = iso(r["created_at"])
    return rows


@api.get("/equipment/types")
async def search_equipment_types(q: str = "", user: Dict = Depends(get_current_user)):
    """Equipment grouped by fixture type with a unit count — for the search
    page, so 60 individual 'Robe MegaPointe' units show as one tile."""
    pattern = f"%{q}%" if q else "%"
    rows = await fetch(
        "select fixture_type, count(*) as unit_count from equipment "
        "where fixture_type ilike $1 or barcode ilike $1 "
        "group by fixture_type order by fixture_type limit 200",
        pattern,
    )
    return [{"fixture_type": r["fixture_type"], "unit_count": r["unit_count"]} for r in rows]


@api.get("/equipment/by-type")
async def get_equipment_by_type(fixture_type: str, user: Dict = Depends(get_current_user)):
    """All individual units (barcodes) of a given fixture type, plus combined
    fault history across all of them."""
    units = recs(await fetch("select * from equipment where fixture_type = $1 order by barcode", fixture_type))
    if not units:
        raise HTTPException(404, "Not found")
    for u in units:
        u["id"] = str(u["id"])
        u["created_at"] = iso(u["created_at"])
    barcodes = [u["barcode"] for u in units]
    fault_rows = recs(await fetch(
        FAULT_SELECT + " where f.equipment_barcode = any($1::text[]) order by f.created_at desc limit 200", barcodes,
    ))
    faults = [hydrate_fault(f, []) for f in fault_rows]
    roles = set(user.get("roles", []))
    if not roles.intersection({"Service Department", "Operations Manager", "Project Manager", "Administrator"}):
        faults = [f for f in faults if f.get("reported_by_id") == str(user["id"])]
    specs = rec(await fetchrow("select * from equipment_specs where fixture_type = $1", fixture_type))
    specs_out = {
        "weight_kg": specs["weight_kg"] if specs else None,
        "width_cm": specs["width_cm"] if specs else None,
        "height_cm": specs["height_cm"] if specs else None,
        "depth_cm": specs["depth_cm"] if specs else None,
    } if specs else {"weight_kg": None, "width_cm": None, "height_cm": None, "depth_cm": None}
    return {"fixture_type": fixture_type, "units": units, "faults": faults, "specs": specs_out}


@api.patch("/equipment/specs")
async def update_equipment_specs(fixture_type: str, payload: EquipmentSpecsIn, user: Dict = Depends(require_roles("Administrator"))):
    await execute(
        "insert into equipment_specs (fixture_type, weight_kg, width_cm, height_cm, depth_cm) "
        "values ($1,$2,$3,$4,$5) "
        "on conflict (fixture_type) do update set weight_kg = $2, width_cm = $3, height_cm = $4, depth_cm = $5",
        fixture_type, payload.weight_kg, payload.width_cm, payload.height_cm, payload.depth_cm,
    )
    await log_audit(user, "update_equipment_specs", fixture_type)
    return {"ok": True}


@api.get("/equipment/fixture-types")
async def search_fixture_types(q: str = "", user: Dict = Depends(get_current_user)):
    """Distinct equipment fixture types matching a query — used by Prep Adds
    item selection, where users pick a type of equipment (not one specific
    serialized unit), so raw equipment rows would show many duplicates."""
    if not q:
        return []
    rows = await fetch(
        "select distinct fixture_type from equipment where fixture_type ilike $1 order by fixture_type limit 20",
        f"%{q}%",
    )
    return [r["fixture_type"] for r in rows]


@api.get("/equipment/{barcode}")
async def get_equipment(barcode: str, user: Dict = Depends(get_current_user)):
    e = rec(await fetchrow("select * from equipment where barcode = $1", barcode))
    if not e:
        raise HTTPException(404, "Not found")
    e["id"] = str(e["id"])
    e["created_at"] = iso(e["created_at"])
    fault_rows = recs(await fetch(FAULT_SELECT + " where f.equipment_barcode = $1 order by f.created_at desc limit 50", barcode))
    faults = [hydrate_fault(f, []) for f in fault_rows]
    roles = set(user.get("roles", []))
    if not roles.intersection({"Service Department", "Operations Manager", "Project Manager", "Administrator"}):
        faults = [f for f in faults if f.get("reported_by_id") == str(user["id"])]
    return {"equipment": e, "faults": faults}

# ---------------------------------------------------------------------------
# Building info
# ---------------------------------------------------------------------------
@api.get("/building-info")
async def get_building_info(user: Dict = Depends(get_current_user)):
    doc = rec(await fetchrow("select * from building_info where id = 'singleton'"))
    contacts = recs(await fetch("select * from contacts"))
    for c in contacts:
        c["id"] = str(c["id"])
    return {
        "wifi": (doc or {}).get("wifi", {}),
        "contacts": contacts,
        "map_zones": (doc or {}).get("map_zones", []),
        "map_width": (doc or {}).get("map_width", 700),
        "map_height": (doc or {}).get("map_height", 340),
        "map_background_url": (doc or {}).get("map_background_url"),
    }


@api.patch("/building-info/wifi")
async def update_wifi(payload: WifiIn, user: Dict = Depends(require_roles("Administrator"))):
    await execute(
        "insert into building_info (id, wifi) values ('singleton', $1) "
        "on conflict (id) do update set wifi = $1",
        payload.model_dump(),
    )
    await log_audit(user, "update_wifi")
    return {"ok": True}


@api.patch("/building-info/map-zones")
async def update_map_zones(payload: MapZonesIn, user: Dict = Depends(require_roles("Administrator"))):
    ids = [z.id for z in payload.zones]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "Zone IDs must be unique")
    zones = [z.model_dump() for z in payload.zones]
    await execute(
        "insert into building_info (id, map_zones, map_width, map_height) values ('singleton', $1, $2, $3) "
        "on conflict (id) do update set map_zones = $1, map_width = $2, map_height = $3",
        zones, payload.map_width, payload.map_height,
    )
    await log_audit(user, "update_map_zones", extra={"zone_count": len(zones), "map_width": payload.map_width, "map_height": payload.map_height})
    return {"ok": True, "zones": zones, "map_width": payload.map_width, "map_height": payload.map_height}


MAP_BACKGROUND_BUCKET = "building-map"
MAP_BACKGROUND_ALLOWED_EXT = {"png", "jpg", "jpeg", "webp", "gif"}
MAP_BACKGROUND_MAX_BYTES = 5 * 1024 * 1024  # 5MB


@api.post("/building-info/map-background")
async def upload_map_background(file: UploadFile = File(...), user: Dict = Depends(require_roles("Administrator"))):
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")
    contents = await file.read()
    if len(contents) > MAP_BACKGROUND_MAX_BYTES:
        raise HTTPException(400, "Image must be under 5MB")
    ext = (file.filename or "image").rsplit(".", 1)[-1].lower()
    if ext not in MAP_BACKGROUND_ALLOWED_EXT:
        ext = "png"
    object_path = f"map-background-{secrets.token_hex(8)}.{ext}"
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/{MAP_BACKGROUND_BUCKET}/{object_path}",
            content=contents,
            headers={
                "apikey": SUPABASE_SECRET_KEY,
                "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
                "Content-Type": file.content_type,
            },
        )
    if r.status_code >= 400:
        raise HTTPException(502, f"Image upload to storage failed: {r.status_code} {r.text}")
    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{MAP_BACKGROUND_BUCKET}/{object_path}"
    await execute(
        "insert into building_info (id, map_background_url) values ('singleton', $1) "
        "on conflict (id) do update set map_background_url = $1",
        public_url,
    )
    await log_audit(user, "upload_map_background")
    return {"ok": True, "url": public_url}


@api.delete("/building-info/map-background")
async def remove_map_background(user: Dict = Depends(require_roles("Administrator"))):
    await execute("update building_info set map_background_url = null where id = 'singleton'")
    await log_audit(user, "remove_map_background")
    return {"ok": True}


@api.post("/building-info/contacts")
async def add_contact(payload: ContactIn, user: Dict = Depends(require_roles("Administrator"))):
    row = rec(await fetchrow(
        "insert into contacts (label, name, phone, email) values ($1,$2,$3,$4) returning *",
        payload.label, payload.name, payload.phone, payload.email or "",
    ))
    row["id"] = str(row["id"])
    await log_audit(user, "add_contact", row["id"])
    return row


@api.delete("/building-info/contacts/{contact_id}")
async def delete_contact(contact_id: str, user: Dict = Depends(require_roles("Administrator"))):
    await execute("delete from contacts where id = $1", contact_id)
    await log_audit(user, "delete_contact", contact_id)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Notifications & push
# ---------------------------------------------------------------------------
@api.get("/notifications")
async def list_notifications(user: Dict = Depends(get_current_user)):
    rows = recs(await fetch("select * from notifications where user_id = $1 order by created_at desc limit 100", user["id"]))
    for r in rows:
        r["id"] = str(r["id"])
        r["user_id"] = str(r["user_id"])
        r["related_job"] = str(r["related_job"]) if r.get("related_job") else None
        r["created_at"] = iso(r["created_at"])
    return rows


@api.post("/notifications/{notif_id}/read")
async def mark_read(notif_id: str, user: Dict = Depends(get_current_user)):
    await execute("update notifications set read = true where id = $1 and user_id = $2", notif_id, user["id"])
    return {"ok": True}


@api.post("/notifications/read-all")
async def mark_all_read(user: Dict = Depends(get_current_user)):
    await execute("update notifications set read = true where user_id = $1 and read = false", user["id"])
    return {"ok": True}


@api.delete("/notifications/{notif_id}")
async def delete_notification(notif_id: str, user: Dict = Depends(get_current_user)):
    await execute("delete from notifications where id = $1 and user_id = $2", notif_id, user["id"])
    return {"ok": True}


@api.post("/notifications/test-broadcast")
async def test_broadcast_notification(user: Dict = Depends(require_roles("Administrator"))):
    """Admin-only: sends a test notification (including push, for any subscribed
    device) to every user in the system — for verifying push delivery end-to-end."""
    all_users = recs(await fetch("select id from profiles"))
    user_ids = [str(u["id"]) for u in all_users]
    await notify_users(user_ids, "Test Notification", "THIS IS A TEST", link="/notifications", type_="info")
    await log_audit(user, "test_broadcast_notification", extra={"recipient_count": len(user_ids)})
    return {"ok": True, "recipient_count": len(user_ids)}


@api.post("/push/subscribe")
async def push_subscribe(payload: PushSubscribeIn, user: Dict = Depends(get_current_user)):
    endpoint = payload.subscription.get("endpoint")
    await execute(
        "insert into push_subscriptions (user_id, endpoint, subscription, created_at) values ($1,$2,$3,$4) "
        "on conflict (user_id, endpoint) do update set subscription = $3, created_at = $4",
        user["id"], endpoint, payload.subscription, datetime.now(timezone.utc),
    )
    return {"ok": True}


@api.post("/push/unsubscribe")
async def push_unsubscribe(payload: PushSubscribeIn, user: Dict = Depends(get_current_user)):
    endpoint = payload.subscription.get("endpoint")
    await execute("delete from push_subscriptions where user_id = $1 and endpoint = $2", user["id"], endpoint)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Global search
# ---------------------------------------------------------------------------
@api.get("/search")
async def global_search(q: str = "", user: Dict = Depends(get_current_user)):
    if not q or len(q) < 2:
        return {"jobs": [], "equipment": [], "users": []}
    like = f"%{q}%"
    job_rows = recs(await fetch(JOB_SELECT + " where j.name ilike $1 or j.winhits_number ilike $1 limit 20", like))
    jobs = await hydrate_jobs_batch(job_rows)
    jobs = [j for j in jobs if user_can_view_job(user, j)]
    equip = recs(await fetch("select * from equipment where barcode ilike $1 or fixture_type ilike $1 limit 20", like))
    for e in equip:
        e["id"] = str(e["id"])
        e["created_at"] = iso(e["created_at"])
    users = []
    roles = set(user.get("roles", []))
    if roles.intersection({"Administrator", "Project Manager", "Operations Manager"}):
        us = recs(await fetch("select * from profiles where name ilike $1 or email ilike $1 limit 20", like))
        users = [sanitize_user(u) for u in us]
    return {"jobs": jobs, "equipment": equip, "users": users}

# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------
@api.get("/audit-log")
async def audit_log_route(user: Dict = Depends(require_roles("Administrator"))):
    rows = recs(await fetch("select * from audit_log order by date desc limit 500"))
    for r in rows:
        r["id"] = str(r["id"])
        r["user_id"] = str(r["user_id"]) if r.get("user_id") else None
        r["date"] = iso(r["date"])
    return rows

# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@api.get("/dashboard")
async def dashboard(view: Optional[str] = Query(None), user: Dict = Depends(get_current_user)):
    roles = set(user.get("roles", []))
    is_service_only = roles == {"Service Department"}
    has_both_ops_service = {"Operations Manager", "Service Department"}.issubset(roles)
    show_service_view = is_service_only or (has_both_ops_service and view == "service")

    alerts = recs(await fetch(
        "select * from notifications where user_id = $1 and read = false order by created_at desc limit 20", user["id"]))
    for a in alerts:
        a["id"] = str(a["id"])
        a["user_id"] = str(a["user_id"])
        a["related_job"] = str(a["related_job"]) if a.get("related_job") else None
        a["created_at"] = iso(a["created_at"])

    if show_service_view:
        my_repair_rows = recs(await fetch(
            FAULT_SELECT + " where f.assigned_engineer_id = $1 and f.status != 'Closed' order by f.created_at desc limit 20",
            user["id"],
        ))
        fault_report_rows = recs(await fetch(
            FAULT_SELECT + " where f.status != 'Closed' order by f.created_at desc limit 20"
        ))
        quick_link_rows = recs(await fetch("select * from quick_links order by created_at"))
        for q in quick_link_rows:
            q["id"] = str(q["id"])
            q["created_at"] = iso(q["created_at"])
            if q.get("created_by"):
                q["created_by"] = str(q["created_by"])
        return {
            "view": "service",
            "user": sanitize_user(user),
            "my_repairs": [hydrate_fault(f, []) for f in my_repair_rows],
            "fault_reports": [hydrate_fault(f, []) for f in fault_report_rows],
            "alerts": alerts,
            "quick_links": quick_link_rows,
            "can_edit_quick_links": has_both_ops_service,
            "can_switch_view": has_both_ops_service,
        }

    today = datetime.now(timezone.utc).date()
    rows = recs(await fetch(JOB_SELECT + " order by j.prep_date asc"))
    my_jobs = await hydrate_jobs_batch(rows)
    my_jobs = [j for j in my_jobs if user_can_view_job(user, j)]
    current, upcoming = None, []
    for j in my_jobs:
        prep_d = j.get("prep_date")
        ret_d = j.get("return_date") or prep_d
        if prep_d and prep_d <= today.isoformat() <= (ret_d or prep_d):
            current = current or j
        elif prep_d and prep_d >= today.isoformat():
            upcoming.append(j)
    next_job = current or (upcoming[0] if upcoming else None)
    extras: Dict[str, Any] = {}
    if roles.intersection({"Project Manager", "Administrator"}):
        pending_prep = (await fetchrow("select count(*) as c from prep_adds where status = 'Pending'"))["c"]
        pending_ideal = (await fetchrow("select count(*) as c from ideal_prep where status = 'Pending'"))["c"]
        my_order_jobs = [j for j in my_jobs if j.get("status") == "Order"]
        extras["pending_prep_adds"] = pending_prep
        extras["pending_ideal_prep"] = pending_ideal
        extras["order_jobs"] = my_order_jobs[:10]
    if "Operations Manager" in roles:
        all_orders_rows = recs(await fetch(JOB_SELECT + " where j.status = 'Order' limit 50"))
        all_orders = await hydrate_jobs_batch(all_orders_rows)
        extras["order_jobs"] = all_orders[:10]
    if "Service Department" in roles:
        open_rows = recs(await fetch(FAULT_SELECT + " where f.status != 'Closed' order by f.created_at desc limit 20"))
        closed_rows = recs(await fetch(FAULT_SELECT + " where f.status = 'Closed' order by f.closed_at desc limit 10"))
        extras["open_faults"] = [hydrate_fault(f, []) for f in open_rows]
        extras["closed_faults"] = [hydrate_fault(f, []) for f in closed_rows]
    if "Administrator" in roles:
        extras["user_count"] = (await fetchrow("select count(*) as c from profiles"))["c"]
        extras["active_jobs"] = (await fetchrow("select count(*) as c from jobs where status = 'Order'"))["c"]
    return {
        "view": "standard",
        "user": sanitize_user(user), "current_or_next_job": next_job,
        "upcoming_jobs": [j for j in upcoming if j != next_job][:10],
        "alerts": alerts, "extras": extras,
        "can_switch_view": has_both_ops_service,
    }


class QuickLinkIn(BaseModel):
    label: str
    url: str


def require_ops_and_service(user: Dict = Depends(get_current_user)) -> Dict:
    roles = set(user.get("roles", []))
    if "Administrator" in roles:
        return user
    if not {"Operations Manager", "Service Department"}.issubset(roles):
        raise HTTPException(403, "Requires both Operations Manager and Service Department roles")
    return user


@api.post("/quick-links")
async def create_quick_link(payload: QuickLinkIn, user: Dict = Depends(require_ops_and_service)):
    if not payload.label.strip() or not payload.url.strip():
        raise HTTPException(400, "Label and URL are required")
    row = rec(await fetchrow(
        "insert into quick_links (label, url, created_by) values ($1,$2,$3) returning *",
        payload.label.strip(), payload.url.strip(), user["id"],
    ))
    row["id"] = str(row["id"])
    row["created_at"] = iso(row["created_at"])
    row["created_by"] = str(row["created_by"]) if row.get("created_by") else None
    await log_audit(user, "create_quick_link", row["id"], {"label": payload.label})
    return row


@api.delete("/quick-links/{link_id}")
async def delete_quick_link(link_id: str, user: Dict = Depends(require_ops_and_service)):
    await execute("delete from quick_links where id = $1", link_id)
    await log_audit(user, "delete_quick_link", link_id)
    return {"ok": True}


@api.get("/")
async def root():
    return {"service": "PRG Job Portal API", "status": "online"}

app.include_router(api)