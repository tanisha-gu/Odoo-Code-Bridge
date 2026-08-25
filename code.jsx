import React, { useState, useRef } from "react";
import { Cog, Copy, Check, Loader2, ArrowRight, AlertCircle, FileCode2, Sparkles, Upload } from "lucide-react";

const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=JetBrains+Mono:wght@400;500&display=swap');";

const COLORS = {
  bg: "#161320",
  panel: "#1e1a2b",
  panelHead: "#241f34",
  border: "#332b47",
  borderStrong: "#493d63",
  text: "#F1EAF5",
  textMuted: "#9d8fb0",
  purple: "#9b6fa3",
  purpleDeep: "#714b67",
  purpleGlow: "#c9a0d9",
  gold: "#e7a33e",
  goldDim: "#8a6a30",
  danger: "#e0716a",
};

const CHUNK_LINE_THRESHOLD = 300; // above this, auto-split into chunks
const MAX_LINES_PER_CHUNK = 260; // target size per chunk

const SYSTEM_PROMPT = `You are a senior Odoo ERP developer. You convert arbitrary backend code (Python, and/or JavaScript describing backend/business logic) into idiomatic Odoo Python code.

Rules for the conversion:
- Target Odoo's ORM conventions: models.Model / models.TransientModel subclasses, fields.Char/Integer/Float/Boolean/Date/Datetime/Many2one/One2many/Many2many etc., proper _name/_description, and decorators like @api.model, @api.depends, @api.constrains, @api.onchange where appropriate.
- Do NOT produce any HTTP controllers or routes. Never use @http.route, werkzeug request routing, Flask/Django/FastAPI decorators, or any URL/endpoint definitions. This is business/model logic only, meant to be called from views, other models, server actions, or automated actions.
- If the input contains JavaScript, do not transliterate JS syntax literally. Reinterpret the underlying business logic/behavior and re-express it as Odoo Python (e.g. frontend validation becomes an @api.constrains method, a computed display value becomes an @api.depends compute method, an event handler's side effect becomes a model method).
- Preserve the original intent, field names (snake_cased per Odoo convention), and behavior as closely as possible.
- Use idiomatic, clean, PEP8-compliant Python with concise docstrings/comments only where they add real value.
- If the input is already fairly close to Odoo style, refine rather than rewrite it wholesale.

Respond with ONLY a single JSON object, no markdown code fences, no preamble, no trailing text. Shape exactly:
{"convertedCode": "the converted Odoo Python code as a single string with \\n newlines", "notes": "2-5 short bullet-style sentences (as one string, separated by \\n) explaining key conversion decisions", "detectedLanguage": "python" | "javascript" | "mixed"}`;

const CHUNK_SYSTEM_PROMPT = SYSTEM_PROMPT + `

Important: the text you receive is ONE CHUNK of a larger source file that is being converted piece by piece. Convert only this chunk. Keep naming, style, and Odoo conventions consistent with what a rest-of-file conversion would look like (snake_case fields, standard decorators). Do not invent a wrapping model class if the chunk is clearly a fragment (e.g. just a couple of standalone functions) — convert it as standalone Odoo-style methods/helpers instead in that case. Keep "notes" very short (1 sentence) since this repeats per chunk.`;

const EXAMPLE = `class Order:
    def __init__(self, customer_name, items):
        self.customer_name = customer_name
        self.items = items
        self.status = "draft"

    def total(self):
        return sum(item["price"] * item["qty"] for item in self.items)

    def confirm(self):
        if not self.items:
            raise ValueError("Cannot confirm an empty order")
        self.status = "confirmed"
        return self.status
`;

function lineChunk(lines, maxChunkLines) {
  const out = [];
  for (let i = 0; i < lines.length; i += maxChunkLines) {
    out.push(lines.slice(i, i + maxChunkLines).join("\n"));
  }
  return out;
}

function chunkSource(source, maxChunkLines) {
  const lines = source.split("\n");
  const starts = [];
  const topLevelRe = /^(class\s|def\s|function\s|async function\s|export\s|export default\s)/;
  for (let i = 0; i < lines.length; i++) {
    if (topLevelRe.test(lines[i])) {
      let s = i;
      while (s > 0 && /^@/.test(lines[s - 1])) s--;
      starts.push(s);
    }
  }

  let blocks;
  if (starts.length === 0) {
    blocks = lineChunk(lines, maxChunkLines);
  } else {
    blocks = [];
    if (starts[0] > 0) blocks.push(lines.slice(0, starts[0]).join("\n"));
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1] : lines.length;
      blocks.push(lines.slice(s, e).join("\n"));
    }
  }

  const merged = [];
  let buffer = "";
  for (const b of blocks) {
    const bLineCount = b.split("\n").length;
    if (bLineCount > maxChunkLines) {
      if (buffer) {
        merged.push(buffer);
        buffer = "";
      }
      merged.push(...lineChunk(b.split("\n"), maxChunkLines));
      continue;
    }
    const bufferLineCount = buffer ? buffer.split("\n").length : 0;
    if (buffer && bufferLineCount + bLineCount > maxChunkLines) {
      merged.push(buffer);
      buffer = b;
    } else {
      buffer = buffer ? buffer + "\n" + b : b;
    }
  }
  if (buffer) merged.push(buffer);
  return merged.filter((b) => b.trim().length > 0);
}

