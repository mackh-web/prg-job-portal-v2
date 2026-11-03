"""PRG Job Portal — Backend Regression Tests.

Covers auth (login, /me, forgot-password, vapid), users/invite, jobs, prep-adds,
ideal-prep, faults, equipment, building info, notifications, search, audit-log,
dashboard, and role permissions.

Uses public REACT_APP_BACKEND_URL. All test data is prefixed with TEST_ where
possible for identification. HttpOnly cookies are exchanged via requests.Session.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:3000").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "mackenzie.hardman@prg.com"
ADMIN_PASSWORD = "PRGMusicAdmin1!"
CREW_CHIEF_EMAIL = "tom.crew@prg.com"
OPS_EMAIL = "jenny.ops@prg.com"
PM_EMAIL = "alex.pm@prg.com"
CREW_EMAIL = "chris.crew@prg.com"
SERVICE_EMAIL = "ravi.service@prg.com"
STD_PASSWORD = "Password1!"


def _login(session: requests.Session, email: str, password: str) -> requests.Response:
    return session.post(f"{API}/auth/login", json={"email": email, "password": password})


@pytest.fixture(scope="session")
def admin_session() -> requests.Session:
    s = requests.Session()
    r = _login(s, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="session")
def crew_chief_session() -> requests.Session:
    s = requests.Session()
    r = _login(s, CREW_CHIEF_EMAIL, STD_PASSWORD)
    assert r.status_code == 200, f"crew chief login failed: {r.text}"
    return s


@pytest.fixture(scope="session")
def ops_session() -> requests.Session:
    s = requests.Session()
    r = _login(s, OPS_EMAIL, STD_PASSWORD)
    assert r.status_code == 200
    return s


@pytest.fixture(scope="session")
def pm_session() -> requests.Session:
    s = requests.Session()
    r = _login(s, PM_EMAIL, STD_PASSWORD)
    assert r.status_code == 200
    return s


@pytest.fixture(scope="session")
def crew_member_session() -> requests.Session:
    s = requests.Session()
    r = _login(s, CREW_EMAIL, STD_PASSWORD)
    assert r.status_code == 200
    return s


@pytest.fixture(scope="session")
def service_session() -> requests.Session:
    s = requests.Session()
    r = _login(s, SERVICE_EMAIL, STD_PASSWORD)
    assert r.status_code == 200
    return s


# ------------------------------- Health & Auth -------------------------------
class TestHealth:
    def test_root(self):
        r = requests.get(f"{API}/")
        assert r.status_code == 200
        d = r.json()
        assert d.get("service") == "PRG Job Portal API"
        assert d.get("status") == "online"


class TestAuth:
    def test_admin_login_sets_cookies(self):
        s = requests.Session()
        r = _login(s, ADMIN_EMAIL, ADMIN_PASSWORD)
        assert r.status_code == 200
        body = r.json()
        assert body["user"]["email"] == ADMIN_EMAIL
        roles = set(body["user"]["roles"])
        assert {"Administrator", "Project Manager"}.issubset(roles)
        # httpOnly cookies set
        cookie_names = {c.name for c in s.cookies}
        assert "access_token" in cookie_names
        assert "refresh_token" in cookie_names

    def test_me_returns_admin(self, admin_session):
        r = admin_session.get(f"{API}/auth/me")
        assert r.status_code == 200
        d = r.json()
        assert d["email"] == ADMIN_EMAIL
        assert d["name"] == "Mack H"

    def test_login_bad_password(self):
        s = requests.Session()
        r = _login(s, ADMIN_EMAIL, "wrong-password")
        assert r.status_code == 401

    def test_lockout_after_repeated_bad(self):
        s = requests.Session()
        junk_email = f"nobody+{uuid.uuid4().hex[:6]}@example.com"
        codes = []
        for _ in range(7):
            r = _login(s, junk_email, "wrong")
            codes.append(r.status_code)
        # Non-existent user should still trigger lockout (identifier includes IP+email)
        assert 429 in codes, f"expected a 429 lockout, got {codes}"

    def test_forgot_password_silent_for_unknown(self):
        r = requests.post(f"{API}/auth/forgot-password", json={"email": f"missing+{uuid.uuid4().hex[:6]}@example.com"})
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_forgot_password_for_existing(self):
        r = requests.post(f"{API}/auth/forgot-password", json={"email": ADMIN_EMAIL})
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_vapid_public_key(self):
        r = requests.get(f"{API}/auth/vapid-public-key")
        assert r.status_code == 200
        key = r.json().get("key", "")
        assert isinstance(key, str)
        assert 80 <= len(key) <= 100, f"unexpected vapid key length {len(key)}"


# ------------------------------- Dashboard ----------------------------------
class TestDashboard:
    def test_admin_dashboard(self, admin_session):
        r = admin_session.get(f"{API}/dashboard")
        assert r.status_code == 200
        d = r.json()
        assert "current_or_next_job" in d
        assert "upcoming_jobs" in d
        assert "alerts" in d
        ex = d.get("extras", {})
        for k in ("pending_prep_adds", "pending_ideal_prep", "order_jobs", "user_count", "active_jobs"):
            assert k in ex, f"missing extras.{k}"
        assert ex["user_count"] >= 7


# ------------------------------- Jobs ---------------------------------------
class TestJobs:
    def test_admin_lists_all_jobs(self, admin_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "all"})
        assert r.status_code == 200
        jobs = r.json()
        assert isinstance(jobs, list)
        assert len(jobs) >= 6

    def test_admin_scope_mine(self, admin_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "mine"})
        assert r.status_code == 200
        jobs = r.json()
        # Mack is PM on 3 seeded jobs (admin also views all when scope=mine? code filters to owned)
        assert isinstance(jobs, list)
        # Mack should own at least some
        mine_names = {j["name"] for j in jobs}
        assert any("Coldplay" in n or "BBC" in n or "Royal Albert" in n for n in mine_names)

    def test_get_job_details(self, admin_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "all"})
        job = r.json()[0]
        rr = admin_session.get(f"{API}/jobs/{job['id']}")
        assert rr.status_code == 200
        assert rr.json()["id"] == job["id"]

    def test_status_indicators(self, admin_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "all"})
        job = r.json()[0]
        rr = admin_session.get(f"{API}/jobs/{job['id']}/status-indicators")
        assert rr.status_code == 200
        ind = rr.json()
        for key in ("crew", "documents", "prep_adds", "ideal_prep", "faults", "travel"):
            assert key in ind
            assert isinstance(ind[key], str)

    def test_job_update_admin(self, admin_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "all"})
        job = r.json()[0]
        new_notes = f"TEST_notes_{uuid.uuid4().hex[:6]}"
        rr = admin_session.patch(f"{API}/jobs/{job['id']}", json={"notes": new_notes})
        assert rr.status_code == 200
        assert rr.json()["notes"] == new_notes
        # verify persistence
        rr2 = admin_session.get(f"{API}/jobs/{job['id']}")
        assert rr2.json()["notes"] == new_notes

    def test_job_update_forbidden_for_crew_member(self, crew_member_session, admin_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "all"})
        job = r.json()[0]
        rr = crew_member_session.patch(f"{API}/jobs/{job['id']}", json={"notes": "hack"})
        assert rr.status_code == 403


# ------------------------------ Documents -----------------------------------
class TestDocuments:
    def _admin_job(self, admin_session):
        # find a job owned by admin (Mack)
        r = admin_session.get(f"{API}/jobs", params={"scope": "mine"})
        assert r.status_code == 200
        jobs = r.json()
        assert jobs, "no owned jobs"
        return jobs[0]

    def test_pm_add_and_delete_document(self, admin_session):
        job = self._admin_job(admin_session)
        payload = {
            "document_type": "Drawing", "department": "Lighting",
            "file_name": "TEST_layout.pdf", "file_url": "https://example.com/test.pdf",
        }
        r = admin_session.post(f"{API}/jobs/{job['id']}/documents", json=payload)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["file_name"] == "TEST_layout.pdf"
        # list
        rl = admin_session.get(f"{API}/jobs/{job['id']}/documents")
        assert any(d["id"] == doc["id"] for d in rl.json())
        # delete
        rd = admin_session.delete(f"{API}/jobs/{job['id']}/documents/{doc['id']}")
        assert rd.status_code == 200


# ------------------------------ Prep Adds -----------------------------------
class TestPrepAdds:
    def test_crew_chief_submit_then_pm_approve(self, crew_chief_session, admin_session):
        # find a job Mack is PM on, tom.crew is crew_chief
        r = admin_session.get(f"{API}/jobs", params={"scope": "mine"})
        jobs = r.json()
        job = next((j for j in jobs if j.get("crew_chief")), jobs[0])
        payload = {"items": [{"barcode": "PRG-100001", "fixture_type": "Robe MegaPointe", "qty": 2, "notes": "TEST_extra"}], "notes": "TEST_add"}
        rr = crew_chief_session.post(f"{API}/jobs/{job['id']}/prep-adds", json=payload)
        assert rr.status_code == 200, rr.text
        pid = rr.json()["id"]
        assert rr.json()["status"] == "Pending"
        # admin approves (admin bypasses PM assignment)
        rd = admin_session.post(f"{API}/prep-adds/{pid}/decision", json={"decision": "Approved", "comments": "ok"})
        assert rd.status_code == 200
        # verify status transitioned via list
        rl = admin_session.get(f"{API}/jobs/{job['id']}/prep-adds")
        this = next(p for p in rl.json() if p["id"] == pid)
        assert this["status"] == "Approved"


# ---------------------------- Ideal Prep ------------------------------------
class TestIdealPrep:
    def test_ideal_prep_flow_and_versioning(self, crew_chief_session, admin_session, ops_session):
        r = admin_session.get(f"{API}/jobs", params={"scope": "all"})
        jobs = r.json()
        # Pick job with prep date far enough in the future so amendment deadline hasn't passed
        # (>=3 days ahead so deadline = prep-2days>now)
        from datetime import datetime, timezone as tz
        today = datetime.now(tz.utc).date()
        candidate = None
        for j in jobs:
            try:
                pd = datetime.fromisoformat(j["prep_date"]).date()
                if (pd - today).days >= 3 and j.get("project_manager") == "Mack H":
                    candidate = j
                    break
            except Exception:
                continue
        if not candidate:
            pytest.skip("no suitable job for ideal prep test (need prep_date >= 3 days in future owned by Mack)")

        # First submission by crew chief
        p1 = {"equipment_requirements": "TEST_v1 requirements", "timeline": [{"day": "Day 1", "description": "Setup"}], "special_requirements": "", "notes": "TEST_v1"}
        rr = crew_chief_session.post(f"{API}/jobs/{candidate['id']}/ideal-prep", json=p1)
        assert rr.status_code == 200, rr.text
        ip1 = rr.json()
        assert ip1["version"] == 1 or ip1["version"] >= 1
        v1_id = ip1["id"]
        first_version = ip1["version"]

        # PM (admin) approve
        rp = admin_session.post(f"{API}/ideal-prep/{v1_id}/decision", json={"decision": "Approved", "comments": "pm-ok"})
        assert rp.status_code == 200, rp.text

        # Ops approve
        ro = ops_session.post(f"{API}/ideal-prep/{v1_id}/decision", json={"decision": "Approved", "comments": "ops-ok"})
        assert ro.status_code == 200, ro.text
        assert ro.json().get("status") == "Approved"

        # Second submission → version bump
        p2 = {"equipment_requirements": "TEST_v2 requirements", "timeline": [], "special_requirements": "", "notes": "TEST_v2"}
        r2 = crew_chief_session.post(f"{API}/jobs/{candidate['id']}/ideal-prep", json=p2)
        assert r2.status_code == 200
        assert r2.json()["version"] == first_version + 1


# ------------------------------- Faults -------------------------------------
class TestFaults:
    def test_create_fault_with_real_barcode(self, crew_chief_session):
        payload = {
            "equipment_barcode": "PRG-100001", "description": "TEST_broken lens",
            "can_be_used": False, "photos": [], "videos": [], "additional_comments": "TEST",
        }
        r = crew_chief_session.post(f"{API}/faults", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["equipment_barcode"] == "PRG-100001"
        assert d["status"] == "Open"
        # save id via class attribute
        TestFaults._fault_id = d["id"]

    def test_create_fault_unknown_barcode(self, crew_chief_session):
        r = crew_chief_session.post(f"{API}/faults", json={
            "equipment_barcode": "PRG-999999", "description": "nope", "can_be_used": True,
        })
        assert r.status_code == 400

    def test_service_update_and_comment(self, service_session):
        fid = getattr(TestFaults, "_fault_id", None)
        if not fid:
            pytest.skip("prior fault not created")
        rp = service_session.patch(f"{API}/faults/{fid}", json={"status": "Under Assessment", "severity": "High"})
        assert rp.status_code == 200
        assert rp.json()["status"] == "Under Assessment"
        assert rp.json()["severity"] == "High"
        rc = service_session.post(f"{API}/faults/{fid}/comments", json={"comment": "TEST_looking into it"})
        assert rc.status_code == 200


# ------------------------------ Equipment -----------------------------------
class TestEquipment:
    def test_search_mega(self, admin_session):
        r = admin_session.get(f"{API}/equipment/search", params={"q": "Mega"})
        assert r.status_code == 200
        docs = r.json()
        assert isinstance(docs, list) and len(docs) > 0
        assert any("Mega" in d.get("fixture_type", "") for d in docs)

    def test_get_equipment_with_faults(self, admin_session):
        r = admin_session.get(f"{API}/equipment/PRG-100001")
        assert r.status_code == 200
        d = r.json()
        assert "equipment" in d and "faults" in d
        assert d["equipment"]["barcode"] == "PRG-100001"


# --------------------------- Building Info ----------------------------------
class TestBuildingInfo:
    def test_get_building_info(self, admin_session):
        r = admin_session.get(f"{API}/building-info")
        assert r.status_code == 200
        d = r.json()
        assert d["wifi"]["ssid"]
        assert len(d["contacts"]) >= 6

    def test_admin_update_wifi(self, admin_session):
        new_pw = f"TEST_{uuid.uuid4().hex[:6]}"
        r = admin_session.patch(f"{API}/building-info/wifi", json={"ssid": "PRG-Guest", "password": new_pw, "instructions": "TEST"})
        assert r.status_code == 200
        v = admin_session.get(f"{API}/building-info").json()
        assert v["wifi"]["password"] == new_pw

    def test_add_and_delete_contact(self, admin_session):
        c = admin_session.post(f"{API}/building-info/contacts", json={"label": "TEST_Loading Bay", "name": "TEST", "phone": "+44 000", "extension": "999"}).json()
        assert c["id"]
        rd = admin_session.delete(f"{API}/building-info/contacts/{c['id']}")
        assert rd.status_code == 200


# --------------------------- Notifications ----------------------------------
class TestNotifications:
    def test_list_and_read_all(self, admin_session):
        r = admin_session.get(f"{API}/notifications")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
        rr = admin_session.post(f"{API}/notifications/read-all")
        assert rr.status_code == 200

    def test_push_subscribe(self, admin_session):
        sub = {"endpoint": "https://example.com/push/test-endpoint", "keys": {"p256dh": "aaaa", "auth": "bbbb"}}
        r = admin_session.post(f"{API}/push/subscribe", json={"subscription": sub})
        assert r.status_code == 200


# ----------------------------- User Mgmt ------------------------------------
class TestUsers:
    def test_admin_invite_returns_link(self, admin_session):
        payload = {"name": "TEST_Invitee", "email": f"test+{uuid.uuid4().hex[:6]}@example.com", "roles": ["Crew Member"], "department": "Video"}
        r = admin_session.post(f"{API}/users/invite", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("ok") is True
        link = d.get("invitation_link", "")
        assert "/accept-invitation?token=" in link

    def test_pm_invite_restricted_to_crew(self, pm_session):
        payload = {"name": "TEST_x", "email": f"pmtest+{uuid.uuid4().hex[:6]}@example.com", "roles": ["Project Manager"], "department": None}
        r = pm_session.post(f"{API}/users/invite", json=payload)
        assert r.status_code == 403


# ------------------------------- Search -------------------------------------
class TestSearch:
    def test_global_search_cold(self, admin_session):
        r = admin_session.get(f"{API}/search", params={"q": "Cold"})
        assert r.status_code == 200
        d = r.json()
        assert any("Coldplay" in j["name"] for j in d["jobs"])


# ------------------------------ Audit Log -----------------------------------
class TestAudit:
    def test_admin_audit(self, admin_session):
        r = admin_session.get(f"{API}/audit-log")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_service_dept_denied_audit(self, service_session):
        r = service_session.get(f"{API}/audit-log")
        assert r.status_code == 403
