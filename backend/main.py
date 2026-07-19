from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from typing import Optional
from agent import app as graph_app
from langgraph.types import Command
import uuid
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins = ["*"],
    allow_methods = ["*"],
    allow_headers = ["*"],
)

class AskRequest(BaseModel):
    question: str

class ResumeRequest(BaseModel):
    thread_id: str
    approved: bool
    feedback: Optional[str] = ""

@app.post("/ask")
async def ask(req: AskRequest):
    async def event_stream():
        thread_id = str(uuid.uuid4())
        config = {"configurable": {"thread_id": thread_id}}

        try:
            for event in graph_app.stream({"question": req.question}, config=config, stream_mode="updates"):
                for node_name in event.keys():
                    yield f"data: {json.dumps({'node': node_name, 'status': 'running'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"
            return

        state = graph_app.get_state(config)
        if state.tasks and state.tasks[0].interrupts:
            sql = state.tasks[0].interrupts[0].value.get("generated_sql") or state.tasks[0].interrupts[0].value.get("generate_sql")
            yield f"data: {json.dumps({'thread_id': thread_id, 'status': 'pending_approval', 'generated_sql': sql})}\n\n"
        else:
            yield f"data: {json.dumps({'status': 'error', 'message': 'No interrupt reached — unexpected graph completion.'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.post("/resume")
async def resume(req: ResumeRequest):
    async def event_stream():
        config = {"configurable": {"thread_id": req.thread_id}}
        resume_payload = {"approved": req.approved}
        if not req.approved:
            resume_payload["feedback"] = req.feedback
        resume_payload["confirmed"] = req.approved

        try:
            for event in graph_app.stream(Command(resume=resume_payload), config=config, stream_mode="updates"):
                for node_name in event.keys():
                    yield f"data: {json.dumps({'node': node_name, 'status': 'running'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"
            return

        state = graph_app.get_state(config)
        if state.tasks and state.tasks[0].interrupts:
            interrupt_val = state.tasks[0].interrupts[0].value
            sql = interrupt_val.get("generated_sql") or interrupt_val.get("generate_sql") or interrupt_val.get("sql")
            preview = interrupt_val.get("preview")
            yield f"data: {json.dumps({'thread_id': req.thread_id, 'status': 'pending_approval', 'generated_sql': sql, 'preview': preview})}\n\n"
        else:
            final_state = state.values
            yield f"data: {json.dumps({'status': 'complete', 'answer': final_state.get('answer', ''), 'sql': final_state.get('sql', ''), 'result': final_state.get('result', '')})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}