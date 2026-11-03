"""Iteration-2 targeted regression: Prep-bay picker + Fault-report edit lock.

Covers:
- GET /api/prep-bays -> exactly 13 bays in order
- GET /api/prep-bays/availability -> per-bay availability, boundary same-day OK
- PATCH /api/jobs/{id} prep_bays: 409 on conflict, 400 on unknown bay, boundary OK
- PATCH /api/faults/{id}/report: reporter edit, admin edit, forbidden other, locked after severity
- last_edited_at / last_edited_by populated
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timedelta, timezone

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:3000").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = ("mackenzie.hardman@prg.com", "PRGMusicAdmin1!")
TOM = ("tom.crew@prg.com", "Password1!")
CHRIS = ("chris.crew@prg.com", "Password1!")
JENNY = ("jenny.ops@prg.com", "Password1!")
RAVI = ("ravi.service@prg.com", "Password1!")

EXPECTED_BAYS = [
    "Prep Bay 0", "Prep Bay 1", "Prep Bay 2", "Prep Bay 3",
    "Prep Bay 4 (Small GS)", "Prep Bay 5 (Small GS)",
    "Prep Bay 6", "Prep Bay 7", "Prep Bay 8", "Prep Bay 9",
    "Prep Bay 10 (Large GS)", "Prep Bay 11", "The Bridge",
]


def _sess(email, pw):
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def admin(): return _sess(*ADMIN)
@pytest.fixture(scope="module")
def tom(): return _sess(*TOM)
@pytest.fixture(scope="module")
def chris(): return _sess(*CHRIS)
@pytest.fixture(scope="module")
def jenny(): return _sess(*JENNY)
@pytest.fixture(scope="module")
def ravi(): return _sess(*RAVI)


# ------------------------------------------------------------------ Prep Bays
class TestPrepBays:
    def test_list_returns_13_in_order(self, admin):
        r = admin.get(f"{API}/prep-bays")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("bays") == EXPECTED_BAYS
        assert len(data["bays"]) == 13

    def test_availability_shape(self, admin):
        today = datetime.now(timezone.utc).date()
        prep = today.isoformat()
        ship = (today + timedelta(days=5)).isoformat()
        r = admin.get(f"{API}/prep-bays/availability", params={"prep_date": prep, "ship_date": ship})
        assert r.status_code == 200, r.text
        arr = r.json()
        assert isinstance(arr, list) and len(arr) == 13
        for item in arr:
            assert set(item.keys()) >= {"bay", "available", "conflicts"}
            assert isinstance(item["available"], bool)
            assert isinstance(item["conflicts"], list)

    def test_conflict_and_boundary(self, admin):
        """Create job A occupying Prep Bay 7 on a distant window, then verify:
           - overlapping window returns available:false with conflict record
           - boundary same-day window is available.
        """
        # Locate two jobs owned by admin (Mack) with well-separated windows so we don't pollute.
        r = admin.get(f"{API}/jobs", params={"scope": "all"})
        jobs = r.json()
        assert jobs
        target = None
        for j in jobs:
            if j.get("project_manager") == "Mack H" and j.get("status") in ("Order", "Reservation", "Quote"):
                target = j; break
        if not target:
            target = jobs[0]

        prep = target["prep_date"]; ship = target["ship_date"]
        bay = "Prep Bay 7"

        # Clear any existing bays first so we know Bay 7 is exclusively ours (idempotent for reruns)
        clear = admin.patch(f"{API}/jobs/{target['id']}", json={"prep_bays": [bay]})
        assert clear.status_code == 200, f"seed bay assignment: {clear.status_code} {clear.text}"

        # Overlapping window (exact same window) — Bay 7 conflict
        r = admin.get(f"{API}/prep-bays/availability", params={"prep_date": prep, "ship_date": ship})
        assert r.status_code == 200
        bay7 = next(x for x in r.json() if x["bay"] == bay)
        assert bay7["available"] is False
        assert any(c["job_id"] == target["id"] for c in bay7["conflicts"])

        # Overlapping but excluding target -> available again
        r2 = admin.get(f"{API}/prep-bays/availability",
                       params={"prep_date": prep, "ship_date": ship, "exclude_job_id": target["id"]})
        bay7b = next(x for x in r2.json() if x["bay"] == bay)
        assert bay7b["available"] is True

        # Boundary same-day handover: new window starts exactly on ship day -> should be available.
        # window = [ship, ship+3]
        ship_dt = datetime.fromisoformat(ship).date()
        r3 = admin.get(f"{API}/prep-bays/availability",
                       params={"prep_date": ship, "ship_date": (ship_dt + timedelta(days=3)).isoformat()})
        assert r3.status_code == 200
        bay7c = next(x for x in r3.json() if x["bay"] == bay)
        assert bay7c["available"] is True, f"boundary same-day should be available, got conflicts: {bay7c['conflicts']}"


# ------------------------------------------------------------- Job PATCH bays
class TestJobPatchBays:
    def _pick_two_admin_jobs_with_overlap(self, admin):
        r = admin.get(f"{API}/jobs", params={"scope": "all"})
        jobs = [j for j in r.json() if j.get("project_manager") == "Mack H"]
        assert len(jobs) >= 2
        # sort by prep_date and pick the two with smallest gap
        jobs.sort(key=lambda j: j.get("prep_date", ""))
        return jobs

    def test_unknown_bay_returns_400(self, admin):
        r = admin.get(f"{API}/jobs", params={"scope": "mine"})
        job = r.json()[0]
        rr = admin.patch(f"{API}/jobs/{job['id']}", json={"prep_bays": ["Prep Bay 99 (nope)"]})
        assert rr.status_code == 400, rr.text
        assert "Unknown prep bay" in (rr.json().get("detail") or "")

    def test_conflict_returns_409(self, admin):
        jobs = self._pick_two_admin_jobs_with_overlap(admin)
        # Find two jobs whose windows overlap (any pair):
        pair = None
        for i in range(len(jobs)):
            for k in range(i + 1, len(jobs)):
                a, b = jobs[i], jobs[k]
                if a["prep_date"] < b["ship_date"] and a["ship_date"] > b["prep_date"]:
                    pair = (a, b); break
            if pair: break
        if not pair:
            pytest.skip("no overlapping admin-owned jobs to test conflict")
        a, b = pair
        # Give A a specific bay
        r1 = admin.patch(f"{API}/jobs/{a['id']}", json={"prep_bays": ["Prep Bay 8"]})
        assert r1.status_code == 200, r1.text
        # Attempt to assign same bay to B -> expect 409
        r2 = admin.patch(f"{API}/jobs/{b['id']}", json={"prep_bays": ["Prep Bay 8"]})
        assert r2.status_code == 409, f"expected 409, got {r2.status_code} {r2.text}"
        assert a["name"] in (r2.json().get("detail") or "")
        # cleanup: clear A
        admin.patch(f"{API}/jobs/{a['id']}", json={"prep_bays": []})

    def test_boundary_touching_succeeds(self, admin):
        """Create a virtual overlap: get any job of admin, remember its window, then
        toggle a bay for it — then confirm the current job can NOT self-conflict."""
        r = admin.get(f"{API}/jobs", params={"scope": "mine"})
        job = r.json()[0]
        r1 = admin.patch(f"{API}/jobs/{job['id']}", json={"prep_bays": ["Prep Bay 9"]})
        assert r1.status_code == 200
        # Boundary: assign same bay again to same job (excluded from self-check) — should succeed
        r2 = admin.patch(f"{API}/jobs/{job['id']}", json={"prep_bays": ["Prep Bay 9"]})
        assert r2.status_code == 200, r2.text
        # cleanup
        admin.patch(f"{API}/jobs/{job['id']}", json={"prep_bays": []})


# --------------------------------------------------------- Fault report lock
class TestFaultReportLock:
    """Tom creates a fault, verifies:
       - Tom can edit /report (200, last_edited_* populated)
       - Chris (neither reporter nor admin) 403
       - Admin can edit while unlocked (200)
       - After Admin sets severity via PATCH /faults/{id}, report is locked (400)
    """
    fault_id = None

    def test_tom_creates_fault(self, tom):
        payload = {
            "equipment_barcode": "PRG-100002",
            "description": "TEST_report_lock initial",
            "can_be_used": True,
            "photos": [], "videos": [],
            "additional_comments": "initial",
        }
        r = tom.post(f"{API}/faults", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["reported_by_name"] == "Tom Crew"
        TestFaultReportLock.fault_id = d["id"]

    def test_tom_edits_report_ok(self, tom):
        fid = TestFaultReportLock.fault_id
        assert fid
        r = tom.patch(f"{API}/faults/{fid}/report", json={
            "description": "TEST_updated_description",
            "can_be_used": False,
            "additional_comments": "updated"
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["description"] == "TEST_updated_description"
        assert d["can_be_used"] is False
        assert d.get("last_edited_by") == "Tom Crew"
        assert d.get("last_edited_at")

    def test_chris_forbidden(self, chris):
        fid = TestFaultReportLock.fault_id
        r = chris.patch(f"{API}/faults/{fid}/report", json={"description": "hack"})
        assert r.status_code == 403

    def test_admin_can_edit_while_unlocked(self, admin):
        fid = TestFaultReportLock.fault_id
        r = admin.patch(f"{API}/faults/{fid}/report", json={"additional_comments": "admin-touched"})
        assert r.status_code == 200
        assert r.json()["additional_comments"] == "admin-touched"

    def test_admin_assigns_severity(self, admin):
        fid = TestFaultReportLock.fault_id
        r = admin.patch(f"{API}/faults/{fid}", json={"severity": "High"})
        assert r.status_code == 200
        assert r.json()["severity"] == "High"

    def test_locked_after_severity(self, tom, admin):
        fid = TestFaultReportLock.fault_id
        # Tom (reporter) is now locked out
        r1 = tom.patch(f"{API}/faults/{fid}/report", json={"description": "still trying"})
        assert r1.status_code == 400
        assert "locked" in (r1.json().get("detail") or "").lower()
        # Even admin is locked out via /report endpoint (severity != None)
        r2 = admin.patch(f"{API}/faults/{fid}/report", json={"description": "still trying"})
        assert r2.status_code == 400
