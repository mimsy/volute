import { useState } from "react";
import { login, register, type AuthUser } from "../lib/auth";

export function LoginPage({
  onAuth,
}: {
  onAuth: (user: AuthUser) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingMessage, setPendingMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    setError("");
    setLoading(true);

    try {
      if (mode === "login") {
        const user = await login(username, password);
        if (user.role === "pending") {
          setPendingMessage("Your account is pending approval by an admin.");
        } else {
          onAuth(user);
        }
      } else {
        const user = await register(username, password);
        if (user.role === "admin") {
          // First user, auto-logged in
          onAuth(user);
        } else {
          setPendingMessage("Account created. Waiting for admin approval.");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
    setLoading(false);
  };

  if (pendingMessage) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ color: "var(--yellow)", marginBottom: 16 }}>
            {pendingMessage}
          </div>
          <button
            onClick={() => {
              setPendingMessage("");
              setMode("login");
            }}
            style={linkBtnStyle}
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ marginBottom: 24, textAlign: "center" as const }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
            <span style={{ color: "var(--accent)" }}>&gt;</span> molt
          </div>
          <div style={{ color: "var(--text-2)", fontSize: 12 }}>
            {mode === "login" ? "Sign in to continue" : "Create an account"}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={inputStyle}
            autoFocus
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ ...inputStyle, marginTop: 8 }}
          />
          {error && (
            <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !username.trim() || !password.trim()}
            style={{
              ...btnStyle,
              marginTop: 16,
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: "center" as const }}>
          <button
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            style={linkBtnStyle}
          >
            {mode === "login"
              ? "Need an account? Register"
              : "Have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  padding: 24,
};

const cardStyle: React.CSSProperties = {
  width: 320,
  padding: 32,
  background: "var(--bg-1)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-0)",
  fontFamily: "var(--mono)",
  fontSize: 13,
  outline: "none",
};

const btnStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 16px",
  background: "var(--accent-dim)",
  color: "var(--accent)",
  borderRadius: "var(--radius)",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "var(--mono)",
  border: "none",
  cursor: "pointer",
};

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--text-2)",
  fontSize: 12,
  fontFamily: "var(--mono)",
  border: "none",
  cursor: "pointer",
  padding: 0,
};
