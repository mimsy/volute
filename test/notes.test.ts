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
  getReactions,
  listNotes,
  resolveNoteId,
  toggleReaction,
} from "../src/lib/notes.js";
import {
  conversationParticipants,
  conversations,
  messages,
  noteComments,
  noteReactions,
  notes,
  sessions,
  users,
} from "../src/lib/schema.js";

async function cleanup() {
  const db = await getDb();
  await db.delete(noteReactions);
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

describe("note reactions", () => {
  let userId: number;
  let otherUserId: number;
  let username: string;
  let otherUsername: string;

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("reactor", "pass123");
    userId = user.id;
    username = user.username;
    const other = await createUser("reactor2", "pass123");
    otherUserId = other.id;
    otherUsername = other.username;
  });
  afterEach(cleanup);

  it("toggleReaction adds a reaction", async () => {
    const note = await createNote(userId, "React to me", "...");
    const result = await toggleReaction(note.id, userId, "❤️");
    assert.equal(result.added, true);

    const reactions = await getReactions(note.id);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].emoji, "❤️");
    assert.equal(reactions[0].count, 1);
    assert.deepEqual(reactions[0].usernames, [username]);
  });

  it("toggleReaction removes on second call", async () => {
    const note = await createNote(userId, "Toggle me", "...");
    await toggleReaction(note.id, userId, "🔥");
    const result = await toggleReaction(note.id, userId, "🔥");
    assert.equal(result.added, false);

    const reactions = await getReactions(note.id);
    assert.equal(reactions.length, 0);
  });

  it("multiple users can react with same emoji", async () => {
    const note = await createNote(userId, "Popular", "...");
    await toggleReaction(note.id, userId, "👍");
    await toggleReaction(note.id, otherUserId, "👍");

    const reactions = await getReactions(note.id);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].count, 2);
    assert.ok(reactions[0].usernames.includes(username));
    assert.ok(reactions[0].usernames.includes(otherUsername));
  });

  it("multiple emojis on same note", async () => {
    const note = await createNote(userId, "Multi react", "...");
    await toggleReaction(note.id, userId, "❤️");
    await toggleReaction(note.id, userId, "🤔");

    const reactions = await getReactions(note.id);
    assert.equal(reactions.length, 2);
  });

  it("listNotes includes reaction summary", async () => {
    const note = await createNote(userId, "With Reactions", "...");
    await toggleReaction(note.id, userId, "❤️");
    await toggleReaction(note.id, otherUserId, "❤️");
    await toggleReaction(note.id, userId, "🌱");

    const all = await listNotes();
    assert.ok(all[0].reactions);
    assert.ok(all[0].reactions!.length > 0);
    const heart = all[0].reactions!.find((r) => r.emoji === "❤️");
    assert.ok(heart);
    assert.equal(heart!.count, 2);
  });

  it("getNote includes full reactions", async () => {
    const note = await createNote(userId, "Full reactions", "...");
    await toggleReaction(note.id, userId, "🌊");

    const fetched = await getNote(username, note.slug);
    assert.ok(fetched);
    assert.ok(fetched.reactions);
    assert.equal(fetched.reactions!.length, 1);
    assert.equal(fetched.reactions![0].emoji, "🌊");
    assert.deepEqual(fetched.reactions![0].usernames, [username]);
  });

  it("deleting a note cascades reactions", async () => {
    const note = await createNote(userId, "Will delete", "...");
    await toggleReaction(note.id, userId, "❤️");
    await deleteNote(username, note.slug, userId);

    const reactions = await getReactions(note.id);
    assert.equal(reactions.length, 0);
  });
});

describe("note replies", () => {
  let userId: number;
  let username: string;

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("replier", "pass123");
    userId = user.id;
    username = user.username;
  });
  afterEach(cleanup);

  it("createNote with replyToId links to parent", async () => {
    const parent = await createNote(userId, "Original", "The original note");
    const reply = await createNote(userId, "My Reply", "Replying here", parent.id);
    assert.ok(reply.id !== parent.id);

    const fetched = await getNote(username, reply.slug);
    assert.ok(fetched);
    assert.ok(fetched.reply_to);
    assert.equal(fetched.reply_to!.slug, "original");
    assert.equal(fetched.reply_to!.title, "Original");
  });

  it("getNote includes replies list on parent", async () => {
    const parent = await createNote(userId, "Parent Note", "...");
    await createNote(userId, "Reply One", "First reply", parent.id);
    await createNote(userId, "Reply Two", "Second reply", parent.id);

    const fetched = await getNote(username, parent.slug);
    assert.ok(fetched);
    assert.ok(fetched.replies);
    assert.equal(fetched.replies.length, 2);
    assert.equal(fetched.replies[0].title, "Reply One");
    assert.equal(fetched.replies[1].title, "Reply Two");
  });

  it("listNotes includes reply_to summary", async () => {
    const parent = await createNote(userId, "Listed Parent", "...");
    await createNote(userId, "Listed Reply", "...", parent.id);

    const all = await listNotes();
    const reply = all.find((n) => n.title === "Listed Reply");
    assert.ok(reply);
    assert.ok(reply!.reply_to);
    assert.equal(reply!.reply_to!.slug, "listed-parent");
  });

  it("resolveNoteId resolves author/slug to id", async () => {
    const note = await createNote(userId, "Resolvable", "...");
    const id = await resolveNoteId(`${username}/${note.slug}`);
    assert.equal(id, note.id);
  });

  it("resolveNoteId returns null for nonexistent", async () => {
    const id = await resolveNoteId("nobody/nothing");
    assert.equal(id, null);
  });

  it("deleting parent sets reply_to to null", async () => {
    const parent = await createNote(userId, "To be deleted", "...");
    const reply = await createNote(userId, "Orphan reply", "...", parent.id);
    await deleteNote(username, parent.slug, userId);

    const fetched = await getNote(username, reply.slug);
    assert.ok(fetched);
    assert.equal(fetched.reply_to, null);
  });
});
