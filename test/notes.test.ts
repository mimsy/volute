import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import {
  addComment,
  createNote,
  deleteComment,
  deleteNote,
  getComments,
  getNote,
  listNotes,
} from "../src/lib/notes.js";
import {
  conversationParticipants,
  conversations,
  messages,
  noteComments,
  notes,
  sessions,
  users,
} from "../src/lib/schema.js";

async function cleanup() {
  const db = await getDb();
  await db.delete(noteComments);
  await db.delete(notes);
  await db.delete(messages);
  await db.delete(conversationParticipants);
  await db.delete(sessions);
  await db.delete(conversations);
  await db.delete(users);
}

describe("notes", () => {
  let userId: number;
  let username: string;

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("writer", "pass123");
    userId = user.id;
    username = user.username;
  });
  afterEach(cleanup);

  it("createNote creates a note with slug", async () => {
    const note = await createNote(userId, "My First Note", "Hello world");
    assert.equal(note.title, "My First Note");
    assert.equal(note.slug, "my-first-note");
    assert.equal(note.content, "Hello world");
    assert.equal(note.author_username, username);
    assert.equal(note.comment_count, 0);
  });

  it("createNote handles slug collisions", async () => {
    const note1 = await createNote(userId, "Same Title", "Content 1");
    const note2 = await createNote(userId, "Same Title", "Content 2");
    assert.equal(note1.slug, "same-title");
    assert.equal(note2.slug, "same-title-2");
  });

  it("getNote returns note with comments", async () => {
    const created = await createNote(userId, "Test Note", "Content here");
    const note = await getNote(username, created.slug);
    assert.ok(note);
    assert.equal(note.title, "Test Note");
    assert.equal(note.content, "Content here");
    assert.deepEqual(note.comments, []);
  });

  it("getNote returns null for non-existent note", async () => {
    const note = await getNote(username, "nonexistent");
    assert.equal(note, null);
  });

  it("listNotes returns notes in reverse chronological order", async () => {
    await createNote(userId, "First", "A");
    await createNote(userId, "Second", "B");
    const all = await listNotes();
    assert.equal(all.length, 2);
    assert.equal(all[0].title, "Second");
    assert.equal(all[1].title, "First");
  });

  it("listNotes filters by author", async () => {
    const other = await createUser("other", "pass123");
    await createNote(userId, "Mine", "A");
    await createNote(other.id, "Theirs", "B");

    const mine = await listNotes({ authorUsername: username });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Mine");
  });

  it("deleteNote removes note", async () => {
    const note = await createNote(userId, "To Delete", "Bye");
    const deleted = await deleteNote(username, note.slug, userId);
    assert.ok(deleted);
    const check = await getNote(username, note.slug);
    assert.equal(check, null);
  });

  it("deleteNote rejects non-author", async () => {
    const other = await createUser("other2", "pass123");
    const note = await createNote(userId, "Protected", "No");
    const deleted = await deleteNote(username, note.slug, other.id);
    assert.equal(deleted, false);
  });

  it("addComment and getComments work", async () => {
    const note = await createNote(userId, "Commentable", "...");
    const comment = await addComment(note.id, userId, "Great note!");
    assert.equal(comment.content, "Great note!");
    assert.equal(comment.author_username, username);

    const comments = await getComments(note.id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].content, "Great note!");
  });

  it("deleteComment removes own comment", async () => {
    const note = await createNote(userId, "Note", "...");
    const comment = await addComment(note.id, userId, "My comment");
    const deleted = await deleteComment(comment.id, userId);
    assert.ok(deleted);
    const remaining = await getComments(note.id);
    assert.equal(remaining.length, 0);
  });

  it("deleteComment rejects non-author", async () => {
    const other = await createUser("other3", "pass123");
    const note = await createNote(userId, "Note2", "...");
    const comment = await addComment(note.id, userId, "My comment");
    const deleted = await deleteComment(comment.id, other.id);
    assert.equal(deleted, false);
  });

  it("listNotes includes comment counts", async () => {
    const note = await createNote(userId, "With Comments", "...");
    await addComment(note.id, userId, "Comment 1");
    await addComment(note.id, userId, "Comment 2");
    const all = await listNotes();
    assert.equal(all[0].comment_count, 2);
  });
});
