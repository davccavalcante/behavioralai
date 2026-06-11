# Privacy Notice: Behavioral AI

This notice describes what data `@takk/behavioralai` processes when you install
and run it. Behavioral AI is an npm library and CLI that runs entirely inside
your own process and infrastructure. The author (David C Cavalcante) hosts no
service, sees no traffic, and collects no telemetry.

Last updated: **2026-06-11**.

---

## 1. What Behavioral AI is, and isn't

Behavioral AI is a library you install and run in your own environment. There
is **no Behavioral AI cloud**, no account, no sign-up. The author does not host
any endpoint that your installation talks to. The only network traffic
Behavioral AI produces is the alert delivery **you** configured, to the
channels **you** chose, using the credentials **you** supplied.

---

## 2. Data Behavioral AI processes (in your process)

### 2.1 Turn observations (in memory)

You feed `observe()` per-turn measurements: latency, cost, token counts,
tool names and outcomes, finish reasons, error flags, and optional string
metadata. Behavioral AI never receives prompt text, completion text, retrieved
documents, or user content; the ingestion contract is numbers, category
labels, and identifiers you choose. What you put in `agentId`, tool names,
and `metadata` is under your control; do not encode personal data there.

### 2.2 Learned baselines (in memory by default)

The engine reduces observations to streaming statistics per agent: means,
variances, quantile markers, category frequencies, drift-state machines, and
a small recent window of numeric values per feature. Raw observations are
not retained beyond that window. Everything lives in process memory and
disappears with the process unless you opt into persistence.

### 2.3 Persisted baselines (only if you choose the `file` backend)

`fileState({ path })` writes the learned statistics to a local JSON file you
choose, with atomic writes. The snapshot contains aggregate statistics and
category labels (for example tool names), never credentials and never any
content of your traffic. Deleting the file deletes the learned profile;
there is no copy anywhere else.

### 2.4 Outbound alert traffic

When a drift, recovery, or forecast alert fires, Behavioral AI sends the alert
payload (title, message, severity, behavior score, attribution summaries,
your optional metadata) to the channels you configured: Slack, Discord,
PagerDuty, Microsoft Teams, Google Chat, Telegram, Notion, Google Sheets,
Google Docs, X, Reddit, a custom webhook, or SMTP email. Those deliveries go
directly from your process to the provider you configured, under that
provider's own privacy terms. Channel credentials stay in process memory and
are never logged or persisted by Behavioral AI.

---

## 3. Data Behavioral AI does NOT collect

- No telemetry, no usage analytics, no crash reporting to the author.
- No phone-home of any kind; zero requests to takk.ag or any author-owned
  host at runtime.
- No prompt or completion content, ever; the ingestion API has no field for
  it.
- No fingerprinting of your machine, environment, or users.

---

## 4. GDPR + LGPD posture

Behavioral AI is a self-hosted tool: you are the controller and the processor
of whatever data you route through it; the author processes nothing. The
engine is content-free by design, which makes data-minimization the default.
If you choose to place personal data inside `agentId` or `metadata`, you are
responsible for the lawful basis, retention, and deletion of the persisted
snapshot file.

---

## 5. Security disclosure

Security reports: see [SECURITY.md](./SECURITY.md). Do not open public issues
for vulnerabilities.

---

## 6. Children

Behavioral AI is developer infrastructure, not a consumer service, and is not
directed at children.

---

## 7. Changes to this notice

Changes ship with the package and are recorded in
[CHANGELOG.md](./CHANGELOG.md); the "Last updated" date above moves with
them.

---

## 8. Contact

**David C Cavalcante**
- Email: [davcavalcante@proton.me](mailto:davcavalcante@proton.me)
- LinkedIn: [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav)
- GitHub: [github.com/davccavalcante](https://github.com/davccavalcante)
- X: [x.com/davccavalcante](https://x.com/davccavalcante)
- Project site: [takk.ag](https://takk.ag)
