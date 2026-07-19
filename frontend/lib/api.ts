const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ─── Event / Response Types ───────────────────────────────────────────────────

export interface ProgressEvent {
  node: string;
  status: "running";
}

export interface PendingApprovalEvent {
  thread_id: string;
  status: "pending_approval";
  generated_sql: string;
  preview: string | null;
}

export interface CompleteEvent {
  status: "complete";
  answer: string;
  sql: string;
  result: string;
}

export interface ErrorEvent {
  status: "error";
  message: string;
}

export type SSEEvent =
  | ProgressEvent
  | PendingApprovalEvent
  | CompleteEvent
  | ErrorEvent;

// ─── Generic SSE stream reader ────────────────────────────────────────────────

/**
 * POSTs to `url` with `body` and reads the response as an SSE stream.
 * Parses each "data: {...}\n\n" line and calls `onEvent` for each JSON object.
 * Returns a cancel function (aborts the underlying fetch).
 */
function streamPost(
  url: string,
  body: unknown,
  onEvent: (event: SSEEvent) => void,
  onDone: () => void,
  onFetchError: (message: string) => void
): () => void {
  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      onFetchError(err instanceof Error ? err.message : "Network error");
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      try {
        const json = JSON.parse(text) as ErrorEvent;
        onFetchError(json.message ?? `Server error ${res.status}`);
      } catch {
        onFetchError(`Server error ${res.status}: ${text}`);
      }
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      onFetchError("No response body from server.");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          // An SSE event block may have multiple lines; find "data:" line(s)
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice("data:".length).trim();
            if (!jsonStr) continue;
            try {
              const event = JSON.parse(jsonStr) as SSEEvent;
              onEvent(event);
            } catch {
              // ignore malformed JSON
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      onFetchError(err instanceof Error ? err.message : "Stream read error");
      return;
    }

    onDone();
  })();

  return () => controller.abort();
}

// ─── Public API helpers ───────────────────────────────────────────────────────

export interface AskCallbacks {
  onProgress: (event: ProgressEvent) => void;
  onPendingApproval: (event: PendingApprovalEvent) => void;
  onComplete: (event: CompleteEvent) => void;
  onError: (message: string) => void;
}

/**
 * Streams POST /ask.
 * Fires onProgress for every "running" node event.
 * Fires onPendingApproval or onComplete for the terminal event.
 * Returns a cancel function.
 */
export function askQuestion(
  question: string,
  callbacks: AskCallbacks
): () => void {
  return streamPost(
    `${API_URL}/ask`,
    { question },
    (event) => {
      if (event.status === "running") {
        callbacks.onProgress(event as ProgressEvent);
      } else if (event.status === "pending_approval") {
        callbacks.onPendingApproval(event as PendingApprovalEvent);
      } else if (event.status === "complete") {
        callbacks.onComplete(event as CompleteEvent);
      } else if (event.status === "error") {
        callbacks.onError((event as ErrorEvent).message);
      }
    },
    () => {}, // stream ended without a terminal event — no-op
    callbacks.onError
  );
}

export interface ResumeCallbacks {
  onProgress: (event: ProgressEvent) => void;
  onPendingApproval: (event: PendingApprovalEvent) => void;
  onComplete: (event: CompleteEvent) => void;
  onError: (message: string) => void;
}

/**
 * Streams POST /resume.
 * Same event shapes as /ask — progress nodes while running,
 * then either pending_approval (needs another round of review) or complete.
 * Returns a cancel function.
 */
export function resumeStream(
  payload: { thread_id: string; approved: boolean; feedback?: string },
  callbacks: ResumeCallbacks
): () => void {
  return streamPost(
    `${API_URL}/resume`,
    payload,
    (event) => {
      if (event.status === "running") {
        callbacks.onProgress(event as ProgressEvent);
      } else if (event.status === "pending_approval") {
        callbacks.onPendingApproval(event as PendingApprovalEvent);
      } else if (event.status === "complete") {
        callbacks.onComplete(event as CompleteEvent);
      } else if (event.status === "error") {
        callbacks.onError((event as ErrorEvent).message);
      }
    },
    () => {},
    callbacks.onError
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Human-friendly label for a node name coming from the backend */
export function nodeLabel(node: string): string {
  const map: Record<string, string> = {
    // explicit node names used in the agent graph
    generate_sql_node: "Generating SQL…",
    human_review_node: "Waiting for review…",
    preview_node: "Checking impact…",
    confirm_impact_node: "Confirming impact…",
    execute_sql_node: "Executing query…",
    // legacy / fallback names
    generate_sql: "Generating SQL…",
    check_safety: "Checking safety…",
    validate_sql: "Validating SQL…",
    execute_sql: "Executing query…",
    format_answer: "Formatting answer…",
    human_approval: "Awaiting approval…",
    route: "Routing request…",
    classify: "Classifying question…",
  };
  return (
    map[node] ??
    node.replace(/_node$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) + "…"
  );
}
