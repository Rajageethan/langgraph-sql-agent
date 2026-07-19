"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  askQuestion,
  resumeStream,
  nodeLabel,
  type ProgressEvent,
  type PendingApprovalEvent,
  type CompleteEvent,
} from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase =
  | "idle"
  | "streaming"
  | "pending_approval"
  | "resuming"
  | "rejecting"
  | "complete"
  | "error";

interface Step {
  node: string;
  label: string;
  key: string;
}

interface HistoryItem {
  id: string;
  question: string;
  answer: CompleteEvent | null;
  errorMsg: string;
}

// ─── Inline stepper ───────────────────────────────────────────────────────────
// Renders:  generating sql → validating sql → [current step]
// Done steps are dim, current step is white+bold, separator is faint

function Stepper({
  steps,
  active,
}: {
  steps: Step[];
  active: boolean; // is stream still running?
}) {
  if (steps.length === 0) return null;

  return (
    <div className="stepper fade-in">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const isCurrent = isLast && active;
        return (
          <span key={step.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span className={isCurrent ? "stepper-active" : "stepper-done"}>
              {step.label}
            </span>
            {(active || !isLast) && (
              <span className="stepper-sep">→</span>
            )}
          </span>
        );
      })}
      {active && <span className="spinner" />}
    </div>
  );
}

// ─── SQL block ────────────────────────────────────────────────────────────────

function SQLBlock({ sql }: { sql: string }) {
  return <pre className="sql-block">{sql}</pre>;
}

// ─── Preview table ────────────────────────────────────────────────────────────

function PreviewTable({ preview }: { preview: string }) {
  const lines = preview.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  return (
    <div className="preview-block">
      <div className="preview-label">rows affected</div>
      <div className="preview-table">
        {lines.map((line, i) =>
          i === 0 ? (
            <div key={i} className="preview-table-header">{line}</div>
          ) : (
            <div key={i} className="preview-table-row">{line}</div>
          )
        )}
      </div>
    </div>
  );
}

// ─── Approval block ───────────────────────────────────────────────────────────

function ApprovalBlock({
  sql,
  preview,
  isRunning,
  onApprove,
  onReject,
}: {
  sql: string;
  preview: string | null;
  isRunning: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="approval-block fade-in">
      <div className="approval-label">awaiting approval</div>

      <SQLBlock sql={sql} />

      {preview && <PreviewTable preview={preview} />}

      <div className="approval-actions">
        <button
          id="btn-approve-sql"
          className="btn btn-approve"
          onClick={onApprove}
          disabled={isRunning}
        >
          {isRunning ? <><span className="spinner" /> running</> : "approve"}
        </button>
        <button
          id="btn-reject-sql"
          className="btn btn-reject"
          onClick={onReject}
          disabled={isRunning}
        >
          reject
        </button>
      </div>
    </div>
  );
}

// ─── Feedback form ────────────────────────────────────────────────────────────

