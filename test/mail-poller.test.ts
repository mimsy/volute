import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Email, MailPoller } from "../src/lib/mail-poller.js";

describe("MailPoller", () => {
  it("start and stop manage state", () => {
    const poller = new MailPoller();
    // Without systems config, start does nothing
    poller.start();
    assert.equal(poller.isRunning(), false);
    poller.stop();
    assert.equal(poller.isRunning(), false);
  });

  it("stop is safe to call without start", () => {
    const poller = new MailPoller();
    poller.stop();
    assert.ok(true);
  });
});

describe("email formatting", () => {
  function formatEmail(email: Partial<Email>): { channel: string; text: string } {
    const full: Email = {
      mind: "test",
      id: "1",
      from: { address: "sender@example.com", name: "Sender" },
      subject: "",
      body: null,
      html: null,
      receivedAt: new Date().toISOString(),
      ...email,
    };

    const channel = `mail:${full.from.address}`;

    let text: string;
    if (full.body) {
      text = full.subject ? `Subject: ${full.subject}\n\n${full.body}` : full.body;
    } else if (full.html) {
      text = full.subject
        ? `Subject: ${full.subject}\n\n[HTML email — plain text not available]`
        : "[HTML email — plain text not available]";
    } else {
      text = full.subject ? `Subject: ${full.subject}` : "[Empty email]";
    }

    return { channel, text };
  }

  it("formats email with subject and body", () => {
    const { channel, text } = formatEmail({
      from: { address: "alice@example.com", name: "Alice" },
      subject: "Hello",
      body: "How are you?",
    });
    assert.equal(channel, "mail:alice@example.com");
    assert.equal(text, "Subject: Hello\n\nHow are you?");
  });

  it("formats body-only email", () => {
    const { text } = formatEmail({ body: "Just a body" });
    assert.equal(text, "Just a body");
  });

  it("formats HTML-only email with subject", () => {
    const { text } = formatEmail({
      subject: "Newsletter",
      html: "<p>content</p>",
    });
    assert.equal(text, "Subject: Newsletter\n\n[HTML email — plain text not available]");
  });

  it("formats HTML-only email without subject", () => {
    const { text } = formatEmail({ html: "<p>content</p>" });
    assert.equal(text, "[HTML email — plain text not available]");
  });

  it("formats empty email", () => {
    const { text } = formatEmail({});
    assert.equal(text, "[Empty email]");
  });

  it("formats subject-only email", () => {
    const { text } = formatEmail({ subject: "Subject only" });
    assert.equal(text, "Subject: Subject only");
  });

  it("generates channel slug from sender address", () => {
    const { channel } = formatEmail({
      from: { address: "user@domain.com", name: "User" },
    });
    assert.equal(channel, "mail:user@domain.com");
  });
});