async function callClaude(systemPrompt, userContent, maxTokens) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

export default function OdooCodeBridge() {
  const [source, setSource] = useState("");
  const [langHint, setLangHint] = useState("auto");
  const [output, setOutput] = useState("");
  const [notes, setNotes] = useState("");
  const [detected, setDetected] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileInputRef = useRef(null);

  const lineCount = source ? source.split("\n").length : 0;
  const willChunk = lineCount > CHUNK_LINE_THRESHOLD;
  const estimatedChunks = willChunk ? Math.ceil(lineCount / MAX_LINES_PER_CHUNK) : 1;

  const handleFileUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setSource(String(ev.target.result || ""));
      setOutput("");
      setNotes("");
      setError("");
      if (/\.jsx?$/.test(file.name)) setLangHint("javascript");
      else if (/\.py$/.test(file.name)) setLangHint("python");
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleConvert = async () => {
    if (!source.trim() || loading) return;
    setLoading(true);
    setError("");
    setOutput("");
    setNotes("");
    setDetected("");
    setProgress(null);

    try {
      if (!willChunk) {
        const parsed = await callClaude(
          SYSTEM_PROMPT,
          `Language hint: ${langHint}\n\nSource code to convert:\n\`\`\`\n${source}\n\`\`\``,
          11000
        );
        setOutput(parsed.convertedCode || "");
        setNotes(parsed.notes || "");
        setDetected(parsed.detectedLanguage || "");
      } else {
        const chunks = chunkSource(source, MAX_LINES_PER_CHUNK);
        setProgress({ current: 0, total: chunks.length });
        let combinedOutput = "";
        const noteLines = [];
        const detectedSet = new Set();

        for (let i = 0; i < chunks.length; i++) {
          setProgress({ current: i + 1, total: chunks.length });
          const parsed = await callClaude(
            CHUNK_SYSTEM_PROMPT,
            `Language hint: ${langHint}\nChunk ${i + 1} of ${chunks.length}.\n\nSource chunk:\n\`\`\`\n${chunks[i]}\n\`\`\``,
            4000
          );
          const code = parsed.convertedCode || "";
          combinedOutput += (i > 0 ? "\n\n" : "") + `# ---- chunk ${i + 1}/${chunks.length} ----\n` + code;
          if (parsed.notes) noteLines.push(`Chunk ${i + 1}: ${parsed.notes}`);
          if (parsed.detectedLanguage) detectedSet.add(parsed.detectedLanguage);
          setOutput(combinedOutput);
        }
        setNotes(noteLines.join("\n"));
        setDetected(Array.from(detectedSet).join(", "));
      }
    } catch (e) {
      setError("Conversion failed partway through. The model may have returned an unexpected format — try again, or convert a smaller portion.");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError("Couldn't copy to clipboard.");
    }
  };

  const loadExample = () => {
    setSource(EXAMPLE);
    setLangHint("python");
    setOutput("");
    setNotes("");
    setError("");
  };

  const langOptions = [
    { key: "auto", label: "Auto" },
    { key: "python", label: "Python" },
    { key: "javascript", label: "JavaScript" },
  ];

  return (
    <div
      style={{
        fontFamily: "'Space Grotesk', sans-serif",
        background: COLORS.bg,
        color: COLORS.text,
        minHeight: "100vh",
        padding: "40px 32px",
      }}
    >
      <style>{FONT_IMPORT}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto 32px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            letterSpacing: "0.14em",
            color: COLORS.purpleGlow,
            fontWeight: 600,
            marginBottom: 10,
          }}
        >
          <Cog size={14} strokeWidth={2.2} />
          ODOO CODE BRIDGE
        </div>
        <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" }}>
          Backend code, refactored for the Odoo ORM
        </h1>
        <p style={{ color: COLORS.textMuted, fontSize: 14, marginTop: 8, maxWidth: 640, lineHeight: 1.6 }}>
          Paste or upload Python/JavaScript backend logic. Large files are split into chunks and converted
          one at a time automatically. Output is Odoo model code only — no controllers, no routes.
        </p>
      </div>

      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto 8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}
        >
          {langOptions.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setLangHint(opt.key)}
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 12,
                fontWeight: 500,
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                background: langHint === opt.key ? COLORS.purpleDeep : "transparent",
                color: langHint === opt.key ? "#fff" : COLORS.textMuted,
                transition: "background 0.15s ease",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".py,.js,.jsx,.ts,.txt"
            onChange={handleFileUpload}
            style={{ display: "none" }}
          />
          <button
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 12,
              fontWeight: 500,
              color: COLORS.textMuted,
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              padding: "8px 14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Upload size={13} />
            Upload file
          </button>
          <button
            onClick={loadExample}
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 12,
              fontWeight: 500,
              color: COLORS.textMuted,
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              padding: "8px 14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <FileCode2 size={13} />
            Load example
          </button>
        </div>
      </div>

      {willChunk && (
        <div style={{ maxWidth: 1180, margin: "0 auto 16px", fontSize: 12, color: COLORS.gold }}>
          {lineCount.toLocaleString()} lines detected — will auto-split into ~{estimatedChunks} chunks and convert
          sequentially.
        </div>
      )}
      {!willChunk && <div style={{ maxWidth: 1180, margin: "0 auto 16px" }} />}

      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "1fr 56px 1fr",
          gap: 0,
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            minHeight: 440,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: COLORS.panelHead,
              borderBottom: `1px solid ${COLORS.border}`,
              padding: "10px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textMuted, letterSpacing: "0.04em" }}>
              YOUR CODE
            </span>
            <span style={{ fontSize: 11, color: COLORS.textMuted }}>{lineCount.toLocaleString()} lines</span>
          </div>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={"# Paste code or use \"Upload file\" for large files...\n\nclass Invoice:\n    def __init__(self, amount):\n        self.amount = amount"}
            spellCheck={false}
            style={{
              flex: 1,
              width: "100%",
              background: "transparent",
              color: COLORS.text,
              border: "none",
              outline: "none",
              resize: "none",
              padding: 16,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12.5,
              lineHeight: 1.65,
              boxSizing: "border-box",
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          <button
            onClick={handleConvert}
            disabled={loading || !source.trim()}
            title="Convert to Odoo"
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: `1px solid ${COLORS.borderStrong}`,
              background: source.trim() ? COLORS.purpleDeep : COLORS.panel,
              color: "#fff",
              cursor: source.trim() && !loading ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              opacity: !source.trim() && !loading ? 0.5 : 1,
              transition: "background 0.15s ease",
            }}
          >
            {loading ? (
              <Loader2 size={20} style={{ animation: "spin 0.9s linear infinite" }} />
            ) : (
              <ArrowRight size={20} />
            )}
          </button>
          <style>{"@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }"}</style>
        </div>

        <div
          style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            minHeight: 440,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: COLORS.panelHead,
              borderBottom: `1px solid ${COLORS.border}`,
              padding: "10px 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.purpleGlow, letterSpacing: "0.04em" }}>
              ODOO PYTHON
            </span>
            {output && (
              <button
                onClick={handleCopy}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: copied ? COLORS.gold : COLORS.textMuted,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11,
                  fontFamily: "'Space Grotesk', sans-serif",
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 16, position: "relative" }}>
            {loading && (
              <div style={{ color: COLORS.textMuted, fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace", marginBottom: output ? 12 : 0 }}>
                {progress ? `Converting chunk ${progress.current} of ${progress.total}...` : "Converting to Odoo style..."}
              </div>
            )}
            {!loading && error && (
              <div style={{ display: "flex", gap: 8, color: COLORS.danger, fontSize: 12.5, alignItems: "flex-start" }}>
                <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{error}</span>
              </div>
            )}
            {!loading && !error && !output && (
              <div style={{ color: COLORS.textMuted, fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace" }}>
                Converted Odoo model code will appear here.
              </div>
            )}
            {output && (
              <pre
                style={{
                  margin: 0,
                  color: COLORS.text,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12.5,
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {output}
              </pre>
            )}
          </div>
        </div>
      </div>

      {notes && (
        <div
          style={{
            maxWidth: 1180,
            margin: "16px auto 0",
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            padding: "14px 18px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11,
              fontWeight: 600,
              color: COLORS.gold,
              letterSpacing: "0.06em",
              marginBottom: 8,
            }}
          >
            <Sparkles size={12} />
            CONVERSION NOTES {detected ? `· detected: ${detected}` : ""}
          </div>
          <div style={{ color: COLORS.textMuted, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-line" }}>
            {notes}
          </div>
        </div>
      )}
    </div>
  );
}
