# langgraph-sql-agent

A natural language to SQL agent with human-in-the-loop approval — built for a simple reason: an LLM writing SQL against a real database is a trust boundary, not just a convenience feature. This agent shows you the generated SQL before running it, and for destructive queries (DELETE/UPDATE), previews exactly which rows will be affected before requiring a second confirmation.


## Why this exists

Support and ops teams constantly need ad-hoc data answers ("how many orders last month?", "which artists have the fewest albums?") that don't exist in a dashboard. Today that usually means filing a ticket and waiting on an engineer, or someone half-comfortable with SQL running raw queries directly against production. This agent automates the "write the SQL" step while deliberately keeping the safety check that exists for a good reason — nothing runs without explicit human approval.

## How it works

```
Question (natural language)
        ↓
  Generate SQL (LLM)
        ↓
  Safety check — reject DML with no WHERE clause
        ↓
  Human review — approve, or reject with feedback to regenerate
        ↓
  [Read query] ──→ Execute ──→ Natural language answer
        ↓
  [Write query] → Preview affected rows → Second confirmation → Execute (in a transaction) → Natural language answer
```

Built as a [LangGraph](https://github.com/langchain-ai/langgraph) state machine using `interrupt()`/`Command(resume=...)` to pause execution at each human-approval point, exposed over a streaming (Server-Sent Events) FastAPI backend so a client can show live progress as each step runs.

## Safety design

- **SQL is never executed without explicit approval.** The generated query is shown to the user first.
- **Destructive queries require a second confirmation.** Before any DELETE/UPDATE runs, the agent runs an equivalent preview `SELECT` and shows exactly which rows will be affected — catching cases where "update 1 row" would actually touch thousands.
- **WHERE-less DML is rejected outright**, not just discouraged in the prompt — enforced in code before the query is ever shown for approval.
- **All writes run inside a transaction.** A rejected, failed, or foreign-key-violating query rolls back cleanly rather than partially applying.
- **Errors are translated into plain language** (e.g. a foreign key violation becomes "this row is referenced by other records — remove those first," not a raw stack trace).

## Tech stack

- **Agent orchestration:** LangGraph (state machine + human-in-the-loop)
- **LLM:** Groq (`openai/gpt-oss-120b`)
- **Backend:** FastAPI, streamed via Server-Sent Events
- **Database:** PostgreSQL, hosted on Supabase, seeded with the [Chinook](https://github.com/lerocha/chinook-database) sample dataset (a digital music store schema — artists, albums, tracks, customers, invoices)
- **Frontend:** Next.js

## Try asking

**Read questions**
- "Which 5 artists have the most albums?"
- "What is the total sale in USA?"
- "Show total sales by country"
- "How many tracks are in the Rock genre?"

**Write questions** (triggers the preview + second-confirmation safety flow)
- "Update the genre name 'Rock' to 'Classic Rock'"
- "Delete the artist [pick one you know has no albums]"

## Running locally

### Backend

```bash
cd backend
uv sync
# create a .env file with DATABASE_URL and GROQ_API_KEY
uv run uvicorn main:app --reload
```

Runs at `http://localhost:8000`. Interactive API docs at `http://localhost:8000/docs`.

### Frontend

```bash
cd frontend
npm install
# create a .env.local with NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

Runs at `http://localhost:3000`.

### Tests

```bash
cd backend
uv run pytest tests/ -v
```

Unit tests (safety-check logic) run instantly with no external calls. Integration tests hit the real database and LLM.

## What I'd add with more time

- Swap the in-memory checkpointer (`MemorySaver`) for `PostgresSaver` so agent state survives a server restart
- Audit logging — who approved what, row counts affected, when
- Table/column-level allowlisting for which tables support DML at all
- Role-based access (e.g. only certain users can approve destructive queries)

## Architecture note

The API layer is deliberately decoupled from the frontend — the backend is a standalone FastAPI service with a documented contract (`/ask`, `/resume`), so any client (this Next.js app, a different frontend, or a CLI) can drive the same agent.