"""HTTP surface: the service must be unusable without the shared secret."""

import json

import pytest
from fastapi.testclient import TestClient

import main

PAYLOAD = {
    "user_id": "u1",
    "chat_id": "c1",
    "model": "gpt-5-mini",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-x",
    "message": "hello",
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_SECRET", "topsecret")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)  # skip MCP dial on startup
    with TestClient(main.app) as c:
        yield c


def test_health_reports_mcp_state(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["mcp_search"] is False


def test_run_rejects_missing_credentials(client):
    assert client.post("/run", json=PAYLOAD).status_code == 401


def test_run_rejects_wrong_secret(client):
    response = client.post("/run", json=PAYLOAD, headers={"authorization": "Bearer nope"})
    assert response.status_code == 401


def test_run_rejects_malformed_payload(client):
    response = client.post(
        "/run", json={"user_id": "u1"}, headers={"authorization": "Bearer topsecret"}
    )
    assert response.status_code == 422


def test_run_streams_sse_frames(client, monkeypatch):
    """A correctly authenticated call returns parseable SSE, not JSON."""
    from langchain_core.messages import AIMessage

    from tests.test_episode import ScriptedModel

    monkeypatch.setattr(
        main,
        "build_model",
        lambda **kw: ScriptedModel(script=[AIMessage(content="Hi there.", usage_metadata={
            "input_tokens": 10, "output_tokens": 3, "total_tokens": 13,
        })]),
    )
    monkeypatch.setattr(main.db, "record_usage", lambda **kw: None)
    monkeypatch.setattr(main.db, "save_assistant_message", lambda **kw: None)

    with client.stream(
        "POST", "/run", json=PAYLOAD, headers={"authorization": "Bearer topsecret"}
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = [
            json.loads(line[6:])
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]

    assert events[-1]["t"] == "done"
    assert any(e["t"] == "message" and e["text"] == "Hi there." for e in events)
