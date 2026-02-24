import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEmailContent, MailPoller } from "../src/lib/daemon/mail-poller.js";

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
  it("formats email with subject and body", () => {
    const text = formatEmailContent({ subject: "Hello", body: "How are you?", html: null });
    assert.equal(text, "Subject: Hello\n\nHow are you?");
  });

  it("formats body-only email", () => {
    const text = formatEmailContent({ subject: null, body: "Just a body", html: null });
    assert.equal(text, "Just a body");
  });

  it("formats HTML-only email with subject", () => {
    const text = formatEmailContent({ subject: "Newsletter", body: null, html: "<p>content</p>" });
    assert.equal(text, "Subject: Newsletter\n\n[HTML email — plain text not available]");
  });

  it("formats HTML-only email without subject", () => {
    const text = formatEmailContent({ subject: null, body: null, html: "<p>content</p>" });
    assert.equal(text, "[HTML email — plain text not available]");
  });

  it("formats empty email", () => {
    const text = formatEmailContent({ subject: null, body: null, html: null });
    assert.equal(text, "[Empty email]");
  });

  it("formats subject-only email", () => {
    const text = formatEmailContent({ subject: "Subject only", body: null, html: null });
    assert.equal(text, "Subject: Subject only");
  });
});
