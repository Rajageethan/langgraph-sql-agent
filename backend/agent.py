import os
import re
from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from typing import TypedDict, Optional
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import MemorySaver
from psycopg2.errors import ForeignKeyViolation

class SQLAgentState(TypedDict):
    question: str
    sql: Optional[str]
    approved: bool
    feedback: Optional[str]
    result: Optional[str]
    preview: Optional[str]
    impact_confirmed: bool
    answer: Optional[str]

load_dotenv()

engine = create_engine(os.getenv("DATABASE_URL"))

llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0)

SQL_PROMPT = """You are a PostgreSQL expert. Given the schema below, write a single SQL query 
that answers the user's question. Return ONLY the SQL query, no explanation, no markdown fences.

Schema:
{schema}"""

def get_schema() -> str:
    inspector = inspect(engine)
    lines = []
    for table in inspector.get_table_names():
        cols = inspector.get_columns(table)
        col_desc = ", ".join(f"{c['name']} ({c['type']})" for c in cols)
        lines.append(f"{table}: {col_desc}")
    return "\n".join(lines)

def  generate_sql(question: str) -> str:
    message = [
        SystemMessage(content=SQL_PROMPT.format(schema=get_schema())),
        HumanMessage(content=question),
    ]
    sql = llm.invoke(message).content.strip()
    sql = sql.strip("'").replace("sql\n", "", 1).strip()
    return sql

def execute_sql(sql: str) -> str:
    try:
        with engine.connect() as conn:
            result = conn.execute(text(sql))
            rows = result.fetchall()
            cols = result.keys()
            return "\n".join(str(dict(zip(cols, row))) for row in rows[:50])
    except Exception as e:
        return f"Error Executing query: {e}"
    
def has_where_clause(sql: str) -> bool:
    dml_start = sql.strip().lower()
    if dml_start.startswith("delete") or dml_start.startswith("update"):
        return "where" in dml_start
    return True

def build_preview_sql(sql: str) -> Optional[str]:
    match = re.match(r"DELETE FROM (\w+)(?:\s+(\w+))?\s+WHERE\s+(.*)", sql, re.IGNORECASE | re.DOTALL)
    if match:
        table, alias, where_clause = match.groups()
        alias_part = f" {alias}" if alias else ""
        return f"SELECT * FROM {table}{alias_part} WHERE {where_clause}"
    
    match = re.match(r"UPDATE (\w+)\s+SET\s+.*?\s+WHERE\s+(.*)", sql, re.IGNORECASE | re.DOTALL)
    if match:
        table, where_clause = match.groups()
        return f"SELECT * FROM {table} WHERE {where_clause}"

    return None

def generate_sql_node(state: SQLAgentState) -> dict:
    sql = generate_sql(state["question"])
    return {"sql": sql}

def human_review_node(state: SQLAgentState) -> dict:
    if not has_where_clause(state["sql"]):
        return {"approved": False, "feeedback": "Query is missing a WHERE clause — this could affect the entire table. Add a specific condition."}

    decision = interrupt({
        "question": state["question"],
        "generate_sql": state["sql"] 
    })

    if decision.get("approved"):
        return {"approved": True}
    return {"approved": False, "feedback": decision.get("feedback", "")}

def preview_node(state: SQLAgentState) -> dict:
    preview_sql = build_preview_sql(state["sql"])
    if preview_sql:
        affected = execute_sql(preview_sql)
        return {"preview": affected}
    return {"preview": "Could not generate a preview for this query — proceed with caution."}

def confirm_impact_node(state: SQLAgentState) -> dict:
    decision = interrupt({
        "sql": state["sql"],
        "preview": state["preview"],
        "message": "These rows will be affected. Proceed?",
    })
    return {"impact_confirmed": decision.get("confirmed", False)}

def execute_sql_node(state: SQLAgentState) -> dict:
    try:
        with engine.begin() as conn:
            result = conn.execute(text(state["sql"]))
            if result.returns_rows:
                rows = result.fetchall()
                cols = result.keys()
                output = "\n".join(str(dict(zip(cols, row))) for row in rows[:50])
            else:
                output = f"{result.rowcount} row(s) affected."
        return {"result": output}
    except Exception as e:
        if isinstance(e.orig, ForeignKeyViolation):
            return {"result": "Cannot complete this operation — the row(s) are referenced by other tables. Remove or update those related records first."}
        return {"result": f"Error executing query: {e}"}

def format_answer_node(state: SQLAgentState) -> dict:
    messages = [
        SystemMessage(content="Summarize this SQL query result in one clear, plain-language sentence for a non-technical support agent. Do not mention SQL or technical details."),
        HumanMessage(content=f"Question: {state['question']}\nResult:\n{state['result']}"),
    ]
    answer = llm.invoke(messages).content.strip()
    return {"answer": answer}

def route_after_review(state: SQLAgentState) -> str:
    if not state["approved"]:
        return "generate_sql_node"
    sql_start = state["sql"].strip().lower()
    if sql_start.startswith("select"):
        return "execute_sql_node"  
    return "preview_node"

def route_after_impact(state: SQLAgentState) -> str:
    return "execute_sql_node" if state["impact_confirmed"] else "generate_sql_node"

graph =  StateGraph(SQLAgentState)
graph.add_node("generate_sql_node", generate_sql_node)
graph.add_node("human_review_node", human_review_node)
graph.add_node("execute_sql_node", execute_sql_node)
graph.add_node("format_answer_node", format_answer_node)
graph.add_node("preview_node", preview_node)
graph.add_node("confirm_impact_node", confirm_impact_node)

graph.add_edge(START, "generate_sql_node")
graph.add_edge("generate_sql_node", "human_review_node")
graph.add_edge("execute_sql_node", "format_answer_node")
graph.add_edge("format_answer_node", END)

graph.add_conditional_edges(
    "human_review_node",
    route_after_review,
    {
        "execute_sql_node": "execute_sql_node",
        "preview_node": "preview_node",
        "generate_sql_node": "generate_sql_node",
    },
)

graph.add_edge("preview_node", "confirm_impact_node")

graph.add_conditional_edges(
    "confirm_impact_node",
    route_after_impact,
    {
        "execute_sql_node": "execute_sql_node",
        "generate_sql_node": "generate_sql_node",
    },
)

checkpointer = MemorySaver()
app = graph.compile(checkpointer = checkpointer)

if __name__ == "__main__":
    config = {"configurable": {"thread_id": "test-dml-3"}}
    result = app.invoke({"question": "Remove artists with fewer than 5 albums"}, config=config)
    print(result)

    step2 = app.invoke(Command(resume={"approved": True}), config=config)
    print(step2)

    step3 = app.invoke(Command(resume={"confirmed": True}), config=config)
    print(step3)