"""Iteration-3 targeted regression: GET /api/prep-bays/bookings + related UI-driven expectations.

Coverage:
- Admin/PM/Ops receive 200 with expected shape (bays[13], month_start, month_end_next, bookings[])
- Crew/Chief/Account/Service each receive 403
- Invalid month values (0, 13) => 400
- Boundary intersection: jobs whose window straddles the month are included
"""
import os
import pytest
import requests
from datetime import date

def _read_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    # Fallback: read from frontend/.env
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not found")

BASE_URL = _read_backend_url()
API = f"{BASE_URL}/api"

ADMIN = ("mackenzie.hardman@prg.com", "PRGMusicAdmin1!")
PM = ("alex.pm@prg.com", "Password1!")
OPS = ("jenny.ops@prg.com", "Password1!")
CHIEF = ("tom.crew@prg.com", "Password1!")
CREW = ("chris.crew@prg.com", "Password1!")
ACCT = ("sam.account@prg.com", "Password1!")
SERVICE = ("ravi.service@prg.com", "Password1!")


def _sess(email, pw):
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def admin(): return _sess(*ADMIN)
@pytest.fixture(scope="module")
def pm(): return _sess(*PM)
@pytest.fixture(scope="module")
def ops(): return _sess(*OPS)
@pytest.fixture(scope="module")
def chief(): return _sess(*CHIEF)
@pytest.fixture(scope="module")
def crew(): return _sess(*CREW)
@pytest.fixture(scope="module")
def acct(): return _sess(*ACCT)
@pytest.fixture(scope="module")
def service(): return _sess(*SERVICE)


class TestPrepBayBookingsAuthorisation:
    """Only Admin / Project Manager / Operations Manager may call this endpoint."""

    def _params(self):
        today = date.today()
        return {"year": today.year, "month": today.month}

    def test_admin_200(self, admin):
        r = admin.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 200, r.text
        d = r.json()
        assert set(d.keys()) >= {"bays", "month_start", "month_end_next", "bookings"}
        assert isinstance(d["bays"], list) and len(d["bays"]) == 13
        assert isinstance(d["bookings"], list)
        # Verify sample shape when at least one booking exists
        if d["bookings"]:
            b = d["bookings"][0]
            assert set(b.keys()) >= {"job_id", "job_name", "prep_date", "ship_date", "prep_bays", "status"}
            assert isinstance(b["prep_bays"], list)

    def test_pm_200(self, pm):
        r = pm.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 200, r.text

    def test_ops_200(self, ops):
        r = ops.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 200, r.text

    def test_crew_chief_403(self, chief):
        r = chief.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 403, r.text

    def test_crew_member_403(self, crew):
        r = crew.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 403, r.text

    def test_account_manager_403(self, acct):
        r = acct.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 403, r.text

    def test_service_department_403(self, service):
        r = service.get(f"{API}/prep-bays/bookings", params=self._params())
        assert r.status_code == 403, r.text


class TestPrepBayBookingsInvalidMonth:
    def test_month_zero_400(self, admin):
        r = admin.get(f"{API}/prep-bays/bookings", params={"year": 2026, "month": 0})
        assert r.status_code == 400, r.text

    def test_month_thirteen_400(self, admin):
        r = admin.get(f"{API}/prep-bays/bookings", params={"year": 2026, "month": 13})
        assert r.status_code == 400, r.text


class TestPrepBayBookingsIntersection:
    """A job whose [prep_date, ship_date] intersects the requested month must appear."""

    def test_month_window_shape(self, admin):
        r = admin.get(f"{API}/prep-bays/bookings", params={"year": 2026, "month": 7})
        assert r.status_code == 200
        d = r.json()
        assert d["month_start"] == "2026-07-01"
        assert d["month_end_next"] == "2026-08-01"

    def test_december_wraps_year(self, admin):
        r = admin.get(f"{API}/prep-bays/bookings", params={"year": 2026, "month": 12})
        assert r.status_code == 200
        d = r.json()
        assert d["month_start"] == "2026-12-01"
        assert d["month_end_next"] == "2027-01-01"

    def test_bookings_lie_within_month(self, admin):
        """Every returned booking must have prep_date < month_end_next AND ship_date > month_start."""
        r = admin.get(f"{API}/prep-bays/bookings", params={"year": 2026, "month": 7})
        d = r.json()
        for b in d["bookings"]:
            assert b["prep_date"] < d["month_end_next"], f"prep {b['prep_date']} !< {d['month_end_next']}"
            assert b["ship_date"] > d["month_start"], f"ship {b['ship_date']} !> {d['month_start']}"
            assert b["prep_bays"], f"booking has no prep_bays: {b}"

    def test_boundary_job_included_when_ships_in_month(self, admin):
        """Locate a job with ship_date in some month M. Query M-1: the job's window should
        intersect M-1 IFF prep_date < first-of-M. In such a case it must appear in M-1's list."""
        # Sample from full jobs list
        rj = admin.get(f"{API}/jobs", params={"scope": "all"})
        assert rj.status_code == 200
        jobs = [j for j in rj.json() if j.get("prep_bays")]
        assert jobs, "expected seeded jobs with prep_bays"
        # Pick a job whose prep_month != ship_month (multi-month spanning)
        spanning = None
        for j in jobs:
            try:
                p = date.fromisoformat(j["prep_date"]); s = date.fromisoformat(j["ship_date"])
                if (p.year, p.month) != (s.year, s.month):
                    spanning = (j, p, s); break
            except Exception:
                continue
        if not spanning:
            pytest.skip("no seeded job spans multiple months")
        j, p, s = spanning
        # Query the prep-month
        r1 = admin.get(f"{API}/prep-bays/bookings", params={"year": p.year, "month": p.month})
        ids1 = {b["job_id"] for b in r1.json()["bookings"]}
        assert j["id"] in ids1, f"job {j['name']} should appear in prep month {p.year}-{p.month}"
        # Query the ship-month
        r2 = admin.get(f"{API}/prep-bays/bookings", params={"year": s.year, "month": s.month})
        ids2 = {b["job_id"] for b in r2.json()["bookings"]}
        assert j["id"] in ids2, f"job {j['name']} should appear in ship month {s.year}-{s.month}"