function FeedbackForm({
  onSubmit,
  onCancel,
  isSubmitting,
}: {
  onSubmit: (feedback: string) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}) {
  const [text, setText] = useState("");

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) {
      e.preventDefault();
      onSubmit(text.trim());
    }
  };

  return (
    <div className="feedback-block fade-in">
      <div className="feedback-label">feedback (ctrl+enter to submit)</div>
      <textarea
        id="rejection-feedback-input"
        className="feedback-input"
        rows={2}
        placeholder="describe what to fix..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        autoFocus
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          id="btn-submit-feedback"
          className="btn btn-submit"
          onClick={() => onSubmit(text.trim())}
          disabled={!text.trim() || isSubmitting}
        >
          {isSubmitting ? <><span className="spinner" /> regenerating</> : "regenerate sql"}
        </button>
        <button
          id="btn-cancel-feedback"
          className="btn btn-ghost"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// ─── Answer block ─────────────────────────────────────────────────────────────

function AnswerBlock({ data }: { data: CompleteEvent }) {
  return (
    <div className="answer-block fade-in">
      <div className="answer-label">result</div>
      <div className="answer-text">{data.answer}</div>
      {data.sql && (
        <>
          <div className="sep" />
          <div style={{ color: "var(--text-dim)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            executed sql
          </div>
          <SQLBlock sql={data.sql} />
        </>
      )}
    </div>
  );
}

// ─── Error block ──────────────────────────────────────────────────────────────

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="error-block fade-in">
      <div className="error-label">error</div>
      <div className="error-text">{message}</div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [phase, setPhase]               = useState<Phase>("idle");
  const [question, setQuestion]         = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [askSteps, setAskSteps]         = useState<Step[]>([]);
  const [resumeSteps, setResumeSteps]   = useState<Step[]>([]);
  const [pendingSQL, setPendingSQL]     = useState("");
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [threadId, setThreadId]         = useState<string | null>(null);
  const [answer, setAnswer]             = useState<CompleteEvent | null>(null);
  const [errorMsg, setErrorMsg]         = useState("");
  const [history, setHistory]           = useState<HistoryItem[]>([]);

  const cleanupRef    = useRef<(() => void) | null>(null);
  const askCounter    = useRef(0);
  const resumeCounter = useRef(0);
  const historyId     = useRef(0);
  const bottomRef     = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 0);
    return () => clearTimeout(id);
  }, [phase, askSteps.length, resumeSteps.length, answer, errorMsg, history.length]);

  useEffect(() => () => { cleanupRef.current?.(); }, []);

  const cancelStream = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  };

  const reset = useCallback(() => {
    cancelStream();
    setPhase("idle");
    setQuestion("");
    setAskSteps([]);
    setResumeSteps([]);
    setPendingSQL("");
    setPendingPreview(null);
    setThreadId(null);
    setAnswer(null);
    setErrorMsg("");
    setSubmittedQuestion("");
    setHistory([]);
    askCounter.current = 0;
    resumeCounter.current = 0;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── /ask ─────────────────────────────────────────────────

  const handleAsk = useCallback(() => {
    const q = question.trim();
    if (!q) return;

    // Archive current completed turn into chat history before starting a new one
    setHistory(prev => {
      if (submittedQuestion && (phase === "complete" || phase === "error")) {
        historyId.current += 1;
        return [
          ...prev,
          {
            id: `h${historyId.current}`,
            question: submittedQuestion,
            answer: phase === "complete" ? answer : null,
            errorMsg: phase === "error" ? errorMsg : "",
          },
        ];
      }
      return prev;
    });

    // Reset current-turn state (history is preserved above)
    cancelStream();
    setQuestion("");
    setAskSteps([]);
    setResumeSteps([]);
    setPendingSQL("");
    setPendingPreview(null);
    setThreadId(null);
    setAnswer(null);
    setErrorMsg("");
    // Set submittedQuestion AFTER all other resets so it wins the batch
    setSubmittedQuestion(q);
    setPhase("streaming");
    askCounter.current = 0;
    resumeCounter.current = 0;

    cleanupRef.current = askQuestion(q, {
      onProgress: (e: ProgressEvent) => {
        askCounter.current += 1;
        setAskSteps(prev => [
          ...prev,
          { node: e.node, label: nodeLabel(e.node), key: `a${askCounter.current}` },
        ]);
      },
      onPendingApproval: (e: PendingApprovalEvent) => {
        setThreadId(e.thread_id);
        setPendingSQL(e.generated_sql);
        setPendingPreview(e.preview);
        setPhase("pending_approval");
      },
      onComplete: (e: CompleteEvent) => { setAnswer(e); setPhase("complete"); },
      onError: (msg) => { setErrorMsg(msg); setPhase("error"); },
    });
  }, [question, submittedQuestion, phase, answer, errorMsg]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── /resume ───────────────────────────────────────────────

  const startResume = useCallback((payload: {
    thread_id: string;
    approved: boolean;
    feedback?: string;
  }) => {
    cancelStream();
    setResumeSteps([]);
    resumeCounter.current = 0;
    setPhase("resuming");

    cleanupRef.current = resumeStream(payload, {
      onProgress: (e: ProgressEvent) => {
        resumeCounter.current += 1;
        setResumeSteps(prev => [
          ...prev,
          { node: e.node, label: nodeLabel(e.node), key: `r${resumeCounter.current}` },
        ]);
      },
      onPendingApproval: (e: PendingApprovalEvent) => {
        setThreadId(e.thread_id);
        setPendingSQL(e.generated_sql);
        setPendingPreview(e.preview);
        setResumeSteps([]);
        setPhase("pending_approval");
      },
      onComplete: (e: CompleteEvent) => { setAnswer(e); setPhase("complete"); },
      onError: (msg) => { setErrorMsg(msg); setPhase("error"); },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApprove = useCallback(() => {
    if (!threadId) return;
    startResume({ thread_id: threadId, approved: true });
  }, [threadId, startResume]);

  const handleRejectClick = useCallback(() => setPhase("rejecting"), []);

  const handleRejectSubmit = useCallback((feedback: string) => {
    if (!threadId) return;
    startResume({ thread_id: threadId, approved: false, feedback });
  }, [threadId, startResume]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && question.trim()) {
      e.preventDefault();
      handleAsk();
    }
  };

  const inputDisabled = phase !== "idle" && phase !== "complete" && phase !== "error";
  const isRunning     = phase === "resuming";
  const showApproval  = phase === "pending_approval" || phase === "rejecting" || phase === "resuming";

  // ─── Render ──────────────────────────────────────────────
  return (
    <div className="shell">
      {/* Top bar */}
      <div className="topbar">
        <span className="topbar-title">text-to-sql</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {(phase !== "idle" || history.length > 0) && (
            <button
              id="btn-new-question"
              className="btn btn-ghost"
              onClick={reset}
              style={{ fontSize: 11 }}
            >
              new query
            </button>
          )}
        </div>
      </div>

      {/* Main scroll area */}
      <div className="main">
        <div className="main-inner">

          {/* About — always rendered, scrolls away as chat grows */}
          <div className="about-panel" id="about-panel">
            <p className="about-desc">
              A text-to-SQL agent that shows generated SQL for approval before running it,
              and previews affected rows before any DELETE/UPDATE executes.
            </p>
            <p className="about-stack">
              LangGraph &middot; FastAPI &middot; Groq (llama-4-maverick) &middot; PostgreSQL (Supabase) &middot; Next.js
            </p>
            <ul className="about-bullets">
              <li>SQL is generated but never run without explicit approval</li>
              <li>Destructive queries (DELETE/UPDATE) require a second confirmation after previewing affected rows</li>
              <li>All writes run inside a transaction — a rejected or failed query never partially applies</li>
            </ul>

            <div className="about-sep" />

            <p className="about-desc">
              The database is Chinook — a sample dataset modeling a digital music store. It includes
              artists, albums, tracks, genres, customers, invoices, and employees, with realistic
              relationships between them (e.g. albums belong to artists, tracks belong to albums and
              have genres, invoices belong to customers).
            </p>

            <div className="about-examples">
              <div className="about-examples-group">
                <span className="about-examples-label">read</span>
                <ul className="about-bullets">
                  <li>Which 5 artists have the most albums?</li>
                  <li>What are the top 5 best-selling tracks?</li>
                  <li>Show total sales by country</li>
                  <li>Which customers have spent the most money?</li>
                  <li>How many tracks are in the Rock genre?</li>
                </ul>
              </div>
              <div className="about-examples-group">
                <span className="about-examples-label">write (triggers approval + row preview)</span>
                <ul className="about-bullets">
                  <li>Delete the artist named Aquaman</li>
                  <li>Update the genre name &apos;Rock&apos; to &apos;Classic Rock&apos;</li>
                </ul>
              </div>
            </div>

            <a href="#" className="about-link" id="link-github">github →</a>
          </div>

          {/* Idle */}
          {phase === "idle" && history.length === 0 && (
            <div className="idle-prompt">
              ask a question in plain english. sql will be shown for approval before running.
            </div>
          )}

          {/* Chat history — past completed turns */}
          {history.map(item => (
            <div key={item.id} className="chat-turn">
              <div className="question-row">
                <div className="question-bubble">{item.question}</div>
              </div>
              {item.answer && <AnswerBlock data={item.answer} />}
              {item.errorMsg && <ErrorBlock message={item.errorMsg} />}
            </div>
          ))}

          {/* Current turn question bubble */}
          {submittedQuestion && (
            <div className="question-row">
              <div className="question-bubble">{submittedQuestion}</div>
            </div>
          )}

          {/* /ask stepper */}
          {askSteps.length > 0 && (
            <Stepper steps={askSteps} active={phase === "streaming"} />
          )}

          {/* /resume stepper */}
          {resumeSteps.length > 0 && (
            <Stepper steps={resumeSteps} active={phase === "resuming"} />
          )}

          {/* SQL approval */}
          {showApproval && (
            <ApprovalBlock
              sql={pendingSQL}
              preview={pendingPreview}
              isRunning={isRunning}
              onApprove={handleApprove}
              onReject={handleRejectClick}
            />
          )}

          {/* Rejection feedback */}
          {phase === "rejecting" && (
            <FeedbackForm
              onSubmit={handleRejectSubmit}
              onCancel={() => setPhase("pending_approval")}
              isSubmitting={false}
            />
          )}

          {/* Answer */}
          {phase === "complete" && answer && <AnswerBlock data={answer} />}

          {/* Error */}
          {phase === "error" && <ErrorBlock message={errorMsg} />}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="inputbar">
        <div className="inputbar-inner">
          <textarea
            id="question-input"
            className="input-field"
            rows={1}
            placeholder="enter a question..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKey}
            disabled={inputDisabled}
          />
          <button
            id="btn-send-question"
            className="btn btn-send"
            onClick={handleAsk}
            disabled={!question.trim() || inputDisabled}
          >
            {phase === "streaming" ? <span className="spinner" /> : "run"}
          </button>
        </div>
      </div>
    </div>
  );
}
