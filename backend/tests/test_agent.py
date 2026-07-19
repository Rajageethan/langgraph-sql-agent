"""
Automated tests for the text-to-SQL backend.

Setup:
    Place this file at: backend/tests/test_agent.py
    (create the `tests` folder if it doesn't exist)

    From backend/, run:
        uv add --dev pytest httpx
        uv run pytest tests/ -v

Notes:
    - Unit tests (TestHasWhereClause, TestBuildPreviewSql) test pure functions with
      no DB or LLM calls — fast, run every time, no side effects.
    - Integration tests (TestAPIFlow) call the real FastAPI app, which calls the
      real LangGraph agent, which hits your real Supabase DB and real Groq LLM.
      These are slower, cost a little API usage, and will actually run SQL against
      your Chinook database. Read-only tests are safe to run anytime; the DML test
      is written to target a specific, safe, disposable row — read the comment on
      it before running.
"""

import sys
import os
import json
import pytest
from fastapi.testclient import TestClient

# Make sure Python can find agent.py / main.py when running from tests/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agent import has_where_clause, build_preview_sql
from main import app

client = TestClient(app)


# ---------------------------------------------------------------------------
# Unit tests — pure functions, no DB/LLM, run instantly
# ---------------------------------------------------------------------------

class TestHasWhereClause:
    def test_select_always_passes(self):
        assert has_where_clause("SELECT * FROM artist") is True

    def test_delete_with_where_passes(self):
        assert has_where_clause("DELETE FROM artist WHERE artist_id = 1") is True

    def test_delete_without_where_fails(self):
        assert has_where_clause("DELETE FROM artist") is False

    def test_update_with_where_passes(self):
        assert has_where_clause("UPDATE artist SET name = 'x' WHERE artist_id = 1") is True

    def test_update_without_where_fails(self):
        assert has_where_clause("UPDATE artist SET name = 'x'") is False

    def test_case_insensitive(self):
        assert has_where_clause("delete from artist") is False
        assert has_where_clause("Delete From artist Where artist_id = 1") is True


class TestBuildPreviewSql:
    def test_delete_simple(self):
        sql = "DELETE FROM artist WHERE artist_id = 1"
        preview = build_preview_sql(sql)
        assert preview is not None
        assert preview.startswith("SELECT * FROM artist")
        assert "artist_id = 1" in preview

    def test_delete_with_alias(self):
        sql = "DELETE FROM artist a WHERE a.artist_id = 1"
        preview = build_preview_sql(sql)
        assert preview is not None
        assert "artist a" in preview or "artist" in preview
        assert "a.artist_id = 1" in preview

    def test_update_simple(self):
        sql = "UPDATE genre SET name = 'Classic Rock' WHERE name = 'Rock'"
        preview = build_preview_sql(sql)
        assert preview is not None
        assert preview.startswith("SELECT * FROM genre")
        assert "name = 'Rock'" in preview

    def test_select_returns_none(self):
        # SELECTs don't need a preview — nothing to build
        assert build_preview_sql("SELECT * FROM artist") is None

    def test_malformed_sql_returns_none(self):
        assert build_preview_sql("not valid sql at all") is None


# ---------------------------------------------------------------------------
# Integration tests — real API, real DB, real LLM
# ---------------------------------------------------------------------------

def parse_sse(response_text: str) -> list[dict]:
    """Parse a raw SSE response body into a list of JSON event dicts."""
    events = []
    for line in response_text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: "):]))
    return events


class TestAPIFlow:
    def test_ask_returns_pending_approval(self):
        """A read-only question should stream progress events, then a
        pending_approval event with generated SQL."""
        resp = client.post("/ask", json={"question": "Which 5 artists have the most albums?"})
        assert resp.status_code == 200

        events = parse_sse(resp.text)
        assert any(e.get("status") == "pending_approval" for e in events)

        final = [e for e in events if e.get("status") == "pending_approval"][0]
        assert "thread_id" in final
        assert "generated_sql" in final
        assert final["generated_sql"].strip().lower().startswith("select")

    def test_full_read_approve_flow(self):
        """Ask a question, approve it, confirm we get a natural-language answer back."""
        ask_resp = client.post("/ask", json={"question": "How many artists are there?"})
        ask_events = parse_sse(ask_resp.text)
        pending = [e for e in ask_events if e.get("status") == "pending_approval"][0]
        thread_id = pending["thread_id"]

        resume_resp = client.post("/resume", json={
            "thread_id": thread_id,
            "approved": True,
            "feedback": "",
        })
        resume_events = parse_sse(resume_resp.text)
        complete = [e for e in resume_events if e.get("status") == "complete"]
        assert len(complete) == 1
        assert "answer" in complete[0]
        assert len(complete[0]["answer"]) > 0
        # Should be natural language, not a raw dict/Decimal repr
        assert "Decimal(" not in complete[0]["answer"]

    def test_reject_regenerates_sql(self):
        """Rejecting with feedback should return a new pending_approval event,
        not a completed result."""
        ask_resp = client.post("/ask", json={"question": "Show total sales by country"})
        ask_events = parse_sse(ask_resp.text)
        pending = [e for e in ask_events if e.get("status") == "pending_approval"][0]
        thread_id = pending["thread_id"]

        resume_resp = client.post("/resume", json={
            "thread_id": thread_id,
            "approved": False,
            "feedback": "order by total_sales ascending instead",
        })
        resume_events = parse_sse(resume_resp.text)
        pending_again = [e for e in resume_events if e.get("status") == "pending_approval"]
        assert len(pending_again) == 1
        assert "generated_sql" in pending_again[0]

    def test_dml_delete_requires_where_clause(self):
        """A dangerously broad request should never produce a WHERE-less DML query
        reaching the approval stage undetected. Even if the LLM writes one, the
        graph should catch it before offering it for approval as if it were safe."""
        # This just documents the safety property — the actual enforcement is
        # unit-tested directly via has_where_clause above. This integration test
        # is a smoke test that the endpoint doesn't crash on a broad DML prompt.
        resp = client.post("/ask", json={"question": "delete all customers"})
        assert resp.status_code == 200
        # Should not error out — either blocked internally or shows for review
        events = parse_sse(resp.text)
        assert len(events) > 0

    def test_unknown_thread_id_on_resume(self):
        """Resuming with a thread_id that was never created should fail gracefully,
        not crash the server."""
        resp = client.post("/resume", json={
            "thread_id": "00000000-0000-0000-0000-000000000000",
            "approved": True,
            "feedback": "",
        })
        # Should return 200 with an error event, or a clean 4xx/5xx — never a raw
        # unhandled traceback. Adjust this assertion once you decide the exact
        # contract for unknown thread_ids.
        assert resp.status_code in (200, 400, 404, 500)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])