"""Regression checks for security-critical startup and login code."""
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / 'api' / 'index.py'


def test_no_automatic_seeding_on_startup():
    source = SOURCE.read_text()
    lifespan = source.split('async def lifespan(', 1)[1].split('\napp = FastAPI', 1)[0]
    assert 'await seed_data()' not in lifespan


def test_no_plaintext_credential_file():
    assert 'test_credentials.md' not in SOURCE.read_text()


def test_no_existing_admin_password_overwrite():
    source = SOURCE.read_text()
    seed = source.split('async def seed_data()', 1)[1].split('# Auth endpoints', 1)[0]
    assert 'update_user_by_id(str(existing["id"])' not in seed


def test_login_does_not_return_token_in_json():
    source = SOURCE.read_text()
    login = source.split('async def login(', 1)[1].split('@api.post("/auth/logout")', 1)[0]
    assert '"access_token": session.access_token' not in login
