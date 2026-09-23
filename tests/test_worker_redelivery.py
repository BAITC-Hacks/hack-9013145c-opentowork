"""Повторная доставка задачи не должна повторно звать модель. Без БД и Redis."""

import pytest

from app.workers import main as worker


class _Session:
    def __init__(self, claimed, status):
        self._answers = [claimed, status]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def scalar(self, *_args, **_kwargs):
        return self._answers.pop(0)

    async def commit(self):
        return None


@pytest.fixture
def no_model(monkeypatch):
    def _fail():
        raise AssertionError("модель не должна вызываться")

    monkeypatch.setattr(worker, "build_provider", _fail)


@pytest.mark.parametrize("status", ["COMPLETED", "FAILED", "CANCELLED"])
async def test_final_job_is_acked_without_rerun(monkeypatch, no_model, status):
    monkeypatch.setattr(worker, "SessionLocal", lambda: _Session(None, status))
    job_id = "00000000-0000-0000-0000-000000000001"
    assert await worker.handle_job(job_id, "t", {}) is True


async def test_job_held_by_other_worker_is_not_acked(monkeypatch, no_model):
    monkeypatch.setattr(worker, "SessionLocal", lambda: _Session(None, "PROCESSING"))
    job_id = "00000000-0000-0000-0000-000000000001"
    assert await worker.handle_job(job_id, "t", {}) is False


def test_stale_lease_does_not_touch_job():
    """Воркер с истёкшей арендой (чужой номер попытки) не пишет в задачу."""
    from types import SimpleNamespace

    job = SimpleNamespace(status="PROCESSING", attempts=2)
    assert worker._still_ours(job, 2)
    assert not worker._still_ours(job, 1)
    assert not worker._still_ours(SimpleNamespace(status="CANCELLED", attempts=1), 1)
    assert not worker._still_ours(None, 1)
